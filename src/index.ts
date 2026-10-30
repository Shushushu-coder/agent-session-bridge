import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installProcessShutdown } from './processLifetime.js';
import { CodexRuntimeAdapter } from './runtime/codex/codexRuntimeAdapter.js';
import { createServer } from './server.js';
import { SessionRegistry } from './storage/sessionRegistry.js';
import { TaskStore } from './storage/taskStore.js';
import { WorkerManager } from './workers/workerManager.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));

// Data dir: <project>/sessions by default (gitignored), overridable via env.
const dataDir =
  process.env.AGENT_SESSION_BRIDGE_DATA_DIR ?? resolve(moduleDir, '..', 'sessions');
const registryPath = join(dataDir, 'workers.json');
const taskStorePath = join(dataDir, 'tasks.json');

let registry: SessionRegistry;
try {
  registry = await SessionRegistry.open(registryPath);
} catch (error) {
  // Corrupted registry is fatal — never silently drop managed workers.
  console.error(
    `[agent-session-bridge] cannot start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

let taskStore: TaskStore;
try {
  taskStore = await TaskStore.open(taskStorePath);
} catch (error) {
  // Corrupted task history is fatal — never silently drop completed results.
  console.error(
    `[agent-session-bridge] cannot start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

const codexPathOverride = process.env.AGENT_SESSION_BRIDGE_CODEX_PATH;
const defaultModel = process.env.AGENT_SESSION_BRIDGE_MODEL;
const adapter = new CodexRuntimeAdapter({
  ...(codexPathOverride ? { codexOptions: { codexPathOverride } } : {}),
  ...(defaultModel ? { model: defaultModel } : {}),
});
try {
  await adapter.connect();
} catch (error) {
  // Binary missing/unusable: the server still starts — tools report
  // RUNTIME_UNAVAILABLE and bridge_status shows runtimeConnected=false.
  console.error(
    `[agent-session-bridge] codex runtime unavailable: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const maxBatchTasks = Number(process.env.AGENT_SESSION_BRIDGE_MAX_BATCH_TASKS ?? '');
const manager = new WorkerManager({
  registry,
  taskStore,
  adapter,
  ...(Number.isInteger(maxBatchTasks) && maxBatchTasks > 0 ? { maxBatchTasks } : {}),
});

const handle = serveStdio(() => createServer({ manager, adapter, registry }), {
  onerror(error) {
    console.error('[agent-session-bridge] transport error:', error);
  },
});

console.error(
  `[agent-session-bridge] MCP server listening on stdio (registry: ${registryPath}, tasks: ${taskStorePath}, runtime ${adapter.isConnected() ? 'connected' : 'unavailable'})`,
);

// In-flight async tasks are marked unknown and are not resumed. A closed
// stdin ends this process; it does not detach a background daemon.
installProcessShutdown({
  handle,
  abandon: (reason) => manager.abandonInFlight(reason),
});
