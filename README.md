# Agent Session Bridge

A lightweight local MCP server that lets a Codex main session create,
message, and resume **persistent Codex worker sessions** through standard
MCP tools. Built on the MCP TypeScript SDK v2 over stdio and the official
`@openai/codex-sdk`.

**Status: INIT-02.** Single persistent Codex worker loop is implemented:
register, first turn (native thread id capture), subsequent turns (cached or
`resumeThread`), and registry-backed recovery across MCP server restarts.

## Currently implemented

- stdio MCP server (`@modelcontextprotocol/server` v2, Node.js ≥ 22, ESM)
- `CodexRuntimeAdapter` over `@openai/codex-sdk` (`src/runtime/codex/`) —
  `startThread` / `resumeThread` / `run` only; no session-file edits outside
  the SDK
- JSON session registry (`src/storage/sessionRegistry.ts`) — atomic
  tmp+rename writes, schema-validated reads, serialized in-process writes
- `WorkerManager` (`src/workers/`) — worker lifecycle, per-worker busy
  enforcement, workspace re-validation on every send, honest state machine
  (`pending_initialization` → `initializing` → `ready` /
  `initialization_uncertain` / `error`)
- Fixed worker sandboxing: `sandboxMode: "read-only"`,
  `approvalPolicy: "never"`, `webSearchMode: "disabled"`, git-repo check
  enforced, no extra writable dirs — workers cannot self-escalate
- Offline E2E: a compiled fake `codex` binary drives the real SDK code path
  (arg construction, JSONL events, resume) across real process restarts

## MCP tools

| Tool                  | Purpose                                                        |
| --------------------- | -------------------------------------------------------------- |
| `bridge_status`       | Runtime connectivity + managed worker count (honest status)    |
| `create_worker`       | Register a worker (`name`, `workspacePath`, optional `model`)  |
| `list_workers`        | List managed workers with state + thread id                    |
| `get_worker`          | Inspect one worker                                             |
| `send_worker_message` | Run one synchronous turn; first call initializes the thread    |

`send_worker_message` returns `status: "completed" | "failed" | "busy"`.
Errors that reject the call itself (`WORKER_NOT_FOUND`, `INVALID_WORKSPACE`,
`STATE_BLOCKED`, `RUNTIME_UNAVAILABLE`) come back as MCP `isError` results
with a machine-readable code.

## Capability boundaries (read before relying on them)

- `send_worker_message` spawns a **new `codex exec` CLI subprocess per
  turn**. A persisted thread id is a resumable checkpoint under
  `~/.codex/sessions`, not a long-lived process.
- **V1 cannot inject instructions into a running turn**; a second
  concurrent `send_worker_message` on the same worker returns `busy`.
- **A turn in flight is not guaranteed to survive** if the MCP server (or
  Codex main) exits — the bridge does not babysit the child process after
  death.
- No multi-worker parallel dispatch, task queue, or event subscriptions in
  V1.
- No Claude/Gemini adapters yet.
- The bridge **never modifies Codex config or unmanaged sessions**, stores
  no credentials, and never writes conversation history — only worker
  metadata in its own registry file.
- A worker whose first turn failed before a thread id was captured is
  marked `initialization_uncertain` and **refuses automatic retry** (the
  prompt may already have run natively); create a new worker instead.

## Requirements

- Node.js ≥ 22, npm, Git
- Codex CLI — the SDK resolves the `@openai/codex` vendored binary
  automatically (or point `AGENT_SESSION_BRIDGE_CODEX_PATH` at a binary)

## Install

```sh
npm install
```

## Commands

| Command              | Purpose                                       |
| -------------------- | --------------------------------------------- |
| `npm run dev`        | Run the server from source via `tsx`          |
| `npm run build`      | Compile TypeScript to `dist/`                 |
| `npm run typecheck`  | Strict `tsc --noEmit` over `src/` + `tests/`  |
| `npm run test`       | All vitest tests (unit + E2E + smoke)         |
| `npm run smoke`      | Build, then run the real-stdio smoke test     |
| `npm start`          | Run the built server (`node dist/index.js`)   |

All tests are offline: no real Codex model call is ever made. The
`codex exec` path is exercised against a fake compiled binary
(`tests/fixtures/FakeCodex.cs` via `csc.exe`); tests skip gracefully if no
compiler is present.

## Environment variables

| Variable                          | Purpose                                        |
| --------------------------------- | ---------------------------------------------- |
| `AGENT_SESSION_BRIDGE_DATA_DIR`   | Registry directory (default `<repo>/sessions`) |
| `AGENT_SESSION_BRIDGE_CODEX_PATH` | Codex binary override (`codexPathOverride`)    |
| `AGENT_SESSION_BRIDGE_MODEL`      | Default model for workers without one          |

`sessions/` is gitignored; the registry stores worker metadata only (no
tokens, no transcripts).

## Manual Codex MCP configuration (optional)

The bridge does **not** touch your Codex configuration. To let Codex see
this server, add an entry like this to `~/.codex/config.toml` yourself:

```toml
[mcp_servers.agent-session-bridge]
command = "node"
args = ["E:\\Projects\\agent-session-bridge\\dist\\index.js"]
```

## Project layout

```text
src/index.ts             stdio entry (registry load → adapter → serve)
src/server.ts            McpServer factory + tool registration
src/contracts/           session / task / worker / runtime types
src/runtime/codex/       CodexRuntimeAdapter over @openai/codex-sdk
src/storage/             SessionRegistry (atomic JSON persistence)
src/workers/             WorkerManager + git workspace verifier
tests/                   unit + fake-CLI E2E + stdio smoke tests
tests/fixtures/          FakeCodex.cs — offline codex exec stand-in
docs/                    architecture.md, roadmap.md
```
