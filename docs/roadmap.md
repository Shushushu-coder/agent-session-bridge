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

## INIT-03 — Richer worker operations

- Task/turn metadata surfacing (usage, items), optional streaming
  progress via `runStreamed`.
- Worker removal/rename tools; recovery path for
  `initialization_uncertain` workers.
- AbortSignal plumbing for client-initiated cancellation.

## INIT-04 — Parallel workers & queues

- Multiple concurrent workers, per-worker FIFO task queues, notifications.
- Registry pruning and retention policy.

## Phase 2 — Additional runtimes

- Claude Code adapter, Gemini adapter behind the same `AgentRuntimeAdapter`
  contract.
