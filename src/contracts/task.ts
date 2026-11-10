export type AgentTaskStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';

/**
 * A unit of work dispatched to a worker session. Only the minimal fields the
 * bridge needs to route and track the task are defined here.
 *
 * This is the in-memory input to `AgentRuntimeAdapter.runTask` /
 * `runTaskStreamed`. It is not the persisted async-task record — that is
 * {@link WorkerTask}.
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

/**
 * Lifecycle of one persisted asynchronous worker task.
 *
 * - `accepted`: recorded and handed to the in-process executor. Not a
 *   statement that the model ran.
 * - `running`: the executor is consuming the runtime event stream.
 * - `completed`: a terminal `turn.completed` event was observed.
 * - `failed`: a terminal failure event was observed, or local dispatch
 *   failed before the runtime was invoked.
 * - `unknown`: the process died, or the stream ended without a terminal
 *   event. These tasks are never re-executed automatically.
 */
export type TaskStatus = 'accepted' | 'running' | 'completed' | 'failed' | 'unknown';

/** Token counts copied from the SDK `turn.completed` usage object. */
export interface TaskUsage {
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
}

/** Bounded progress note. Summaries are short and must not carry secrets. */
export interface TaskProgressEntry {
  at: string;
  kind: string;
  summary: string;
}

export interface TaskErrorInfo {
  category: string;
  message: string;
}

/**
 * One asynchronous execution of a single worker message.
 * Distinct from a worker session: many tasks may share one native thread
 * over time, but never concurrently.
 */
export interface WorkerTask {
  taskId: string;
  workerId: string;
  requestKey: string;
  /** sha256 of workerId + message. The prompt itself is not stored. */
  requestFingerprint: string;
  status: TaskStatus;
  createdAt: string;
  startedAt: string | null;
  updatedAt: string;
  completedAt: string | null;
  /** Codex thread id from `thread.started`, when the SDK emitted one. */
  nativeThreadId: string | null;
  /**
   * Model requested at dispatch time (worker model or bridge default),
   * or null when the runtime default applied. Records intent — the
   * runtime does not report which model it actually ran.
   */
  requestedModel: string | null;
  /**
   * Bounded single-line preview of the dispatched message (redacted,
   * truncated) so dashboards can say what the task is about without
   * storing the full prompt. Null for records written before labels
   * existed.
   */
  label: string | null;
  progress: TaskProgressEntry[];
  /** Final assistant message. Set only after `turn.completed`. */
  result: string | null;
  usage: TaskUsage | null;
  error: TaskErrorInfo | null;
}

export const MAX_TASK_PROGRESS = 24;
