# Architecture

Agent Session Bridge is a lightweight local MCP server. Its purpose is to let
a Codex "main" session spawn and supervise worker sessions in external agent
runtimes through standard MCP tools.

```text
Codex Main → MCP Server → Runtime Adapter → Codex Worker
```

- **Codex Main** — the interactive Codex session the user talks to. It calls
  this server like any other MCP tool server.
- **MCP Server** — this project. stdio transport, `@modelcontextprotocol/server`
  v2. In INIT-01 it exposes only `bridge_status`; session/task tools arrive
  with the adapter.
- **Runtime Adapter** — implements `AgentRuntimeAdapter`
  (`src/contracts/runtime.ts`). Translates bridge sessions/tasks into
  runtime-native calls (e.g. `@openai/codex-sdk` threads for Codex).
- **Codex Worker** — a headless runtime session that executes dispatched
  tasks.

## Boundaries (INIT-01)

- No runtime adapter is instantiated; `runtimeConnected` is always `false`.
- No session registry or persistence; `src/storage/` is a placeholder.
- Contracts (`WorkerSession`, `AgentTask`, `TaskResult`,
  `AgentRuntimeAdapter`) are runtime-agnostic so Claude/Gemini adapters can
  plug in later without reshaping the model.

## Layout

```text
src/
  index.ts            stdio entry (serveStdio)
  server.ts           McpServer factory + bridge_status tool
  contracts/          session, task, runtime types
  runtime/codex/      future Codex adapter
  storage/            future session registry / persistence
tests/                unit + stdio smoke tests
```
