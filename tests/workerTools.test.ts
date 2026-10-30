import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { createTestStack, textOf, type TestStack } from './helpers/mcp.js';
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

describe('worker MCP tools', () => {
  it('advertises the sync worker tools and the async task tools', async () => {
    const { client } = await stack();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'bridge_status',
      'create_worker',
      'dispatch_worker_task',
      'get_task_result',
      'get_task_status',
      'get_worker',
      'list_workers',
      'send_worker_message',
    ]);
  });

  it('bridge_status reports connected runtime and zero managed workers', async () => {
    const { client } = await stack();
    const result = await client.callTool({ name: 'bridge_status', arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: 'ready',
      runtimeConnected: true,
      sessionOrchestrationAvailable: true,
      managedWorkers: 0,
    });
  });

  it('bridge_status reports runtime_unavailable when the adapter is down', async () => {
    const adapter = new FakeRuntimeAdapter();
    adapter.connected = false;
    const { client } = await stack(adapter);
    const result = await client.callTool({ name: 'bridge_status', arguments: {} });
    expect(result.structuredContent).toMatchObject({
      status: 'runtime_unavailable',
      runtimeConnected: false,
      sessionOrchestrationAvailable: true,
    });
  });

  it('create_worker validates input and returns a pending worker', async () => {
    const { client } = await stack();

    const bad = await client.callTool({
      name: 'create_worker',
      arguments: { name: '', workspacePath: 'E:\\ws' },
    });
    expect(bad.isError).toBe(true);

    const result = await client.callTool({
      name: 'create_worker',
      arguments: { name: 'reviewer', workspacePath: 'E:\\ws' },
    });
    expect(result.isError).toBeFalsy();
    const worker = (result.structuredContent as { worker: { workerId: string } }).worker;
    expect(worker).toMatchObject({
      name: 'reviewer',
      runtime: 'codex',
      state: 'pending_initialization',
      threadId: null,
    });
    expect(worker.workerId).toMatch(/^wrk_/);
  });

  it('create_worker rejects a workspace that is not a git work tree', async () => {
    const s = await stack(new FakeRuntimeAdapter());
    // Re-wire manager with a failing verifier is done via stack creation;
    // simulate by creating a second stack with a rejecting verifier.
    await s.client.close();
    await s.server.close();

    const failing = await createTestStack(new FakeRuntimeAdapter(), async () => ({
      ok: false,
      error: 'not inside a git work tree',
    }));
    stacks.push(failing);
    const result = await failing.client.callTool({
      name: 'create_worker',
      arguments: { name: 'w', workspacePath: 'E:\\nope' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('INVALID_WORKSPACE');
  });

  it('get_worker returns WORKER_NOT_FOUND as a tool error', async () => {
    const { client } = await stack();
    const result = await client.callTool({
      name: 'get_worker',
      arguments: { workerId: 'wrk_nope' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('WORKER_NOT_FOUND');
  });

  it('send_worker_message completes a first turn and persists the thread id', async () => {
    const adapter = new FakeRuntimeAdapter();
    adapter.nextResults.push({
      taskId: '',
      sessionId: '',
      status: 'succeeded',
      output: 'done',
      externalSessionId: 'thread_tool_1',
      completedAt: new Date().toISOString(),
    });
    const { client, deps } = await stack(adapter);

    const created = await client.callTool({
      name: 'create_worker',
      arguments: { name: 'w', workspacePath: 'E:\\ws' },
    });
    const { worker } = created.structuredContent as { worker: { workerId: string } };

    const sent = await client.callTool({
      name: 'send_worker_message',
      arguments: { workerId: worker.workerId, message: 'hello' },
    });
    expect(sent.isError).toBeFalsy();
    expect(sent.structuredContent).toMatchObject({
      workerId: worker.workerId,
      status: 'completed',
      state: 'ready',
      threadId: 'thread_tool_1',
      response: 'done',
    });

    // Registry file itself holds the durable mapping.
    const reloaded = await deps.registry.list();
    expect(reloaded[0]).toMatchObject({ threadId: 'thread_tool_1', state: 'ready' });
  });

  it('send_worker_message on unknown worker is a tool error', async () => {
    const { client } = await stack();
    const result = await client.callTool({
      name: 'send_worker_message',
      arguments: { workerId: 'wrk_ghost', message: 'hi' },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('WORKER_NOT_FOUND');
  });

  it('list_workers reflects live state including busy overlay', async () => {
    const adapter = new FakeRuntimeAdapter();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    adapter.runTaskImpl = async (_s, task) => {
      await gate;
      return {
        taskId: task.id,
        sessionId: task.sessionId,
        status: 'succeeded',
        externalSessionId: 'thread_x',
        completedAt: new Date().toISOString(),
      };
    };
    const { client } = await stack(adapter);
    const created = await client.callTool({
      name: 'create_worker',
      arguments: { name: 'w', workspacePath: 'E:\\ws' },
    });
    const { worker } = created.structuredContent as { worker: { workerId: string } };

    const pending = client.callTool({
      name: 'send_worker_message',
      arguments: { workerId: worker.workerId, message: 'slow' },
    });
    await new Promise((r) => setTimeout(r, 10));

    const listed = await client.callTool({ name: 'list_workers', arguments: {} });
    const workers = (listed.structuredContent as { workers: { state: string }[] }).workers;
    expect(workers[0]?.state).toBe('busy');

    release();
    const finished = await pending;
    expect(finished.structuredContent).toMatchObject({ status: 'completed' });
  });
});
