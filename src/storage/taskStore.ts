import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { BatchTaskInput, TaskBatch } from '../contracts/batch.js';
import {
  MAX_TASK_PROGRESS,
  type TaskErrorInfo,
  type TaskProgressEntry,
  type TaskStatus,
  type TaskUsage,
  type WorkerTask,
} from '../contracts/task.js';

export const TASK_STORE_SCHEMA_VERSION = 1;

const RECOVERY_MESSAGE =
  'MCP server restarted while this task was accepted or running. ' +
  'No terminal event was recorded, so the task was marked unknown and was not re-executed.';

const progressSchema = z.object({
  at: z.string().min(1),
  kind: z.string().min(1),
  summary: z.string(),
});

const usageSchema = z.object({
  input_tokens: z.number(),
  cached_input_tokens: z.number(),
  cache_write_input_tokens: z.number(),
  output_tokens: z.number(),
  reasoning_output_tokens: z.number(),
});

const errorSchema = z.object({
  category: z.string().min(1),
  message: z.string(),
});

const taskStatusSchema = z.enum(['accepted', 'running', 'completed', 'failed', 'unknown']);

const taskSchema = z.object({
  taskId: z.string().min(1),
  workerId: z.string().min(1),
  requestKey: z.string().min(1),
  requestFingerprint: z.string().min(1),
  status: taskStatusSchema,
  createdAt: z.string().min(1),
  startedAt: z.string().min(1).nullable(),
  updatedAt: z.string().min(1),
  completedAt: z.string().min(1).nullable(),
  nativeThreadId: z.string().min(1).nullable(),
  progress: z.array(progressSchema).max(MAX_TASK_PROGRESS),
  result: z.string().nullable(),
  usage: usageSchema.nullable(),
  error: errorSchema.nullable(),
});

const batchTaskEntrySchema = z.object({
  workerId: z.string().min(1),
  taskId: z.string().min(1).nullable(),
  dispatchStatus: z.enum(['accepted', 'rejected']),
  errorCategory: z.string().min(1).optional(),
  errorMessage: z.string().optional(),
});

const batchSchema = z.object({
  batchId: z.string().min(1),
  requestKey: z.string().min(1),
  requestFingerprint: z.string().min(1),
  createdAt: z.string().min(1),
  tasks: z.array(batchTaskEntrySchema),
});

const taskFileSchema = z.object({
  schemaVersion: z.literal(TASK_STORE_SCHEMA_VERSION),
  tasks: z.array(taskSchema),
  // Optional so files written before batches existed still load.
  batches: z.array(batchSchema).optional(),
});

export class TaskStoreCorruptedError extends Error {
  constructor(
    readonly filePath: string,
    reason: string,
  ) {
    super(`Task store at ${filePath} is corrupted: ${reason}`);
    this.name = 'TaskStoreCorruptedError';
  }
}

export class DuplicateTaskError extends Error {
  constructor(taskId: string) {
    super(`Task ${taskId} already exists in the task store`);
    this.name = 'DuplicateTaskError';
  }
}

export class DuplicateRequestKeyError extends Error {
  constructor(requestKey: string) {
    super(`requestKey ${requestKey} is already stored`);
    this.name = 'DuplicateRequestKeyError';
  }
}

export class DuplicateBatchError extends Error {
  constructor(batchId: string) {
    super(`Batch ${batchId} already exists in the task store`);
    this.name = 'DuplicateBatchError';
  }
}

export interface TaskUpdateOptions {
  /** Apply the patch only while the stored status is one of these. */
  ifStatus?: readonly TaskStatus[];
}

export type TaskPatch = Partial<
  Pick<
    WorkerTask,
    | 'status'
    | 'startedAt'
    | 'updatedAt'
    | 'completedAt'
    | 'nativeThreadId'
    | 'progress'
    | 'result'
    | 'usage'
    | 'error'
  >
>;

/**
 * Persists asynchronous worker tasks in their own JSON file, separate from
 * the worker registry.
 *
 * Writes are atomic (temp file + rename) and serialized in-process.
 * A missing file is an empty store. Invalid JSON or a schema mismatch throws
 * {@link TaskStoreCorruptedError} and leaves the file untouched.
 * Tasks still `accepted` or `running` on open have no reliable terminal
 * event, so they become `unknown` and are not eligible for automatic retry.
 */
