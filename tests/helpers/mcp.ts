import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionRegistry } from '../../src/storage/sessionRegistry.js';
import { WorkerManager } from '../../src/workers/workerManager.js';
import type { WorkspaceVerifier } from '../../src/workers/workspaceVerifier.js';
import { createServer, type BridgeDeps } from '../../src/server.js';
import type { AgentRuntimeAdapter } from '../../src/contracts/runtime.js';

export interface TestStack {
  client: Client;
  server: McpServer;
  deps: BridgeDeps;
  dataDir: string;
}

const passThrough: WorkspaceVerifier = async (p) => ({ ok: true, resolvedPath: p });

export async function createTestStack(
  adapter: AgentRuntimeAdapter,
  verifyWorkspace: WorkspaceVerifier = passThrough,
): Promise<TestStack> {
  const dataDir = await mkdtemp(join(tmpdir(), 'asb-mcp-'));
  const registry = await SessionRegistry.open(join(dataDir, 'workers.json'));
  const manager = new WorkerManager({ registry, adapter, verifyWorkspace });
  const deps: BridgeDeps = { manager, adapter, registry };
  const server = createServer(deps);
  const client = new Client({ name: 'test-client', version: '0.0.1' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client, server, deps, dataDir };
}

export function textOf(result: Awaited<ReturnType<Client['callTool']>>): string {
  return result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('');
}
