/**
 * A batch groups independent asynchronous tasks — one per worker — under a
 * single idempotent request. It is a dispatch-time grouping only: every task
 * keeps its own requestKey, status, result, and native thread association.
 * Batches never share worker context and never change after creation.
 */
export interface BatchTaskInput {
  workerId: string;
  message: string;
}

/**
 * One member of a batch as recorded at dispatch time. `dispatchStatus`
 * captures the honest outcome of the dispatch attempt:
 * - `accepted`: a durable task record exists (`taskId` set); the model turn
 *   may still be running, failed later, or unknown — check the task status.
 * - `rejected`: no task was started (`taskId` null); `errorCategory` carries
 *   the machine-readable reason (e.g. `WORKER_BUSY`, `WORKER_NOT_FOUND`,
 *   `DUPLICATE_WORKER`, `BATCH_LIMIT_EXCEEDED`, `REQUEST_KEY_CONFLICT`).
 */
export interface BatchTaskEntry {
  workerId: string;
  taskId: string | null;
  dispatchStatus: 'accepted' | 'rejected';
  errorCategory?: string | undefined;
  errorMessage?: string | undefined;
}

/**
 * Persisted batch record. Immutable once written: the worker list and the
 * accepted/rejected mapping describe what actually happened at dispatch.
 * Rejected members never gain a taskId later.
 */
export interface TaskBatch {
  batchId: string;
  requestKey: string;
  /** sha256 over the ordered [workerId, message] pairs. Prompts not stored. */
  requestFingerprint: string;
  createdAt: string;
  tasks: BatchTaskEntry[];
}

/** Upper bound for a single worker's response inside a batch result read. */
export const MAX_BATCH_RESPONSE_CHARS = 8000;

/** Default cap on how many tasks one batch may dispatch. */
export const DEFAULT_MAX_BATCH_TASKS = 3;
