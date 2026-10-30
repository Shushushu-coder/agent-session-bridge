import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { z } from 'zod';
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

const taskFileSchema = z.object({
  schemaVersion: z.literal(TASK_STORE_SCHEMA_VERSION),
  tasks: z.array(taskSchema),
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
  private order: string[] = [];
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

  async create(record: WorkerTask): Promise<void> {
    if (this.byId.has(record.taskId)) throw new DuplicateTaskError(record.taskId);
    if (this.byKey.has(record.requestKey)) throw new DuplicateRequestKeyError(record.requestKey);
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

function cloneTask(record: WorkerTask): WorkerTask {
  return {
    ...record,
    progress: record.progress.map((entry: TaskProgressEntry) => ({ ...entry })),
    usage: record.usage ? ({ ...record.usage } satisfies TaskUsage) : null,
    error: record.error ? ({ ...record.error } satisfies TaskErrorInfo) : null,
  };
}