export class TaskStore {
  private readonly byId = new Map<string, WorkerTask>();
  private readonly byKey = new Map<string, string>();
  private readonly batchesById = new Map<string, TaskBatch>();
  private readonly batchesByKey = new Map<string, string>();
  private order: string[] = [];
  private batchOrder: string[] = [];
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(readonly filePath: string) {}

  static async open(filePath: string): Promise<TaskStore> {
    const store = new TaskStore(filePath);
    if (!existsSync(filePath)) return store;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      throw new TaskStoreCorruptedError(
        filePath,
        `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const result = taskFileSchema.safeParse(parsed);
    if (!result.success) {
      throw new TaskStoreCorruptedError(filePath, `schema mismatch: ${result.error.message}`);
    }

    const now = new Date().toISOString();
    let recovered = false;
    for (const record of result.data.tasks) {
      if (store.byId.has(record.taskId)) {
        throw new TaskStoreCorruptedError(filePath, `duplicate taskId ${record.taskId}`);
      }
      if (store.byKey.has(record.requestKey)) {
        throw new TaskStoreCorruptedError(filePath, `duplicate requestKey ${record.requestKey}`);
      }
      const task = cloneTask(record);
      if (task.status === 'accepted' || task.status === 'running') {
        recovered = true;
        task.status = 'unknown';
        task.updatedAt = now;
        task.completedAt = task.completedAt ?? now;
        task.error = task.error ?? { category: 'interrupted', message: RECOVERY_MESSAGE };
      }
      store.byId.set(task.taskId, task);
      store.byKey.set(task.requestKey, task.taskId);
      store.order.push(task.taskId);
    }
    for (const record of result.data.batches ?? []) {
      if (store.batchesById.has(record.batchId)) {
        throw new TaskStoreCorruptedError(filePath, `duplicate batchId ${record.batchId}`);
      }
      if (store.batchesByKey.has(record.requestKey) || store.byKey.has(record.requestKey)) {
        throw new TaskStoreCorruptedError(filePath, `duplicate requestKey ${record.requestKey}`);
      }
      for (const member of record.tasks) {
        if (member.taskId !== null && !store.byId.has(member.taskId)) {
          throw new TaskStoreCorruptedError(
            filePath,
            `batch ${record.batchId} references unknown task ${member.taskId}`,
          );
        }
      }
      const batch = cloneBatch(record);
      store.batchesById.set(batch.batchId, batch);
      store.batchesByKey.set(batch.requestKey, batch.batchId);
      store.batchOrder.push(batch.batchId);
    }
    if (recovered) await store.persist();
    return store;
  }

  list(): WorkerTask[] {
    return this.order.map((id) => cloneTask(this.byId.get(id)!));
  }

  get(taskId: string): WorkerTask | undefined {
    const record = this.byId.get(taskId);
    return record ? cloneTask(record) : undefined;
  }

  getByRequestKey(requestKey: string): WorkerTask | undefined {
    const taskId = this.byKey.get(requestKey);
    if (!taskId) return undefined;
    return this.get(taskId);
  }

  getBatch(batchId: string): TaskBatch | undefined {
    const record = this.batchesById.get(batchId);
    return record ? cloneBatch(record) : undefined;
  }

  getBatchByRequestKey(requestKey: string): TaskBatch | undefined {
    const batchId = this.batchesByKey.get(requestKey);
    if (!batchId) return undefined;
    return this.getBatch(batchId);
  }

  /** True when any task or batch already claims this requestKey. */
  hasRequestKey(requestKey: string): boolean {
    return this.byKey.has(requestKey) || this.batchesByKey.has(requestKey);
  }

  listBatches(): TaskBatch[] {
    return this.batchOrder.map((id) => cloneBatch(this.batchesById.get(id)!));
  }

  async create(record: WorkerTask): Promise<void> {
    if (this.byId.has(record.taskId)) throw new DuplicateTaskError(record.taskId);
    if (this.hasRequestKey(record.requestKey)) {
      throw new DuplicateRequestKeyError(record.requestKey);
    }
    if (record.progress.length > MAX_TASK_PROGRESS) {
      throw new Error(`Task ${record.taskId} progress exceeds ${MAX_TASK_PROGRESS} entries`);
    }
    this.byId.set(record.taskId, cloneTask(record));
    this.byKey.set(record.requestKey, record.taskId);
    this.order.push(record.taskId);
    try {
      await this.persist();
    } catch (error) {
      this.byId.delete(record.taskId);
      this.byKey.delete(record.requestKey);
      this.order.pop();
      throw error;
    }
  }

  /**
   * Merge `patch` into a task. When `ifStatus` is set and the current status
   * is outside that set, the store is left unchanged (the caller lost the race
   * with shutdown or recovery).
   */
  async update(
    taskId: string,
    patch: TaskPatch,
    options: TaskUpdateOptions = {},
  ): Promise<WorkerTask> {
    const current = this.byId.get(taskId);
    if (!current) throw new Error(`Cannot update unknown task ${taskId}`);
    if (options.ifStatus && !options.ifStatus.includes(current.status)) {
      return cloneTask(current);
    }
    const progress = patch.progress ?? current.progress;
    if (progress.length > MAX_TASK_PROGRESS) {
      throw new Error(`Task ${taskId} progress exceeds ${MAX_TASK_PROGRESS} entries`);
    }
    const next: WorkerTask = {
      ...current,
      ...patch,
      taskId: current.taskId,
      workerId: current.workerId,
      requestKey: current.requestKey,
      requestFingerprint: current.requestFingerprint,
      createdAt: current.createdAt,
      progress: progress.map((entry) => ({ ...entry })),
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    this.byId.set(taskId, next);
    await this.persist();
    return cloneTask(next);
  }

  /**
   * Persist one batch record. Batches are immutable — there is no update:
   * the recorded accepted/rejected mapping is the dispatch-time truth.
   * The requestKey must be free across both tasks and batches.
   */
  async createBatch(record: TaskBatch): Promise<void> {
    if (this.batchesById.has(record.batchId)) throw new DuplicateBatchError(record.batchId);
    if (this.hasRequestKey(record.requestKey)) {
      throw new DuplicateRequestKeyError(record.requestKey);
    }
    this.batchesById.set(record.batchId, cloneBatch(record));
    this.batchesByKey.set(record.requestKey, record.batchId);
    this.batchOrder.push(record.batchId);
    try {
      await this.persist();
    } catch (error) {
      this.batchesById.delete(record.batchId);
      this.batchesByKey.delete(record.requestKey);
      this.batchOrder.pop();
      throw error;
    }
  }

  private persist(): Promise<void> {
    const write = this.writeChain.then(() => this.writeNow());
    this.writeChain = write.catch(() => {});
    return write;
  }

  private async writeNow(): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    const payload = {
      schemaVersion: TASK_STORE_SCHEMA_VERSION,
      tasks: this.list(),
      batches: this.listBatches(),
    };
    try {
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await rename(tmp, this.filePath);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }
}

export function requestFingerprint(workerId: string, message: string): string {
  return createHash('sha256').update(workerId).update('\0').update(message).digest('hex');
}

/**
 * Fingerprint of a whole batch request over its ordered [workerId, message]
 * pairs. Reordered or changed content is a different request; the prompts
 * themselves are never stored.
 */
export function batchFingerprint(tasks: readonly BatchTaskInput[]): string {
  const canonical = tasks.map((task) => [task.workerId, task.message]);
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function cloneTask(record: WorkerTask): WorkerTask {
  return {
    ...record,
    progress: record.progress.map((entry: TaskProgressEntry) => ({ ...entry })),
    usage: record.usage ? ({ ...record.usage } satisfies TaskUsage) : null,
    error: record.error ? ({ ...record.error } satisfies TaskErrorInfo) : null,
  };
}

function cloneBatch(record: TaskBatch): TaskBatch {
  return { ...record, tasks: record.tasks.map((entry) => ({ ...entry })) };
}
