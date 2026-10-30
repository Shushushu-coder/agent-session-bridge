export type AgentTaskStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/**
 * A unit of work dispatched to a worker session. Only the minimal fields the
 * bridge needs to route and track the task are defined here.
 */
export interface AgentTask {
  readonly id: string;
  readonly sessionId: string;
  readonly prompt: string;
  status: AgentTaskStatus;
  readonly createdAt: string;
}

export interface TaskResult {
  readonly taskId: string;
  readonly sessionId: string;
  status: AgentTaskStatus;
  output?: string;
  error?: string;
  /**
   * Runtime-native session id observed during this turn (e.g. a Codex
   * thread id first assigned when `thread.started` arrives). Reported even
   * on failure: a turn can fail after the runtime created its session.
   */
  externalSessionId?: string;
  readonly completedAt: string;
}
