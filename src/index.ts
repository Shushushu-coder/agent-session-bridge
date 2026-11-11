#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { installProcessShutdown } from './processLifetime.js';
import { CodexRuntimeAdapter } from './runtime/codex/codexRuntimeAdapter.js';
import { createServer } from './server.js';
import { SessionRegistry } from './storage/sessionRegistry.js';
import { TaskStore } from './storage/taskStore.js';
import { WorkerManager } from './workers/workerManager.js';

// Data dir: ~/.worker-session-bridge by default, overridable via env. A
// package-relative default would lose state under npx caches and global
// installs.
const dataDir =
  process.env.WORKER_SESSION_BRIDGE_DATA_DIR ?? join(homedir(), '.worker-session-bridge');
const registryPath = join(dataDir, 'workers.json');
const taskStorePath = join(dataDir, 'tasks.json');

let registry: SessionRegistry;
try {
  registry = await SessionRegistry.open(registryPath);
} catch (error) {
  // Corrupted registry is fatal — never silently drop managed workers.
  console.error(
    `[worker-session-bridge] cannot start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

let taskStore: TaskStore;
try {
  taskStore = await TaskStore.open(taskStorePath);
} catch (error) {
  // Corrupted task history is fatal — never silently drop completed results.
  console.error(
    `[worker-session-bridge] cannot start: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(2);
}

/**
 * Best-effort read of the runtime's own default model — the top-level
 * `model` key in the Codex config the spawned CLI also reads. Display
 * metadata only; the bridge never overrides the runtime's choice.
 */
function readRuntimeDefaultModel(): string | undefined {
  try {
    const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    const text = readFileSync(join(home, 'config.toml'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) break;
      const m = /^\s*model\s*=\s*["']([^"']+)["']/.exec(line);
      if (m) return m[1];
    }
  } catch {
    // No readable config — the board just shows "runtime default".
  }
  return undefined;
}

const codexPathOverride = process.env.WORKER_SESSION_BRIDGE_CODEX_PATH;
const defaultModel = process.env.WORKER_SESSION_BRIDGE_MODEL;
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
    `[worker-session-bridge] codex runtime unavailable: ${error instanceof Error ? error.message : String(error)}`,
  );
}

const maxBatchTasks = Number(process.env.WORKER_SESSION_BRIDGE_MAX_BATCH_TASKS ?? '');
const runtimeDefaultModel = readRuntimeDefaultModel();
const manager = new WorkerManager({
  registry,
  taskStore,
  adapter,
  ...(Number.isInteger(maxBatchTasks) && maxBatchTasks > 0 ? { maxBatchTasks } : {}),
  ...(runtimeDefaultModel ? { runtimeDefaultModel } : {}),
});

const handle = serveStdio(() => createServer({ manager, adapter, registry }), {
  onerror(error) {
    console.error('[worker-session-bridge] transport error:', error);
  },
});

console.error(
  `[worker-session-bridge] MCP server listening on stdio (registry: ${registryPath}, tasks: ${taskStorePath}, runtime ${adapter.isConnected() ? 'connected' : 'unavailable'})`,
);

// In-flight async tasks are marked unknown and are not resumed. A closed
// stdin ends this process; it does not detach a background daemon.
installProcessShutdown({
  handle,
  abandon: (reason) => manager.abandonInFlight(reason),
});
