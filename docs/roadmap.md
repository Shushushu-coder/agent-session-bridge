# Roadmap

## INIT-01 — Repository & MCP skeleton (done)

- Git repo, TypeScript ESM project, MCP SDK v2 server on stdio.
- Single honest tool: `bridge_status`.
- Contracts only; no runtime wired.

## INIT-02 — Codex persistent worker session (done)

- `CodexRuntimeAdapter` (`src/runtime/codex/`) over `@openai/codex-sdk`
  (`startThread` / `resumeThread` / `run`), fixed read-only/never-approve
  defaults.
- JSON session registry: atomic writes, schema validation, restart
  recovery; worker metadata only.
- `WorkerManager`: per-worker busy enforcement, workspace verification,
  `initializing` crash marker → `initialization_uncertain` blocking.
- Tools: `create_worker`, `list_workers`, `get_worker`,
  `send_worker_message` (synchronous, one turn at a time per worker).
- Offline E2E via compiled fake `codex` binary across real process
  restarts.

## INIT-03 — Asynchronous task dispatch (done)

- `dispatch_worker_task`, `get_task_status`, `get_task_result`.
- In-process `runStreamed()` consumption. `taskId` is the bridge's
  execution id; the SDK events used here have no native turn id.
- JSON task store, separate from the worker registry, with restart
  recovery to `unknown` and unconfirmed thread-association checks.
- Shared per-worker busy lock with `send_worker_message`. No daemon,
  queue, or automatic retry.

Not in this slice: worker removal/rename, a recovery tool for
`initialization_uncertain`, client abort, and MCP Experimental Tasks.

## INIT-04 — Parallel workers & queues

- Multiple concurrent workers, per-worker FIFO task queues, notifications.
- Registry pruning and retention policy.

## Phase 2 — Additional runtimes

- Claude Code adapter, Gemini adapter behind the same `AgentRuntimeAdapter`
  contract.
