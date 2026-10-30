import { randomBytes, randomUUID } from 'node:crypto';
import type { AgentRuntimeAdapter, RuntimeStreamEvent } from '../contracts/runtime.js';
import type {
  AgentTask,
  TaskErrorInfo,
  TaskProgressEntry,
  TaskStatus,
  TaskUsage,
  WorkerTask,
} from '../contracts/task.js';
import { MAX_TASK_PROGRESS } from '../contracts/task.js';
import type {
  SendMessageResult,
  WorkerRecord,
  WorkerView,
  WorkerViewState,
} from '../contracts/worker.js';
import { CodexAdapterError } from '../runtime/codex/codexRuntimeAdapter.js';
import { redactSensitive } from '../storage/redact.js';
import type { SessionRegistry } from '../storage/sessionRegistry.js';
import {
  DuplicateRequestKeyError,
  requestFingerprint,
  type TaskPatch,
  type TaskStore,
} from '../storage/taskStore.js';
import { verifyGitWorkspace, type WorkspaceVerifier } from './workspaceVerifier.js';

export type WorkerErrorCode =
  | 'WORKER_NOT_FOUND'
  | 'INVALID_WORKSPACE'
  | 'STATE_BLOCKED'
  | 'RUNTIME_UNAVAILABLE'
  | 'WORKER_BUSY'
  | 'REQUEST_KEY_CONFLICT'
  | 'TASK_NOT_FOUND'
  | 'INTERNAL';

/** Call-level rejection; the server layer renders these as `isError` results. */
export class WorkerToolError extends Error {
  constructor(
    readonly code: WorkerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'WorkerToolError';
  }
}

export interface CreateWorkerInput {
  name: string;
  workspacePath: string;
  model?: string;
}

export interface WorkerManagerOptions {
  registry: SessionRegistry;
  taskStore: TaskStore;
  adapter: AgentRuntimeAdapter;
  verifyWorkspace?: WorkspaceVerifier;
  idGenerator?: () => string;
}

export interface DispatchTaskResult {
  taskId: string;
  workerId: string;
  status: TaskStatus;
  /** True when requestKey matched an existing task and nothing new was started. */
  replayed: boolean;
}

export type TaskAssociation = 'confirmed' | 'unconfirmed' | 'unavailable';

export interface TaskStatusView {
  taskId: string;
  workerId: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  nativeThreadId: string | null;
  progress: TaskProgressEntry[];
  errorCategory: string | null;
  errorMessage: string | null;
  association: TaskAssociation;
  associationDetail: string | null;
}

export interface TaskResultView {
  taskId: string;
  workerId: string;
  status: 'completed' | 'failed' | 'unknown' | 'NOT_READY';
  nativeThreadId: string | null;
  response: string | null;
  usage: TaskUsage | null;
  completedAt: string | null;
  error: TaskErrorInfo | null;
  message: string | null;
  association: TaskAssociation;
  associationDetail: string | null;
}

const LIVE_TASK: readonly TaskStatus[] = ['accepted', 'running'];

/**
 * Orchestrates managed workers: registry persistence, workspace validation,
 * busy tracking, and first-turn vs resume dispatch through the runtime
 * adapter. Synchronous sends and asynchronous tasks share one in-memory
 * busy set so a worker never runs two turns at once.
 */
export class WorkerManager {
  private readonly busy = new Set<string>();
  /** workerId → live adapter session id (memory only). */
  private readonly sessions = new Map<string, string>();
  /** taskId values whose outcome must not be overwritten after shutdown. */
  private readonly abandoned = new Set<string>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly verifyWorkspace: WorkspaceVerifier;
  private readonly idGenerator: () => string;
  private readonly taskStore: TaskStore;

  constructor(private readonly options: WorkerManagerOptions) {
    this.verifyWorkspace = options.verifyWorkspace ?? verifyGitWorkspace;
    this.idGenerator = options.idGenerator ?? defaultWorkerId;
    this.taskStore = options.taskStore;
  }

