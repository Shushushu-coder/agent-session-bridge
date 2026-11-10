import { Codex } from '@openai/codex-sdk';
import type {
  CodexOptions,
  RunResult,
  RunStreamedResult,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  Usage,
} from '@openai/codex-sdk';

export type {
  CodexOptions,
  RunResult,
  RunStreamedResult,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  Usage,
};

/**
 * Minimal structural surface the adapter needs from a Codex thread. The real
 * SDK `Thread` satisfies this; tests inject fakes. `id` is `null` until the
 * first `thread.started` event arrives during a run.
 *
 * `runStreamed` yields SDK thread events. Those events do not include a
 * native turn id; the bridge correlates a turn with its own task id.
 */
export interface CodexThreadLike {
  readonly id: string | null;
  run(input: string): Promise<RunResult>;
  runStreamed(input: string): Promise<RunStreamedResult>;
}

/**
 * Minimal structural surface of the SDK `Codex` client. `Codex` is
 * structurally assignable: `Thread.run` accepts `Input` (a superset of
 * `string`) and returns `Promise<Turn>` (= `RunResult`).
 */
export interface CodexSdkLike {
  startThread(options?: ThreadOptions): CodexThreadLike;
  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike;
}

/** Compile-time check that the real SDK satisfies the narrow surface. */
const _codexIsSdkLike = (codex: Codex): CodexSdkLike => codex;
void _codexIsSdkLike;

/** Wraps the real SDK class; declared for symmetry with test doubles. */
export function createCodexSdk(options?: CodexOptions): CodexSdkLike {
  return new Codex(options);
}
