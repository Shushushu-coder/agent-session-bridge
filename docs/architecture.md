# Architecture

Agent Session Bridge is a lightweight local MCP server. It lets a Codex
"main" session spawn and supervise persistent worker sessions in external
agent runtimes through standard MCP tools.

```text
Codex Main → MCP Server → WorkerManager → Runtime Adapter → Codex Worker
                    ↓
            Session Registry (JSON file)
```

- **Codex Main** — the interactive Codex session the user talks to. It calls
  this server like any other MCP tool server.
- **MCP Server** — this project. stdio transport,
  `@modelcontextprotocol/server` v2. Exposes `bridge_status`,
  `create_worker`, `list_workers`, `get_worker`, `send_worker_message`.
- **WorkerManager** (`src/workers/`) — owns worker identity and lifecycle.
  Verifies the git workspace on every send, enforces one in-flight turn per
  worker (`busy`), and writes an `initializing` marker before the first turn
  so a mid-turn crash reloads as `initialization_uncertain` instead of
  silently re-running a first prompt that may already have executed.
- **Runtime Adapter** (`src/runtime/codex/`) — `CodexRuntimeAdapter`
  implements `AgentRuntimeAdapter` over `@openai/codex-sdk`
  (`startThread` / `resumeThread` / `run`). Thread options are fixed:
  `read-only` sandbox, `approval_policy="never"`, `web_search="disabled"`,
  git-repo check on, no extra writable dirs.
- **Session Registry** (`src/storage/sessionRegistry.ts`) — JSON file
  (`workers.json`) mapping `workerId → {name, workspacePath, threadId,
  state, model}`. Writes are serialized in-process and committed via
  tmp-file + rename; reads are schema-validated and corrupt files fail
  loudly instead of resetting.

## Thread lifecycle

```text
create_worker            send #1                    send #2+
  │                        │                          │
  ▼                        ▼                          ▼
WorkerRecord            startThread()              resumeThread(id)
state=pending_ ───►  run() → thread.started   or   cached Thread
initialization         │ captures native id        │ (same process)
                       ▼                          ▼
                   threadId persisted          run() → result
                   state=ready
```

Key facts:

- `thread.id` is `null` until the first `thread.started` event arrives
  during `run()` — the bridge never claims a native session exists before
  that.
- Every `run()` spawns a fresh `codex exec --experimental-json` subprocess
  (`resume <id>` appended for resumed threads). Persistence lives in Codex's
  own session files under `~/.codex/sessions`; the bridge only records the
  mapping.
- A first turn that fails without surfacing a thread id marks the worker
  `initialization_uncertain` and blocks further sends — no silent retry of
  a possibly-executed prompt.

## Boundaries (INIT-02)

- Single worker model: busy rejection instead of a queue; no parallel
  dispatch, no background runs, no mid-turn injection.
- `busy` is in-memory only; persisted states are
  `pending_initialization | initializing | ready |
  initialization_uncertain | error`.
- Only the Codex runtime exists. Contracts stay runtime-agnostic so
  Claude/Gemini adapters can plug in later without reshaping the model.

## Layout

```text
src/
  index.ts            stdio entry: open registry → connect adapter → serve
  server.ts           McpServer factory + tool registration
  contracts/          session, task, worker, runtime types
  runtime/codex/      CodexRuntimeAdapter + narrow SDK surface types
  storage/            SessionRegistry (atomic JSON persistence)
  workers/            WorkerManager + git workspace verifier
tests/                unit + fake-CLI E2E + stdio smoke tests
```