  async createWorker(input: CreateWorkerInput): Promise<WorkerView> {
    const check = await this.verifyWorkspace(input.workspacePath);
    if (!check.ok || !check.resolvedPath) {
      throw new WorkerToolError(
        'INVALID_WORKSPACE',
        `cannot register worker "${input.name}": ${check.error ?? 'workspace check failed'}`,
      );
    }
    const now = new Date().toISOString();
    const record: WorkerRecord = {
      workerId: this.idGenerator(),
      name: input.name,
      runtime: 'codex',
      threadId: null,
      workspacePath: check.resolvedPath,
      ...(input.model ? { model: input.model } : {}),
      state: 'pending_initialization',
      createdAt: now,
      updatedAt: now,
    };
    await this.options.registry.add(record);
    return this.viewOf(record);
  }

  listWorkers(): WorkerView[] {
    return this.options.registry.list().map((record) => this.viewOf(record));
  }

  getWorker(workerId: string): WorkerView {
    const record = this.options.registry.get(workerId);
    if (!record) {
      throw new WorkerToolError('WORKER_NOT_FOUND', `no worker with id ${workerId}`);
    }
    return this.viewOf(record);
  }

  async sendMessage(workerId: string, message: string): Promise<SendMessageResult> {
    const record = this.requireWorkerRecord(workerId);
    const base = { workerId, threadId: record.threadId };
    this.assertRunnable(record);
    this.assertThreadAssociation(workerId);

    let acquired = false;
    try {
      if (!this.tryAcquire(workerId)) {
        return {
          ...base,
          status: 'busy',
          state: 'busy',
          error: 'worker is already running a turn',
        };
      }
      acquired = true;

      const check = await this.verifyWorkspace(record.workspacePath);
      if (!check.ok) {
        throw new WorkerToolError(
          'INVALID_WORKSPACE',
          `workspace for worker ${workerId} is no longer valid: ${check.error ?? 'check failed'}`,
        );
      }

      // Persist the in-flight marker BEFORE the first turn: if the process
      // dies mid-turn, the record reloads as initialization_uncertain rather
      // than silently starting a second first turn later.
      let working = record;
      if (record.threadId === null && record.state === 'pending_initialization') {
        working = await this.options.registry.update(workerId, { state: 'initializing' });
      }

      const sessionId = await this.ensureSession(
        working,
        check.resolvedPath ?? record.workspacePath,
      );
      const task: AgentTask = {
        id: `task_${randomUUID()}`,
        sessionId,
        prompt: message,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      const result = await this.options.adapter.runTask(sessionId, task);

      const patch = this.patchForResult(working, result);
      const updated = await this.options.registry.update(workerId, patch);
      const succeeded = result.status === 'succeeded';
      return {
        workerId,
        status: succeeded ? 'completed' : 'failed',
        // Persisted post-turn state — the busy flag is still held here and
        // must not leak into the result.
        state: updated.state,
        threadId: updated.threadId,
        ...(result.output !== undefined ? { response: result.output } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
      };
    } catch (error) {
      if (error instanceof CodexAdapterError && error.code === 'SESSION_BUSY') {
        return { ...base, status: 'busy', state: 'busy', error: error.message };
      }
      if (error instanceof WorkerToolError) throw error;
      throw new WorkerToolError(
        'INTERNAL',
        `send_worker_message failed for ${workerId}: ${redactSensitive(error instanceof Error ? error.message : String(error))}`,
      );
    } finally {
      if (acquired) this.busy.delete(workerId);
    }
  }

  /**
   * Accept one asynchronous turn and return as soon as the task record is
   * durable. The model stream runs afterward in this process.
   */
  async dispatchTask(
    workerId: string,
    message: string,
    requestKey: string,
  ): Promise<DispatchTaskResult> {
    const replay = this.resolveReplay(workerId, message, requestKey);
    if (replay.kind === 'conflict') throw this.conflictError(requestKey);
    if (replay.kind === 'replay') return replay.view;

    const record = this.requireWorkerRecord(workerId);
    this.assertRunnable(record);
    this.assertThreadAssociation(workerId);

    let acquired = false;
    let handedOff = false;
    try {
      if (!this.tryAcquire(workerId)) {
        throw new WorkerToolError(
          'WORKER_BUSY',
          `worker ${workerId} is already running a turn`,
        );
      }
      acquired = true;

      const check = await this.verifyWorkspace(record.workspacePath);
      if (!check.ok) {
        throw new WorkerToolError(
          'INVALID_WORKSPACE',
          `workspace for worker ${workerId} is no longer valid: ${check.error ?? 'check failed'}`,
        );
      }

      const again = this.resolveReplay(workerId, message, requestKey);
      if (again.kind === 'conflict') throw this.conflictError(requestKey);
      if (again.kind === 'replay') return again.view;

      const now = new Date().toISOString();
      const task: WorkerTask = {
        taskId: defaultTaskId(),
        workerId,
        requestKey,
        requestFingerprint: requestFingerprint(workerId, message),
        status: 'accepted',
        createdAt: now,
        startedAt: null,
        updatedAt: now,
        completedAt: null,
        nativeThreadId: null,
        progress: [],
        result: null,
        usage: null,
        error: null,
      };
      try {
        await this.taskStore.create(task);
      } catch (error) {
        if (error instanceof DuplicateRequestKeyError) {
          const raced = this.resolveReplay(workerId, message, requestKey);
          if (raced.kind === 'replay') return raced.view;
          throw this.conflictError(requestKey);
        }
        throw error;
      }

      this.schedule(task, message);
      handedOff = true;
      return { taskId: task.taskId, workerId, status: 'accepted', replayed: false };
    } catch (error) {
      if (error instanceof WorkerToolError) throw error;
      throw new WorkerToolError(
        'INTERNAL',
        `dispatch_worker_task failed for ${workerId}: ${redactSensitive(error instanceof Error ? error.message : String(error))}`,
      );
    } finally {
      if (acquired && !handedOff) this.busy.delete(workerId);
    }
  }

  getTaskStatus(taskId: string): TaskStatusView {
    const task = this.requireTask(taskId);
    return {
      taskId: task.taskId,
      workerId: task.workerId,
      status: task.status,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      startedAt: task.startedAt,
      completedAt: task.completedAt,
      nativeThreadId: task.nativeThreadId,
      progress: task.progress.map((entry) => ({ ...entry })),
      errorCategory: task.error?.category ?? null,
      errorMessage: task.error?.message ?? null,
      ...this.associationOf(task),
    };
  }

  getTaskResult(taskId: string): TaskResultView {
    const task = this.requireTask(taskId);
    const association = this.associationOf(task);
    const base = {
      taskId: task.taskId,
      workerId: task.workerId,
      nativeThreadId: task.nativeThreadId,
      ...association,
    };
    if (task.status === 'accepted' || task.status === 'running') {
      return {
        ...base,
        status: 'NOT_READY',
        response: null,
        usage: null,
        completedAt: null,
        error: null,
        message: 'Task is not finished. Acceptance does not mean the worker turn succeeded.',
      };
    }
    if (task.status === 'completed') {
      return {
        ...base,
        status: 'completed',
        response: task.result ?? '',
        usage: task.usage ? { ...task.usage } : null,
        completedAt: task.completedAt,
        error: null,
        message: null,
      };
    }
    const error = task.error ?? {
      category: task.status === 'failed' ? 'failed' : 'uncertain',
      message: task.status === 'failed' ? 'task failed' : 'task outcome is unknown and was not re-executed',
    };
    return {
      ...base,
      status: task.status,
      response: null,
      usage: null,
      completedAt: task.completedAt,
      error: { ...error },
      message: error.message,
    };
  }

  /** Resolves when the in-process executor for `taskId` has settled. */
  whenTaskSettled(taskId: string): Promise<void> {
    return this.inflight.get(taskId) ?? Promise.resolve();
  }

  /**
   * Mark accepted/running tasks unknown. Used when stdin closes or the
   * process is signalled. Does not start a replacement turn.
   */
  async abandonInFlight(reason: string): Promise<void> {
    const message = redactSensitive(reason);
    for (const task of this.taskStore.list()) {
      if (task.status !== 'accepted' && task.status !== 'running') continue;
      this.abandoned.add(task.taskId);
      await this.taskStore.update(
        task.taskId,
        {
          status: 'unknown',
          completedAt: new Date().toISOString(),
          error: { category: 'interrupted', message },
        },
        { ifStatus: LIVE_TASK },
      );
      await this.markWorkerInterrupted(task.workerId);
    }
  }

  private schedule(task: WorkerTask, message: string): void {
    const tracked = new Promise<void>((resolve) => {
      setTimeout(() => {
        void this.execute(task, message).then(
          () => resolve(),
          () => resolve(),
        );
      }, 0);
    }).finally(() => {
      this.busy.delete(task.workerId);
      this.inflight.delete(task.taskId);
    });
    this.inflight.set(task.taskId, tracked);
  }

  private async execute(task: WorkerTask, message: string): Promise<void> {
    try {
      await this.runBody(task, message);
    } catch (error) {
      try {
        if (this.abandoned.has(task.taskId)) return;
        const current = this.taskStore.get(task.taskId);
        if (
          !current ||
          current.status === 'completed' ||
          current.status === 'failed' ||
          current.status === 'unknown'
        ) {
          return;
        }
        await this.taskStore.update(
          task.taskId,
          {
            status: 'unknown',
            completedAt: new Date().toISOString(),
            error: {
              category: 'unhandled',
              message: redactSensitive(error instanceof Error ? error.message : String(error)),
            },
          },
          { ifStatus: LIVE_TASK },
        );
      } catch {
        // Background work must not become an unhandled rejection.
      }
    }
  }

  private async runBody(task: WorkerTask, message: string): Promise<void> {
    const initial = this.options.registry.get(task.workerId);
    if (!initial) {
      await this.writeTerminal(task.taskId, {
        status: 'failed',
        error: { category: 'dispatch_failed', message: 'worker disappeared before execution' },
      });
      return;
    }
    const firstTurn = initial.threadId === null;

    const running = await this.writeTask(task.taskId, {
      status: 'running',
      startedAt: new Date().toISOString(),
    });
    if (!running || running.status !== 'running') return;

    let workspacePath = initial.workspacePath;
    let sessionId: string;
    try {
      const check = await this.verifyWorkspace(initial.workspacePath);
      if (!check.ok) {
        throw new Error(check.error ?? 'workspace check failed');
      }
      workspacePath = check.resolvedPath ?? initial.workspacePath;
      if (this.shouldStop(task.taskId)) return;
      const latest = this.options.registry.get(task.workerId) ?? initial;
      sessionId = await this.ensureSession(latest, workspacePath);
    } catch (error) {
      // The runtime turn has not been started. Record a local failure and
      // leave the worker record unchanged so a later, explicit request can run.
      await this.writeTerminal(task.taskId, {
        status: 'failed',
        error: {
          category: 'dispatch_failed',
          message: redactSensitive(error instanceof Error ? error.message : String(error)),
        },
      });
      return;
    }

    if (this.shouldStop(task.taskId)) return;
    if (firstTurn) {
      const latest = this.options.registry.get(task.workerId);
      if (latest && (latest.state === 'pending_initialization' || latest.state === 'initializing')) {
        await this.options.registry.update(task.workerId, { state: 'initializing' });
      }
    }
    if (this.shouldStop(task.taskId)) return;

    let nativeThreadId = this.options.registry.get(task.workerId)?.threadId ?? null;
    let progress = this.taskStore.get(task.taskId)?.progress ?? [];
    let responseText: string | null = null;
    let usage: TaskUsage | null = null;
    let terminal: 'completed' | 'failed' | null = null;
    let failure: TaskErrorInfo | null = null;
    let runtimeInvoked = false;

    try {
      const agentTask: AgentTask = {
        id: task.taskId,
        sessionId,
        prompt: message,
        status: 'running',
        createdAt: task.createdAt,
      };
      runtimeInvoked = true;
      for await (const event of this.options.adapter.runTaskStreamed(sessionId, agentTask)) {
        if (this.shouldStop(task.taskId)) return;
        const step = this.consumeEvent(event, progress, responseText, nativeThreadId, usage, terminal, failure);
        progress = step.progress;
        responseText = step.responseText;
        nativeThreadId = step.nativeThreadId;
        usage = step.usage;
        terminal = step.terminal;
        failure = step.failure;

        if (event.type === 'thread.started') {
          const kept = await this.writeTask(task.taskId, { nativeThreadId, progress });
          if (!kept || (kept.status !== 'running' && kept.status !== 'accepted')) return;
          const worker = this.options.registry.get(task.workerId);
          if (worker && worker.threadId !== event.threadId) {
            await this.options.registry.update(task.workerId, { threadId: event.threadId });
          }
        } else if (terminal) {
          const kept = await this.writeTask(task.taskId, { progress, nativeThreadId });
          if (!kept || (kept.status !== 'running' && kept.status !== 'accepted')) return;
          break;
        } else {
          const kept = await this.writeTask(task.taskId, { progress, nativeThreadId });
          if (!kept || (kept.status !== 'running' && kept.status !== 'accepted')) return;
        }
      }
    } catch (error) {
      if (this.shouldStop(task.taskId)) return;
      const messageText = redactSensitive(error instanceof Error ? error.message : String(error));
      const notStarted =
        error instanceof CodexAdapterError &&
        (error.code === 'NOT_CONNECTED' ||
          error.code === 'SESSION_NOT_FOUND' ||
          error.code === 'SESSION_BUSY');
      if (terminal === null) {
        const status = runtimeInvoked && !notStarted ? 'unknown' : 'failed';
        const written = await this.writeTerminal(task.taskId, {
          status,
          nativeThreadId,
          progress,
          error: {
            category: status === 'unknown' ? 'uncertain' : 'dispatch_failed',
            message:
              status === 'unknown'
                ? `stream failed before a terminal event; task was not re-executed (${messageText})`
                : messageText,
          },
        });
        if (written?.status === 'unknown') {
          await this.applyAsyncOutcome(task.workerId, firstTurn, {
            status: 'unknown',
            error: written.error?.message,
            externalSessionId: nativeThreadId,
          });
        } else if (written?.status === 'failed' && notStarted && firstTurn) {
          const worker = this.options.registry.get(task.workerId);
          if (worker?.state === 'initializing' && !worker.threadId) {
            await this.options.registry.update(task.workerId, {
              state: 'pending_initialization',
              lastError: undefined,
            });
          }
        }
        return;
      }
    }

    if (this.shouldStop(task.taskId)) return;

    if (terminal === 'completed') {
      const written = await this.writeTerminal(task.taskId, {
        status: 'completed',
        nativeThreadId,
        progress,
        result: responseText ?? '',
        usage,
        error: null,
      });
      if (written?.status !== 'completed') return;
      await this.applyAsyncOutcome(task.workerId, firstTurn, {
        status: 'succeeded',
        externalSessionId: nativeThreadId,
      });
      return;
    }

    if (terminal === 'failed') {
      const error = failure ?? { category: 'turn_failed', message: 'turn failed' };
      const written = await this.writeTerminal(task.taskId, {
        status: 'failed',
        nativeThreadId,
        progress,
        result: null,
        error,
      });
      if (written?.status !== 'failed') return;
      await this.applyAsyncOutcome(task.workerId, firstTurn, {
        status: 'failed',
        error: error.message,
        externalSessionId: nativeThreadId,
      });
      return;
    }

    const written = await this.writeTerminal(task.taskId, {
      status: 'unknown',
      nativeThreadId,
      progress,
      error: {
        category: 'uncertain',
        message:
          'event stream ended without turn.completed or turn.failed; outcome is unknown and the task was not re-executed',
      },
    });
    if (written?.status !== 'unknown') return;
    await this.applyAsyncOutcome(task.workerId, firstTurn, {
      status: 'unknown',
      error: written.error?.message,
      externalSessionId: nativeThreadId,
    });
  }

  private consumeEvent(
    event: RuntimeStreamEvent,
    progress: TaskProgressEntry[],
    responseText: string | null,
    nativeThreadId: string | null,
    usage: TaskUsage | null,
    terminal: 'completed' | 'failed' | null,
    failure: TaskErrorInfo | null,
  ): {
    progress: TaskProgressEntry[];
    responseText: string | null;
    nativeThreadId: string | null;
    usage: TaskUsage | null;
    terminal: 'completed' | 'failed' | null;
    failure: TaskErrorInfo | null;
  } {
    switch (event.type) {
      case 'thread.started':
        return {
          progress: this.appendProgress(progress, 'thread.started', 'native thread started'),
          responseText,
          nativeThreadId: event.threadId,
          usage,
          terminal,
          failure,
        };
      case 'turn.started':
        return {
          progress: this.appendProgress(progress, 'turn.started', 'turn started'),
          responseText,
          nativeThreadId,
          usage,
          terminal,
          failure,
        };
      case 'item.started':
      case 'item.updated':
      case 'item.completed': {
        const text = event.type === 'item.completed' ? event.text : undefined;
        return {
          progress: this.appendProgress(
            progress,
            event.type,
            `item ${event.itemType}`,
            event.type === 'item.updated',
          ),
          responseText: text !== undefined ? text : responseText,
          nativeThreadId,
          usage,
          terminal,
          failure,
        };
      }
      case 'turn.completed':
        return {
          progress: this.appendProgress(progress, 'turn.completed', 'turn completed'),
          responseText,
          nativeThreadId,
          usage: event.usage,
          terminal: 'completed',
          failure,
        };
      case 'turn.failed':
        return {
          progress: this.appendProgress(progress, 'turn.failed', redactSensitive(event.message, 180)),
          responseText,
          nativeThreadId,
          usage,
          terminal: 'failed',
          failure: { category: 'turn_failed', message: redactSensitive(event.message) },
        };
      case 'error':
        return {
          progress: this.appendProgress(progress, 'error', redactSensitive(event.message, 180)),
          responseText,
          nativeThreadId,
          usage,
          terminal: 'failed',
          failure: { category: 'stream_error', message: redactSensitive(event.message) },
        };
      default:
        return { progress, responseText, nativeThreadId, usage, terminal, failure };
    }
  }

  private appendProgress(
    progress: TaskProgressEntry[],
    kind: string,
    summary: string,
    coalesce = false,
  ): TaskProgressEntry[] {
    const entry: TaskProgressEntry = {
      at: new Date().toISOString(),
      kind,
      summary: redactSensitive(summary, 180),
    };
    const next = progress.slice();
    if (coalesce && next.length > 0 && next[next.length - 1]?.kind === kind) {
      next[next.length - 1] = entry;
    } else {
      next.push(entry);
    }
    if (next.length > MAX_TASK_PROGRESS) return next.slice(next.length - MAX_TASK_PROGRESS);
    return next;
  }

  private shouldStop(taskId: string): boolean {
    if (this.abandoned.has(taskId)) return true;
    const current = this.taskStore.get(taskId);
    return !current || current.status === 'unknown' || current.status === 'completed' || current.status === 'failed';
  }

  private async writeTask(taskId: string, patch: TaskPatch): Promise<WorkerTask | undefined> {
    if (this.abandoned.has(taskId)) return this.taskStore.get(taskId);
    return this.taskStore.update(taskId, patch, { ifStatus: LIVE_TASK });
  }

  private async writeTerminal(
    taskId: string,
    patch: TaskPatch & { status: 'completed' | 'failed' | 'unknown' },
  ): Promise<WorkerTask | undefined> {
    return this.writeTask(taskId, {
      ...patch,
      completedAt: new Date().toISOString(),
    });
  }

  private async applyAsyncOutcome(
    workerId: string,
    firstTurn: boolean,
    result: {
      status: 'succeeded' | 'failed' | 'unknown';
      error?: string | undefined;
      externalSessionId?: string | null;
    },
  ): Promise<void> {
    const record = this.options.registry.get(workerId);
    if (!record) return;
    const captured = result.externalSessionId ?? null;
    const threadId = record.threadId ?? captured;
    const patch: Partial<WorkerRecord> = { updatedAt: new Date().toISOString() };
    if (threadId) patch.threadId = threadId;

    if (result.status === 'succeeded') {
      if (threadId) {
        patch.state = 'ready';
        patch.lastError = undefined;
      } else {
        patch.state = 'pending_initialization';
        patch.lastError =
          'turn completed but no native thread id was reported; session may not persist';
      }
      await this.options.registry.update(workerId, patch);
      return;
    }

    patch.lastError =
      result.error ??
      (result.status === 'unknown' ? 'task outcome unknown; not re-executed' : 'turn failed');
    if (result.status === 'unknown') {
      patch.state = firstTurn ? 'initialization_uncertain' : 'error';
      await this.options.registry.update(workerId, patch);
      return;
    }
    if (firstTurn && !threadId) patch.state = 'initialization_uncertain';
    else if (firstTurn && threadId) patch.state = 'ready';
    else patch.state = 'error';
    await this.options.registry.update(workerId, patch);
  }

  private async markWorkerInterrupted(workerId: string): Promise<void> {
    const worker = this.options.registry.get(workerId);
    if (!worker) return;
    const lastError = 'async task interrupted before a confirmed terminal state; not re-executed';
    if (worker.state === 'initializing' || worker.state === 'pending_initialization') {
      await this.options.registry.update(workerId, {
        state: 'initialization_uncertain',
        lastError,
      });
      return;
    }
    if (worker.state === 'ready') {
      await this.options.registry.update(workerId, { state: 'error', lastError });
    }
  }

  private resolveReplay(
    workerId: string,
    message: string,
    requestKey: string,
  ): { kind: 'fresh' } | { kind: 'conflict' } | { kind: 'replay'; view: DispatchTaskResult } {
    const existing = this.taskStore.getByRequestKey(requestKey);
    if (!existing) return { kind: 'fresh' };
    if (existing.requestFingerprint !== requestFingerprint(workerId, message)) {
      return { kind: 'conflict' };
    }
    return {
      kind: 'replay',
      view: {
        taskId: existing.taskId,
        workerId: existing.workerId,
        status: existing.status,
        replayed: true,
      },
    };
  }

  private conflictError(requestKey: string): WorkerToolError {
    return new WorkerToolError(
      'REQUEST_KEY_CONFLICT',
      `requestKey "${redactSensitive(requestKey, 80)}" is already bound to a different worker or message`,
    );
  }

  private requireWorkerRecord(workerId: string): WorkerRecord {
    const record = this.options.registry.get(workerId);
    if (!record) {
      throw new WorkerToolError('WORKER_NOT_FOUND', `no worker with id ${workerId}`);
    }
    return record;
  }

  private requireTask(taskId: string): WorkerTask {
    const task = this.taskStore.get(taskId);
    if (!task) throw new WorkerToolError('TASK_NOT_FOUND', `no task with id ${taskId}`);
    return task;
  }

  /**
   * A task can record a native thread id before the worker registry does.
   * Starting another Codex thread in that window would impersonate the old one.
   */
  private assertThreadAssociation(workerId: string): void {
    const worker = this.options.registry.get(workerId);
    if (!worker) return;
    for (const task of this.taskStore.list()) {
      if (task.workerId !== workerId || !task.nativeThreadId) continue;
      if (worker.threadId === task.nativeThreadId) continue;
      throw new WorkerToolError(
        'STATE_BLOCKED',
        `worker ${workerId} thread association is unconfirmed ` +
          `(task ${task.taskId} records native thread id ${task.nativeThreadId}, ` +
          `registry has ${worker.threadId ?? 'none'}). A new Codex thread was not created.`,
      );
    }
  }

  private assertRunnable(record: WorkerRecord): void {
    if (record.state === 'initialization_uncertain') {
      throw new WorkerToolError(
        'STATE_BLOCKED',
        `worker ${record.workerId} is in state initialization_uncertain — its first turn ` +
          `failed or was interrupted before a native thread id was captured, so it ` +
          `cannot be safely retried automatically${record.lastError ? ` (last error: ${redactSensitive(record.lastError)})` : ''}. ` +
          `Create a new worker to continue.`,
      );
    }
    if (!this.options.adapter.isConnected()) {
      throw new WorkerToolError(
        'RUNTIME_UNAVAILABLE',
        'codex runtime is not connected; cannot execute worker turns',
      );
    }
  }

  private tryAcquire(workerId: string): boolean {
    if (this.busy.has(workerId)) return false;
    this.busy.add(workerId);
    return true;
  }

  private associationOf(task: WorkerTask): {
    association: TaskAssociation;
    associationDetail: string | null;
  } {
    if (!task.nativeThreadId) {
      return { association: 'unavailable', associationDetail: null };
    }
    const worker = this.options.registry.get(task.workerId);
    if (!worker) {
      return {
        association: 'unconfirmed',
        associationDetail:
          'task records a native thread id but that worker is not in the registry',
      };
    }
    if (worker.threadId === task.nativeThreadId) {
      return { association: 'confirmed', associationDetail: null };
    }
    if (!worker.threadId) {
      return {
        association: 'unconfirmed',
        associationDetail:
          `task records native thread id ${task.nativeThreadId} but the worker registry has none ` +
          '(the task store and the worker registry were not updated together)',
      };
    }
    return {
      association: 'unconfirmed',
      associationDetail:
        `task native thread id ${task.nativeThreadId} does not match worker registry thread id ${worker.threadId}`,
    };
  }

  private async ensureSession(record: WorkerRecord, workspacePath: string): Promise<string> {
    const cached = this.sessions.get(record.workerId);
    if (cached && this.options.adapter.getSession(cached)) return cached;
    const input = {
      cwd: workspacePath,
      ...(record.model ? { model: record.model } : {}),
    };
    const session = record.threadId
      ? await this.options.adapter.resumeSession(record.threadId, input)
      : await this.options.adapter.createSession(input);
    this.sessions.set(record.workerId, session.id);
    return session.id;
  }

  /**
   * Computes the registry patch for a finished synchronous turn. The native
   * thread id — once observed — is always persisted, even when the turn
   * failed, because the native thread then really exists and is resumable.
   */
  private patchForResult(
    record: WorkerRecord,
    result: { status: string; error?: string; externalSessionId?: string },
  ): Partial<WorkerRecord> {
    const capturedId = result.externalSessionId ?? null;
    const firstRun = record.threadId === null;
    const threadId = record.threadId ?? capturedId;
    const patch: Partial<WorkerRecord> = { updatedAt: new Date().toISOString() };

    if (threadId) patch.threadId = threadId;

    if (result.status === 'succeeded') {
      if (threadId) {
        patch.state = 'ready';
        patch.lastError = undefined;
      } else {
        patch.state = 'pending_initialization';
        patch.lastError =
          'turn completed but no native thread id was reported; session may not persist';
      }
      return patch;
    }

    patch.lastError = result.error ?? 'turn failed';
    if (firstRun && !threadId) {
      patch.state = 'initialization_uncertain';
    } else if (firstRun && threadId) {
      patch.state = 'ready';
    } else {
      patch.state = 'error';
    }
    return patch;
  }

  private viewState(record: WorkerRecord): WorkerViewState {
    return this.busy.has(record.workerId) ? 'busy' : record.state;
  }

  private viewOf(record: WorkerRecord): WorkerView {
    return { ...record, state: this.viewState(record) };
  }
}

function defaultWorkerId(): string {
  return `wrk_${randomBytes(6).toString('hex')}`;
}

function defaultTaskId(): string {
  return `task_${randomBytes(8).toString('hex')}`;
}
