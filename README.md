# Agent Session Bridge

A lightweight local MCP server that lets a Codex main session create,
message, and resume **persistent Codex worker sessions** through standard
MCP tools. Built on the MCP TypeScript SDK v2 over stdio and the official
`@openai/codex-sdk`.

**Status: INIT-04.** Persistent Codex workers and asynchronous task dispatch
remain; a main session can now also dispatch one task per worker in a single
idempotent **batch** call, poll the batch's aggregate status, and read every
member's stored result in one read — including after a server restart.

## Currently implemented

- stdio MCP server (`@modelcontextprotocol/server` v2, Node.js ≥ 22, ESM)
- `CodexRuntimeAdapter` over `@openai/codex-sdk` (`src/runtime/codex/`) —
  `startThread` / `resumeThread` / `run` only; no session-file edits outside
  the SDK
- JSON session registry (`src/storage/sessionRegistry.ts`) — atomic
  tmp+rename writes, schema-validated reads, serialized in-process writes
- `WorkerManager` (`src/workers/`) — worker lifecycle, per-worker busy
  enforcement shared by synchronous sends and asynchronous tasks, workspace
  re-validation, honest state machine
  (`pending_initialization` → `initializing` → `ready` /
  `initialization_uncertain` / `error`)
- JSON task store (`src/storage/taskStore.ts`) — one record per asynchronous
  turn plus immutable batch records (`tasks.json`), separate from
  `workers.json`, with the same atomic-write rules
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
| `dispatch_worker_task` | Accept one turn and return `taskId` without waiting for the model |
| `get_task_status`     | Poll task state, bounded progress, thread id, and error category |
| `get_task_result`     | Read the final reply and token usage, or `NOT_READY` / failure   |
| `dispatch_worker_batch` | Dispatch one task per worker at once; returns `batchId` + per-member outcome immediately |
| `get_batch_status`    | Aggregate live status of every task in a batch                    |
| `get_batch_results`   | Read every member's reply/usage/error in one call (truncated per member) |

`send_worker_message` is synchronous. It returns
`status: "completed" | "failed" | "busy"` only after the turn finishes, and
that contract is unchanged.

`dispatch_worker_task` is asynchronous and only means the task was recorded.
`status: "accepted"` is not a successful model turn. Poll `get_task_status`,
then call `get_task_result`. The same `requestKey` plus the same worker and
message returns the original task and does not run it again. A different
message or worker for that key is `REQUEST_KEY_CONFLICT`. A worker that is
already in a turn is `WORKER_BUSY` and is not queued.

`get_task_result` returns `NOT_READY` while the task is `accepted` or
`running`. `failed` and `unknown` include an error and do not invent a reply.

### Batches

`dispatch_worker_batch` takes `requestKey` plus a `tasks` list of
`{workerId, message}` pairs and fans out one task per worker — derived member
requestKey `<requestKey>#<workerId>` — through the exact dispatch path of
`dispatch_worker_task` (same busy lock, workspace check, replay rules, and
fixed read-only sandbox). It returns `{batchId, tasks[], replayed}` as soon as
every member was accepted or rejected; accepted members keep running in this
process and genuinely run in parallel.

The per-member `dispatchStatus` records the dispatch-time truth:
`accepted` with a `taskId`, or `rejected` with a machine-readable
`errorCategory` (`DUPLICATE_WORKER`, `BATCH_LIMIT_EXCEEDED`, `WORKER_BUSY`,
`WORKER_NOT_FOUND`, `REQUEST_KEY_CONFLICT`, ...). A batch is **not** a
transaction — accepted tasks keep running and remain queryable when siblings
were rejected. One batch dispatches at most `maxBatchTasks` members (default
3, `AGENT_SESSION_BRIDGE_MAX_BATCH_TASKS`); a repeated `workerId` is always
rejected because a worker still runs at most one turn at a time.

The batch record is immutable once written. Replaying the identical request
returns the stored batch (`replayed: true`) without re-running anything; the
same `requestKey` with a different task list is `REQUEST_KEY_CONFLICT`, as is
a `requestKey` already claimed by a lone `dispatch_worker_task` (and vice
versa).

`get_batch_status` computes per-member current status, counts by state, and
two honest flags: `allSettled` (nothing still `accepted`/`running`) and
`allCompleted` (every dispatched task `completed` — mixed outcomes and
unknowns do not count as success).

