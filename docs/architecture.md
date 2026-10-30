# Architecture

Agent Session Bridge is a lightweight local MCP server. It lets a Codex
"main" session spawn and supervise persistent worker sessions in external
agent runtimes through standard MCP tools.

```text
Codex Main → MCP Server → WorkerManager → Runtime Adapter → Codex Worker
                    ↓            ↓
            Session Registry   Task Store
              (workers.json)   (tasks.json)
```

- **Codex Main** — the interactive Codex session the user talks to. It calls
  this server like any other MCP tool server.
- **MCP Server** — this project. stdio transport,
  `@modelcontextprotocol/server` v2. Exposes `bridge_status`,
  `create_worker`, `list_workers`, `get_worker`, `send_worker_message`,
  `dispatch_worker_task`, `get_task_status`, and `get_task_result`.
- **WorkerManager** (`src/workers/`) — owns worker identity and lifecycle.
  Verifies the git workspace on every send, enforces one in-flight turn per
  worker (`busy`) for both synchronous sends and asynchronous tasks, and
  writes an `initializing` marker before the first turn so a mid-turn crash
  reloads as `initialization_uncertain` instead of silently re-running a
  first prompt that may already have executed.
- **Runtime Adapter** (`src/runtime/codex/`) — `CodexRuntimeAdapter`
  implements `AgentRuntimeAdapter` over `@openai/codex-sdk`
  (`startThread` / `resumeThread` / `run` / `runStreamed`). Thread options
  are fixed: `read-only` sandbox, `approval_policy="never"`,
  `web_search="disabled"`, git-repo check on, no extra writable dirs.
  Synchronous sends still use `run()`. Asynchronous tasks consume
  `runStreamed()` inside this process. SDK thread events have no turn id;
  the bridge correlates them with its own `taskId`.
- **Session Registry** (`src/storage/sessionRegistry.ts`) — JSON file
  (`workers.json`) mapping `workerId → {name, workspacePath, threadId,
  state, model}`. Writes are serialized in-process and committed via
  tmp-file + rename; reads are schema-validated and corrupt files fail
  loudly instead of resetting.
- **Task Store** (`src/storage/taskStore.ts`) — a separate JSON file
  (`tasks.json`) for asynchronous tasks. It stores status, timestamps, the
  native thread id, a bounded progress summary, the final assistant message,
  and token usage. It does not store credentials or the raw event stream.
  The same atomic write and corruption rules apply. `accepted` and `running`
  tasks become `unknown` on open and are not re-executed.

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

## Synchronous and asynchronous turns

`send_worker_message` waits for `thread.run()` and returns the reply in
that tool result. `dispatch_worker_task` writes an `accepted` task, returns
`{ taskId, workerId, status: "accepted" }`, and only then consumes
`runStreamed()` on a timer in the same process. Both paths take the same
worker busy lock. A second call is rejected; nothing is queued.

Task states are `accepted | running | completed | failed | unknown`.
`completed` requires `turn.completed`. `turn.failed` and a fatal `error`
event are `failed`. A thrown stream with no terminal event is `unknown`.
`get_task_result` returns `NOT_READY` until the task is terminal, and it
does not copy a partial assistant message into a failed or unknown result.

`taskId` is one message execution. `threadId` / `nativeThreadId` is the
Codex thread. They are different ids.

The registry and the task store are written separately. If a task has a
native thread id and `workers.json` does not have that same id, task reads
report `association: "unconfirmed"`. Send and dispatch then refuse to start
a new Codex thread for that worker.

## Process lifetime

Async execution is an in-process promise plus the Codex CLI subprocess for
that turn. It is not a daemon. On stdin close, SIGINT, or SIGTERM the
server marks live tasks `unknown` and exits. A killed process leaves the
same recovery to the next `TaskStore.open`. No turn is resumed, and a main
session that already finished is not notified.

## Boundaries (INIT-03)

- One active turn per worker. Different workers may run at the same time.
  No task queue, DAG, or priority scheduler.
- `busy` is in-memory only; persisted worker states are
  `pending_initialization | initializing | ready |
  initialization_uncertain | error`.
- Only the Codex runtime exists. Contracts stay runtime-agnostic so
  Claude/Gemini adapters can plug in later without reshaping the model.
- The fixed read-only sandbox is unchanged.

## Layout

```text
src/
  index.ts            stdio entry: open registry and task store → connect adapter → serve
  server.ts           McpServer factory + tool registration
  contracts/          session, task, worker, runtime types
  runtime/codex/      CodexRuntimeAdapter + narrow SDK surface types
  storage/            SessionRegistry and TaskStore (separate JSON files)
  processLifetime.ts  stdin/signal shutdown marks live tasks unknown
  workers/            WorkerManager + git workspace verifier
tests/                unit + fake-CLI E2E + stdio smoke tests
```
