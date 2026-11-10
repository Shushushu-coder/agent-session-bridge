import { randomUUID } from 'node:crypto';
import type {
  AgentRuntimeAdapter,
  CreateSessionInput,
  RuntimeStreamEvent,
} from '../../contracts/runtime.js';
import type { WorkerSession } from '../../contracts/session.js';
import type { AgentTask, TaskResult, TaskUsage } from '../../contracts/task.js';
import {
  createCodexSdk,
  type CodexOptions,
  type CodexSdkLike,
  type CodexThreadLike,
  type ThreadEvent,
  type ThreadOptions,
  type Usage,
} from './codexSdk.js';

export class CodexAdapterError extends Error {
  constructor(
    readonly code: 'NOT_CONNECTED' | 'SESSION_NOT_FOUND' | 'SESSION_BUSY',
    message: string,
  ) {
    super(message);
    this.name = 'CodexAdapterError';
  }
}

export interface CodexRuntimeAdapterOptions {
  /** Prebuilt SDK-like client (tests inject fakes). */
  sdk?: CodexSdkLike;
  /** Options for the real `Codex` constructor when `sdk` is not provided. */
  codexOptions?: CodexOptions;
  /** Default model for threads that don't specify one. */
  model?: string;
}

interface SessionEntry {
  session: WorkerSession;
  thread: CodexThreadLike;
  running: boolean;
}

/**
 * `AgentRuntimeAdapter` over `@openai/codex-sdk`.
 *
 * Each bridge session wraps one SDK `Thread`. Every `run()` spawns a fresh
 * `codex exec` CLI subprocess — a persisted thread id is a resumable
 * checkpoint, not a long-lived process.
 *
 * Safety defaults are fixed here, not configurable by callers:
 * `sandboxMode: 'read-only'`, `approvalPolicy: 'never'`,
 * `webSearchMode: 'disabled'`, git-repo check enforced, no extra writable
 * directories. Workers can never escalate their own permissions.
 */
export class CodexRuntimeAdapter implements AgentRuntimeAdapter {
  readonly kind = 'codex' as const;

  /** Bridge-level default model (e.g. AGENT_SESSION_BRIDGE_MODEL). */
  get defaultModel(): string | undefined {
    return this.options.model;
  }

  private sdk: CodexSdkLike | undefined;
  private readonly sessions = new Map<string, SessionEntry>();

  constructor(private readonly options: CodexRuntimeAdapterOptions = {}) {}

  isConnected(): boolean {
    return this.sdk !== undefined;
  }

  /**
   * Resolves the Codex CLI binary (vendored with `@openai/codex`, or
   * `codexOptions.codexPathOverride`). Throws if no binary can be located —
   * callers should treat that as "runtime unavailable".
   */
  async connect(): Promise<void> {
    if (!this.sdk) {
      this.sdk = this.options.sdk ?? createCodexSdk(this.options.codexOptions);
    }
  }

  async createSession(input: CreateSessionInput = {}): Promise<WorkerSession> {
    const thread = this.requireSdk().startThread(this.threadOptions(input));
    return this.register(thread);
  }

  async resumeSession(
    externalSessionId: string,
    input: CreateSessionInput = {},
  ): Promise<WorkerSession> {
    const thread = this.requireSdk().resumeThread(
      externalSessionId,
      this.threadOptions(input),
    );
    return this.register(thread, externalSessionId);
  }

