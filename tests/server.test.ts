import { McpServer } from '@modelcontextprotocol/server';
import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BRIDGE_NAME,
  BRIDGE_VERSION,
  getBridgeStatus,
} from '../src/server.js';
import { createTestStack, type TestStack } from './helpers/mcp.js';
import { FakeRuntimeAdapter } from './helpers/fakes.js';

const stacks: TestStack[] = [];

async function stack(adapter = new FakeRuntimeAdapter()) {
  const s = await createTestStack(adapter);
  stacks.push(s);
  return s;
}

afterEach(async () => {
  const s = stacks.splice(0);
  await Promise.all(
    s.map(async (x) => {
      await x.client.close();
      await x.server.close();
      await rm(x.dataDir, { recursive: true, force: true });
    }),
  );
});

describe('createServer', () => {
  it('creates an McpServer instance', async () => {
    const { server, client } = await stack();
    expect(server).toBeInstanceOf(McpServer);
    expect(client.getServerVersion()).toEqual({
      name: BRIDGE_NAME,
      version: BRIDGE_VERSION,
    });
  });

  it('bridge_status returns the honest status via content and structuredContent', async () => {
    const { client } = await stack();
    const result = await client.callTool({ name: 'bridge_status', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      name: BRIDGE_NAME,
      version: BRIDGE_VERSION,
      status: 'ready',
      runtime: 'codex',
      runtimeConnected: true,
      sessionOrchestrationAvailable: true,
      managedWorkers: 0,
    });

    const text = result.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('');
    expect(JSON.parse(text)).toEqual(result.structuredContent);
  });
});

describe('getBridgeStatus', () => {
  it('reflects runtime connectivity honestly', async () => {
    const { deps } = await stack();
    const status = getBridgeStatus(deps);
    expect(status.runtimeConnected).toBe(true);
    expect(status.sessionOrchestrationAvailable).toBe(true);
    expect(status.status).toBe('ready');
  });
});