`get_batch_results` returns each member's status, response, `nativeThreadId`,
usage, and error — never merged across workers — plus deterministic
`resultCounts` and summed `usageTotals`. Members still running report
`NOT_READY`; `failed`/`unknown` members keep their real error and no invented
response. Each member's response is capped (8 000 chars, `truncated: true`,
`responseLength` gives the full size); read the full text via
`get_task_result`.

Errors that reject the call itself (`WORKER_NOT_FOUND`, `INVALID_WORKSPACE`,
`STATE_BLOCKED`, `RUNTIME_UNAVAILABLE`, `WORKER_BUSY`, `REQUEST_KEY_CONFLICT`,
`TASK_NOT_FOUND`, `BATCH_NOT_FOUND`, `INVALID_INPUT`) come back as MCP
`isError` results with a machine-readable code. Per-member failures inside a
batch are reported in `tasks[]`, not as call errors.

### Task id and thread id

`taskId` identifies one execution of one message. `threadId` is the Codex
thread that execution is associated with. Many tasks can share one thread
over time. A task never borrows another task's reply. The SDK events used
here do not include a native turn id, so the bridge does not invent one.

### Task lifecycle

`accepted` → `running` → `completed` or `failed`. If the server process exits
before a terminal event, or the event stream ends without `turn.completed` /
`turn.failed`, the task becomes `unknown` and is not started again. A batch
member follows the same lifecycle; on the next start the batch record is
still readable and its members show their recovered `unknown` state.

### Asking Codex Desktop

1. `dispatch_worker_task` with `workerId`, `message`, and a new `requestKey`
   — or `dispatch_worker_batch` with one `{workerId, message}` pair per
   worker for parallel dispatch under one `batchId`.
2. Call `get_task_status` with the returned `taskId` until the status is
   terminal — or `get_batch_status` for the whole batch at once.
3. Call `get_task_result` for the reply and token usage — or
   `get_batch_results` for every member's reply, usage, and error together.
   The main session then does its own synthesis; the bridge never generates
   an AI summary.

Do this from the same MCP server process. Closing Codex Desktop, or killing
the server, does not keep the turn running.

## Capability boundaries (read before relying on them)

- `send_worker_message` spawns a **new `codex exec` CLI subprocess per
  turn**. A persisted thread id is a resumable checkpoint under
  `~/.codex/sessions`, not a long-lived process.
- **V1 cannot inject instructions into a running turn**. A second
  `send_worker_message` or `dispatch_worker_task` on the same worker is
  rejected while that worker is busy. Different workers can run at the same
  time. There is no queue and no priority scheduler.
- **Asynchronous does not mean a background daemon.** The turn runs in the
  MCP server process. When stdin closes or the process is killed, an
  in-flight task is `unknown` on the next start and is not resumed. Closing
  Codex Desktop does not keep the task running, and a finished main turn is
  not woken up by the task.
- **A turn in flight is not guaranteed to survive** if the MCP server exits.
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

| Variable                            | Purpose                                        |
| ----------------------------------- | ---------------------------------------------- |
| `AGENT_SESSION_BRIDGE_DATA_DIR`     | Data directory for `workers.json` and `tasks.json` (default `<repo>/sessions`) |
| `AGENT_SESSION_BRIDGE_CODEX_PATH`   | Codex binary override (`codexPathOverride`)    |
| `AGENT_SESSION_BRIDGE_MODEL`        | Default model for workers without one          |
| `AGENT_SESSION_BRIDGE_MAX_BATCH_TASKS` | Max tasks a batch may dispatch (default 3)  |

`sessions/` is gitignored. `workers.json` stores worker metadata.
`tasks.json` stores task status, a short progress summary, the final reply,
token usage, and the immutable batch→task mapping. Neither file stores
credentials, member prompts, or the raw SDK event stream.
A corrupt file refuses to start instead of being replaced with an empty
store. On open, `accepted` and `running` tasks become `unknown`. If a task
recorded a native thread id that `workers.json` does not have, status reports
the association as `unconfirmed` and the bridge will not start a new Codex
thread for that worker.

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
src/index.ts             stdio entry (registry + task store → adapter → serve)
src/processLifetime.ts   on shutdown, mark in-flight tasks unknown and exit
src/server.ts            McpServer factory + tool registration
src/contracts/           session / task / batch / worker / runtime types
src/runtime/codex/       CodexRuntimeAdapter over @openai/codex-sdk
src/storage/             SessionRegistry and TaskStore (atomic JSON files)
src/workers/             WorkerManager + git workspace verifier
tests/                   unit + fake-CLI E2E + stdio smoke tests
tests/fixtures/          FakeCodex.cs — offline codex exec stand-in
docs/                    architecture.md, roadmap.md
```