  async runTask(sessionId: string, task: AgentTask): Promise<TaskResult> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new CodexAdapterError('SESSION_NOT_FOUND', `Unknown session ${sessionId}`);
    }
    if (entry.running) {
      throw new CodexAdapterError('SESSION_BUSY', `Session ${sessionId} is already running`);
    }

    entry.running = true;
    entry.session.status = 'busy';
    const completedAt = () => new Date().toISOString();
    try {
      const turn = await entry.thread.run(task.prompt);
      entry.session.status = 'ready';
      if (entry.thread.id) entry.session.externalSessionId = entry.thread.id;
      entry.session.lastActivityAt = completedAt();
      return {
        taskId: task.id,
        sessionId,
        status: 'succeeded',
        output: turn.finalResponse,
        ...(this.nativeIdOf(entry) ? { externalSessionId: this.nativeIdOf(entry)! } : {}),
        completedAt: completedAt(),
      };
    } catch (error) {
      entry.session.status = 'failed';
      entry.session.lastActivityAt = completedAt();
      return {
        taskId: task.id,
        sessionId,
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        ...(this.nativeIdOf(entry) ? { externalSessionId: this.nativeIdOf(entry)! } : {}),
        completedAt: completedAt(),
      };
    } finally {
      entry.running = false;
    }
  }

  /**
   * Stream one turn. The caller owns task persistence; this method only
   * maps SDK events and keeps the per-session running flag. Assistant text
   * is forwarded only for `agent_message` completions — command output and
   * other item payloads stay inside the SDK process.
   */
  async *runTaskStreamed(sessionId: string, task: AgentTask): AsyncGenerator<RuntimeStreamEvent> {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new CodexAdapterError('SESSION_NOT_FOUND', `Unknown session ${sessionId}`);
    }
    if (entry.running) {
      throw new CodexAdapterError('SESSION_BUSY', `Session ${sessionId} is already running`);
    }

    entry.running = true;
    entry.session.status = 'busy';
    try {
      const streamed = await entry.thread.runStreamed(task.prompt);
      for await (const event of streamed.events) {
        if (event.type === 'thread.started' && event.thread_id) {
          entry.session.externalSessionId = event.thread_id;
        }
        const mapped = mapThreadEvent(event);
        if (mapped) yield mapped;
      }
      if (entry.thread.id) entry.session.externalSessionId = entry.thread.id;
      entry.session.status = 'ready';
      entry.session.lastActivityAt = new Date().toISOString();
    } catch (error) {
      if (entry.thread.id) entry.session.externalSessionId = entry.thread.id;
      entry.session.status = 'failed';
      entry.session.lastActivityAt = new Date().toISOString();
      throw error;
    } finally {
      entry.running = false;
    }
  }

  /** Current snapshot of a live session (undefined if unknown). */
  getSession(sessionId: string): WorkerSession | undefined {
    const entry = this.sessions.get(sessionId);
    return entry ? { ...entry.session } : undefined;
  }

  async dispose(): Promise<void> {
    for (const entry of this.sessions.values()) {
      if (entry.session.status !== 'failed') entry.session.status = 'stopped';
    }
    this.sessions.clear();
  }

  private register(thread: CodexThreadLike, externalSessionId?: string): WorkerSession {
    const session: WorkerSession = {
      id: `csess_${randomUUID()}`,
      runtime: this.kind,
      status: externalSessionId ? 'ready' : 'created',
      createdAt: new Date().toISOString(),
      ...(externalSessionId ? { externalSessionId } : {}),
    };
    this.sessions.set(session.id, { session, thread, running: false });
    return { ...session };
  }

  private nativeIdOf(entry: SessionEntry): string | undefined {
    return entry.thread.id ?? entry.session.externalSessionId;
  }

  private requireSdk(): CodexSdkLike {
    if (!this.sdk) {
      throw new CodexAdapterError(
        'NOT_CONNECTED',
        'Codex runtime is not connected (adapter.connect() not called or failed)',
      );
    }
    return this.sdk;
  }

  /**
   * Fixed safe defaults; only `workingDirectory` and `model` vary per
   * session. `skipGitRepoCheck`, `additionalDirectories` and
   * `networkAccessEnabled` are deliberately never set.
   */
  private threadOptions(input: CreateSessionInput): ThreadOptions {
    const model = input.model ?? this.options.model;
    return {
      ...(input.cwd ? { workingDirectory: input.cwd } : {}),
      ...(model ? { model } : {}),
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      webSearchMode: 'disabled',
    };
  }
}

function mapThreadEvent(event: ThreadEvent): RuntimeStreamEvent | undefined {
  switch (event.type) {
    case 'thread.started':
      return event.thread_id ? { type: 'thread.started', threadId: event.thread_id } : undefined;
    case 'turn.started':
      return { type: 'turn.started' };
    case 'item.started':
    case 'item.updated':
      return itemEvent(event.type, event.item.type, event.item.id);
    case 'item.completed':
      return itemEvent(
        'item.completed',
        event.item.type,
        event.item.id,
        event.item.type === 'agent_message' ? event.item.text : undefined,
      );
    case 'turn.completed':
      return { type: 'turn.completed', usage: normalizeUsage(event.usage) };
    case 'turn.failed':
      return { type: 'turn.failed', message: event.error.message };
    case 'error':
      return { type: 'error', message: event.message };
    default:
      return undefined;
  }
}

function itemEvent(
  type: 'item.started' | 'item.updated' | 'item.completed',
  itemType: string,
  itemId: string,
  text?: string,
): RuntimeStreamEvent {
  const base = {
    type,
    itemType,
    ...(itemId ? { itemId } : {}),
    ...(text !== undefined ? { text } : {}),
  };
  return base as RuntimeStreamEvent;
}

function normalizeUsage(usage: Usage | null | undefined): TaskUsage | null {
  if (!usage) return null;
  return {
    input_tokens: usage.input_tokens ?? 0,
    cached_input_tokens: usage.cached_input_tokens ?? 0,
    cache_write_input_tokens: usage.cache_write_input_tokens ?? 0,
    output_tokens: usage.output_tokens ?? 0,
    reasoning_output_tokens: usage.reasoning_output_tokens ?? 0,
  };
}
