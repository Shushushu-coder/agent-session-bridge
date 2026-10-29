# Agent Session Bridge

A lightweight local MCP server that will let a Codex main session create,
dispatch tasks to, and supervise worker sessions running in external agent
runtimes. Built on the MCP TypeScript SDK v2 over stdio.

**Status: INIT-01 skeleton.** The server runs and answers MCP, but no agent
runtime is connected yet.

## Currently implemented

- stdio MCP server (`@modelcontextprotocol/server` v2, Node.js ≥ 22, ESM)
- One tool: `bridge_status` — reports honest skeleton status:
  `runtimeConnected: false`, `sessionOrchestrationAvailable: false`
- Runtime-agnostic contracts: `WorkerSession`, `AgentTask`, `TaskResult`,
  `AgentRuntimeAdapter` (`src/contracts/`)
- Unit tests and a real-stdio smoke test (official MCP client ↔ spawned
  server subprocess)

## Not implemented yet

- No Codex worker creation, task dispatch, or session resume — no such tools
  are exposed, by design
- No session registry / persistence (`src/storage/` is a placeholder)
- No Claude/Gemini adapters

See `docs/roadmap.md` for INIT-02+.

## Requirements

- Node.js ≥ 22, npm, Git

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
| `npm run test`       | All vitest tests (unit + smoke)               |
| `npm run smoke`      | Build, then run the real-stdio smoke test     |
| `npm start`          | Run the built server (`node dist/index.js`)   |

## Running the MCP server

```sh
npm run build
npm start
```

The process speaks MCP on stdout/stdin; diagnostics go to stderr. It exits
when stdin closes. No Codex process is spawned, no user sessions or config
are touched.

## Manual Codex MCP configuration (optional)

INIT-01 does **not** touch your Codex configuration. If you later want Codex
to see this server, an entry like this in `~/.codex/config.toml` is the
expected shape — apply it yourself:

```toml
[mcp_servers.agent-session-bridge]
command = "node"
args = ["E:\\Projects\\agent-session-bridge\\dist\\index.js"]
```

## Project layout

```text
src/index.ts            stdio entry (serveStdio)
src/server.ts           McpServer factory, bridge_status tool
src/contracts/          WorkerSession / AgentTask / TaskResult / AgentRuntimeAdapter
src/runtime/codex/      future Codex adapter
src/storage/            future session registry
tests/                  server.test.ts (in-memory), mcp-smoke.test.ts (real stdio)
docs/                   architecture.md, roadmap.md
```
