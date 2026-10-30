import type { WorkerSession } from './session.js';
import type { AgentTask, TaskResult } from './task.js';

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
export interface AgentRuntimeAdapter {
  readonly kind: RuntimeKind;
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
  /** Snapshot of a live session, or undefined when the id is unknown. */
  getSession(sessionId: string): WorkerSession | undefined;
  dispose(): Promise<void>;
}
