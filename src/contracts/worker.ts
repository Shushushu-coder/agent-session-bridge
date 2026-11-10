import type { RuntimeKind } from './runtime.js';

/**
 * Persisted lifecycle states of a managed worker.
 *
 * - `pending_initialization`: registered, first turn not yet attempted; no
 *   native thread id exists.
 * - `initializing`: first turn in flight. Written before the run so that a
 *   crash mid-first-turn is detectable on next load (the native thread may
 *   exist without us ever seeing its id).
 * - `ready`: a native thread id is persisted; the worker can be resumed.
 * - `initialization_uncertain`: first turn failed or was interrupted before a
 *   native thread id was reliably captured. Blocked pending user decision —
 *   never auto-retried (the first prompt may already have run natively).
 * - `error`: last resume/turn failed after the thread id was known. Retry
 *   allowed; each call re-attempts honestly.
 */
export type WorkerState =
  | 'pending_initialization'
  | 'initializing'
  | 'ready'
  | 'initialization_uncertain'
  | 'error';

/** Persisted worker record (Session Registry schema v1). */
export interface WorkerRecord {
  readonly workerId: string;
  name: string;
  readonly runtime: RuntimeKind;
  /** Runtime-native thread id; null until the first successful turn. */
  threadId: string | null;
  workspacePath: string;
  model?: string | undefined;
  /**
   * Id of the bridge server session that registered this worker; null for
   * records written before session tagging existed. Used for display
   * scoping only — ownership is never enforced against other sessions.
   */
  sessionId: string | null;
  state: WorkerState;
  readonly createdAt: string;
  updatedAt: string;
  /** Explicit `undefined` clears the field on update. */
  lastError?: string | undefined;
}

/** `busy` is never persisted; it is overlaid in memory by the manager. */
export type WorkerViewState = WorkerState | 'busy';

/**
 * Where a worker's effective model comes from: the worker's own pinned
 * `model`, the bridge-level adapter default, or the runtime's own
 * default when neither is set.
 */
export type ModelSource = 'worker' | 'bridge_default' | 'runtime_default';

export interface WorkerView {
  workerId: string;
  name: string;
  runtime: RuntimeKind;
  threadId: string | null;
  workspacePath: string;
  model?: string | undefined;
  /**
   * Model the next turn will request, resolved worker `model` → adapter
   * default → `null`. `null` with `modelSource: 'runtime_default'` means
   * the runtime picks; this records the request, not what the runtime
   * actually ran (runtimes do not report that back).
   */
  effectiveModel: string | null;
  modelSource: ModelSource;
  /**
   * Local command to re-attach to this worker's native thread
   * (`codex resume <threadId>`), or null when no thread id exists yet or
   * the worker is mid-turn — a live thread must not be resumed
   * concurrently.
   */
  resumeHint: string | null;
  /** Bridge server session that created this worker; null for legacy records. */
  sessionId: string | null;
  state: WorkerViewState;
  createdAt: string;
  updatedAt: string;
  lastError?: string | undefined;
}

export type SendMessageStatus = 'completed' | 'failed' | 'busy';

export interface SendMessageResult {
  workerId: string;
  status: SendMessageStatus;
  state: WorkerViewState;
  threadId: string | null;
  response?: string;
  error?: string;
}
