/**
 * Offline stdio MCP server used by process-level tests. It never constructs
 * a Codex client and never calls a model.
 */
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { join } from 'node:path';
import { installProcessShutdown } from '../../src/processLifetime.js';
import { createServer } from '../../src/server.js';
import { SessionRegistry } from '../../src/storage/sessionRegistry.js';
import { TaskStore } from '../../src/storage/taskStore.js';
import { WorkerManager } from '../../src/workers/workerManager.js';
import { FakeRuntimeAdapter } from '../helpers/fakes.js';

const dataDir = process.env.AGENT_SESSION_BRIDGE_DATA_DIR;
if (!dataDir) {
  console.error('[fake-stdio] AGENT_SESSION_BRIDGE_DATA_DIR is required');
  process.exit(2);
}

const registry = await SessionRegistry.open(join(dataDir, 'workers.json'));
const taskStore = await TaskStore.open(join(dataDir, 'tasks.json'));
const adapter = new FakeRuntimeAdapter();
adapter.streamDelayMs = Number(process.env.AGENT_SESSION_BRIDGE_STREAM_DELAY_MS ?? '0');
const manager = new WorkerManager({
  registry,
  taskStore,
  adapter,
  verifyWorkspace: async (workspacePath) => ({ ok: true, resolvedPath: workspacePath }),
});

const handle = serveStdio(() => createServer({ manager, adapter, registry }));
installProcessShutdown({
  handle,
  abandon: (reason) => manager.abandonInFlight(reason),
});
