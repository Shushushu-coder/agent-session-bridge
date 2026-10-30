import { randomBytes, randomUUID } from 'node:crypto';
import type { AgentRuntimeAdapter } from '../contracts/runtime.js';
import type { AgentTask } from '../contracts/task.js';
import type {
  SendMessageResult,
  WorkerRecord,
  WorkerView,
  WorkerViewState,
} from '../contracts/worker.js';
import { CodexAdapterError } from '../runtime/codex/codexRuntimeAdapter.js';
import type { SessionRegistry } from '../storage/sessionRegistry.js';
import { verifyGitWorkspace, type WorkspaceVerifier } from './workspaceVerifier.js';

export type WorkerErrorCode =
  | 'WORKER_NOT_FOUND'
  | 'INVALID_WORKSPACE'
  | 'STATE_BLOCKED'
  | 'RUNTIME_UNAVAILABLE'
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
  adapter: AgentRuntimeAdapter;
  verifyWorkspace?: WorkspaceVerifier;
  idGenerator?: () => string;
}

/**
 * Orchestrates managed workers: registry persistence, workspace validation,
 * busy tracking, and first-turn vs resume dispatch through the runtime
 * adapter. Holds no model access itself — every `sendMessage` delegates to
 * the adapter and reports exactly what it returned.
 */
export class WorkerManager {
  private readonly busy = new Set<string>();
  /** workerId → live adapter session id (memory only). */
  private readonly sessions = new Map<string, string>();
  private readonly verifyWorkspace: WorkspaceVerifier;
  private readonly idGenerator: () => string;

  constructor(private readonly options: WorkerManagerOptions) {
    this.verifyWorkspace = options.verifyWorkspace ?? verifyGitWorkspace;
    this.idGenerator = options.idGenerator ?? defaultWorkerId;
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
    return this.options.registry.list().map((r) => this.viewOf(r));
  }

  getWorker(workerId: string): WorkerView {
    const record = this.options.registry.get(workerId);
    if (!record) {
      throw new WorkerToolError('WORKER_NOT_FOUND', `no worker with id ${workerId}`);
    }
    return this.viewOf(record);
  }

  async sendMessage(workerId: string, message: string): Promise<SendMessageResult> {
    const record = this.options.registry.get(workerId);
    if (!record) {
      throw new WorkerToolError('WORKER_NOT_FOUND', `no worker with id ${workerId}`);
    }
    const base = { workerId, threadId: record.threadId };
    if (this.busy.has(workerId)) {
      return {
        ...base,
        status: 'busy',
        state: 'busy',
        error: 'worker is already running a turn',
      };
    }
    if (record.state === 'initialization_uncertain') {
      throw new WorkerToolError(
        'STATE_BLOCKED',
        `worker ${workerId} is in state initialization_uncertain — its first turn ` +
          `failed or was interrupted before a native thread id was captured, so it ` +
          `cannot be safely retried automatically${record.lastError ? ` (last error: ${record.lastError})` : ''}. ` +
          `Create a new worker to continue.`,
      );
    }
    if (!this.options.adapter.isConnected()) {
      throw new WorkerToolError(
        'RUNTIME_UNAVAILABLE',
        'codex runtime is not connected; cannot execute worker turns',
      );
    }
    const check = await this.verifyWorkspace(record.workspacePath);
    if (!check.ok) {
      throw new WorkerToolError(
        'INVALID_WORKSPACE',
        `workspace for worker ${workerId} is no longer valid: ${check.error ?? 'check failed'}`,
      );
    }

    this.busy.add(workerId);
    try {
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
        `send_worker_message failed for ${workerId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.busy.delete(workerId);
    }
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
   * Computes the registry patch for a finished turn. The native thread id —
   * once observed — is always persisted, even when the turn failed, because
   * the native thread then really exists and is resumable.
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
        // Turn reported success without ever surfacing a native thread id —
        // context may not persist. Say so instead of claiming readiness.
        patch.state = 'pending_initialization';
        patch.lastError =
          'turn completed but no native thread id was reported; session may not persist';
      }
      return patch;
    }

    // Failed turn.
    patch.lastError = result.error ?? 'turn failed';
    if (firstRun && !threadId) {
      patch.state = 'initialization_uncertain';
    } else if (firstRun && threadId) {
      // Thread exists natively; only the turn failed. Resumable.
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
