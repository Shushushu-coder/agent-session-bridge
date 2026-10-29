import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BRIDGE_NAME,
  BRIDGE_VERSION,
  createServer,
  getBridgeStatus,
} from '../src/server.js';

async function createLinkedPair() {
  const server = createServer();
  const client = new Client({ name: 'bridge-test-client', version: '0.0.1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return { client, server };
}

describe('createServer', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((fn) => fn()));
  });

  it('creates an McpServer instance', () => {
    const server = createServer();
    expect(server).toBeInstanceOf(McpServer);
    cleanups.push(() => server.close());
  });

  it('exposes exactly the bridge_status tool and nothing else', async () => {
    const { client, server } = await createLinkedPair();
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(['bridge_status']);
  });

  it('bridge_status returns the skeleton status via content and structuredContent', async () => {
    const { client, server } = await createLinkedPair();
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    const result = await client.callTool({ name: 'bridge_status', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      name: 'agent-session-bridge',
      version: BRIDGE_VERSION,
      status: 'skeleton_ready',
      runtime: 'codex',
      runtimeConnected: false,
      sessionOrchestrationAvailable: false,
    });

    const text = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('');
    expect(JSON.parse(text)).toEqual(result.structuredContent);
  });

  it('reports the agreed server identity during initialization', async () => {
    const { client, server } = await createLinkedPair();
    cleanups.push(async () => {
      await client.close();
      await server.close();
    });

    expect(client.getServerVersion()).toEqual({
      name: BRIDGE_NAME,
      version: BRIDGE_VERSION,
    });
  });
});

describe('getBridgeStatus', () => {
  it('reports honest unimplemented state', () => {
    const status = getBridgeStatus();
    expect(status.runtimeConnected).toBe(false);
    expect(status.sessionOrchestrationAvailable).toBe(false);
    expect(status.status).toBe('skeleton_ready');
  });
});
