import type { RuntimeKind } from './runtime.js';

export type WorkerSessionStatus =
  | 'created'
  | 'ready'
  | 'busy'
  | 'stopped'
  | 'failed';

/**
 * A single worker session managed by the bridge. Runtime-agnostic: the
 * adapter's native handle (e.g. a Codex thread id) is carried only through
 * `externalSessionId`.
 */
export interface WorkerSession {
  readonly id: string;
  readonly runtime: RuntimeKind;
  status: WorkerSessionStatus;
  readonly createdAt: string;
  lastActivityAt?: string;
  externalSessionId?: string;
}
