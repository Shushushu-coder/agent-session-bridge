# Roadmap

## INIT-01 — Repository & MCP skeleton (this milestone)

- Git repo, TypeScript ESM project, MCP SDK v2 server on stdio.
- Single honest tool: `bridge_status`.
- Contracts only; no runtime wired.

## INIT-02 — Codex SDK session create/resume

- Add `CodexRuntimeAdapter` (`src/runtime/codex/`) over `@openai/codex-sdk`.
- `AgentRuntimeAdapter.createSession` / `resumeSession` backed by Codex
  threads.
- New tools (e.g. `session_create`, `session_resume`) once they are real.

## INIT-03 — Task dispatch & result read

- `AgentRuntimeAdapter.runTask` implementation.
- Task dispatch tool + result/notification surfacing to Codex Main.

## INIT-04 — Parallel workers & session registry

- Multiple concurrent `WorkerSession`s.
- `src/storage/` session registry: tracking, resume-on-restart, cleanup.

## Phase 2 — Additional runtimes

- Claude Code adapter, Gemini adapter behind the same `AgentRuntimeAdapter`
  contract.
