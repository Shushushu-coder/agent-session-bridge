import type { WorkerSession } from './session.js';
import type { AgentTask, TaskResult, TaskUsage } from './task.js';

/** Known runtime kinds; open-ended so future adapters need not change this type. */
export type RuntimeKind = 'codex' | 'claude' | 'gemini' | (string & {});

export interface CreateSessionInput {
  cwd?: string;
  model?: string;
  metadata?: Record<string, string>;
}

/**
 * Runtime-agnostic adapter contract. `CodexRuntimeAdapter`
 * (`src/runtime/codex/`) is the INIT-02 implementation over
 * `@openai/codex-sdk`; Claude/Gemini adapters can plug in behind the same
 * contract later.
 */
export type RuntimeStreamEvent =
  | { type: 'thread.started'; threadId: string }
  | { type: 'turn.started' }
  | { type: 'item.started'; itemType: string; itemId?: string }
  | { type: 'item.updated'; itemType: string; itemId?: string }
  | { type: 'item.completed'; itemType: string; itemId?: string; text?: string }
  | { type: 'turn.completed'; usage: TaskUsage | null }
  | { type: 'turn.failed'; message: string }
  | { type: 'error'; message: string };

export interface AgentRuntimeAdapter {
  readonly kind: RuntimeKind;
  /**
   * Bridge-level default model applied to sessions that don't pin one.
   * Undefined means the runtime's own default applies.
   */
  readonly defaultModel?: string | undefined;
  isConnected(): boolean;
  connect(): Promise<void>;
  createSession(input?: CreateSessionInput): Promise<WorkerSession>;
  /**
   * Rebinds to an existing runtime-native session. `input` carries the same
   * per-session options as `createSession` (e.g. working directory) because
   * most runtimes need them again when re-attaching.
   */
  resumeSession(externalSessionId: string, input?: CreateSessionInput): Promise<WorkerSession>;
  runTask(sessionId: string, task: AgentTask): Promise<TaskResult>;
  /**
   * Consume one streamed turn. Events are the SDK lifecycle signals the
   * bridge knows how to persist. The native SDK does not provide a turn id;
   * callers correlate the stream with their own task id.
   */
  runTaskStreamed(sessionId: string, task: AgentTask): AsyncIterable<RuntimeStreamEvent>;
  /** Snapshot of a live session, or undefined when the id is unknown. */
  getSession(sessionId: string): WorkerSession | undefined;
  dispose(): Promise<void>;
}
