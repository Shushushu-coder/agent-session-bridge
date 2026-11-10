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

## INIT-04 — Multi-worker batch orchestration (done)

- `dispatch_worker_batch`, `get_batch_status`, `get_batch_results`.
- One task per worker dispatched concurrently through the existing
  `dispatchTask` path — same busy lock, workspace check, and read-only
  sandbox; no second executor.
- Immutable batch records persisted in `tasks.json` alongside tasks:
  `batchId`, batch requestKey, ordered worker↔task mapping, and
  dispatch-time rejections (`DUPLICATE_WORKER`, `BATCH_LIMIT_EXCEEDED`,
  `WORKER_BUSY`, ...). Batch requestKey shares the global keyspace; replay
  returns the stored batch, different content is `REQUEST_KEY_CONFLICT`.
- Aggregated status computed from real task records; results keep each
  worker's own reply/usage/error (bounded per member) plus usage totals.
  No AI summarization, no auto-retry of `unknown` tasks.

Not in this slice: task cancellation, queues, DAG dependencies, automatic
reviewer workflows, worker↔worker messaging, worktree automation, and
registry pruning.

## INIT-05 — Queues & notifications

- Per-worker FIFO task queues, completion notifications.
- Registry pruning and retention policy.

## INIT-06 — In-app worker board (done)

- `get_board_snapshot`: bounded one-call aggregate (workers × latest task
  × cumulative usage, recent tasks, recent batches) for dashboards and
  quick status reads.
- `open_worker_board` MCP App tool + bundled HTML resource
  (`ui://agent-session-bridge/worker-board`,
  `text/html;profile=mcp-app`): self-refreshing status board rendered
  inline by hosts with MCP Apps support, expandable to the right-side
  panel via `ui/request-display-mode`; text snapshot fallback elsewhere.
- `src/ui/` app (vanilla DOM over `@modelcontextprotocol/ext-apps`),
  esbuild-bundled into a generated TS module via `scripts/build-ui.mjs`;
  separate `tsconfig.ui.json` keeps DOM types out of the Node program.
- Live observer CLI (`bridge watch`) from the previous slice shipped
  alongside: `npm run watch` board + `--follow` rollout tail.
- Model intent surface: `effectiveModel`/`modelSource` on workers,
  `requestedModel` on tasks, `resumeHint` on idle workers,
  `AGENT_SESSION_BRIDGE_MODEL` bridge default.

Not in this slice: task cancellation, queues, DAG dependencies,
writable workers, registry pruning.

## Phase 2 — Additional runtimes

- Claude Code adapter, Gemini adapter behind the same `AgentRuntimeAdapter`
  contract.
