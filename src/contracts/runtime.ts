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
 * Runtime-agnostic adapter contract. Implementations (e.g. a Codex adapter
 * over @openai/codex-sdk, or future Claude/Gemini adapters) are wired in by
 * later milestones; nothing is instantiated in INIT-01.
 */
export interface AgentRuntimeAdapter {
  readonly kind: RuntimeKind;
  isConnected(): boolean;
  connect(): Promise<void>;
  createSession(input?: CreateSessionInput): Promise<WorkerSession>;
  resumeSession(externalSessionId: string): Promise<WorkerSession>;
  runTask(sessionId: string, task: AgentTask): Promise<TaskResult>;
  dispose(): Promise<void>;
}
