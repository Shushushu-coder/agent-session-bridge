import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestStack, type TestStack } from './helpers/mcp.js';
import { FakeRuntimeAdapter } from './helpers/fakes.js';

const stacks: TestStack[] = [];

afterEach(async () => {
  const pending = stacks.splice(0);
  await Promise.all(
    pending.map(async (entry) => {
      await entry.client.close();
      await entry.server.close();
      await rm(entry.dataDir, { recursive: true, force: true });
    }),
  );
});

describe('async task MCP tools', () => {
  it('dispatches without waiting and then returns the stored result', async () => {
    const adapter = new FakeRuntimeAdapter();
    let release: () => void = () => {};
    adapter.streamHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stack = await createTestStack(adapter);
    stacks.push(stack);

    const created = await stack.client.callTool({
      name: 'create_worker',
      arguments: { name: 'async', workspacePath: 'E:\\ws' },
    });
    const workerId = (created.structuredContent as { worker: { workerId: string } }).worker.workerId;

    const dispatched = await stack.client.callTool({
      name: 'dispatch_worker_task',
      arguments: { workerId, message: 'inspect only', requestKey: 'mcp-req-1' },
    });
    expect(dispatched.isError).toBeFalsy();
    expect(dispatched.structuredContent).toMatchObject({
      workerId,
      status: 'accepted',
      replayed: false,
    });
    const taskId = (dispatched.structuredContent as { taskId: string }).taskId;

    const early = await stack.client.callTool({
      name: 'get_task_result',
      arguments: { taskId },
    });
    expect(early.structuredContent).toMatchObject({ status: 'NOT_READY', response: null });

    release();
    let finalStatus = '';
    for (let attempt = 0; attempt < 50 && finalStatus !== 'completed'; attempt += 1) {
      const status = await stack.client.callTool({
        name: 'get_task_status',
        arguments: { taskId },
      });
      finalStatus = (status.structuredContent as { status: string }).status;
      if (finalStatus !== 'completed') await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const result = await stack.client.callTool({
      name: 'get_task_result',
      arguments: { taskId },
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      status: 'completed',
      response: 'FAKE_ASYNC:inspect only',
      nativeThreadId: 'thread_fake_async',
    });
  });

  it('returns tool errors for a missing task, a busy worker, and a requestKey conflict', async () => {
    const adapter = new FakeRuntimeAdapter();
    let release: () => void = () => {};
    adapter.streamHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stack = await createTestStack(adapter);
    stacks.push(stack);
    const created = await stack.client.callTool({
      name: 'create_worker',
      arguments: { name: 'async', workspacePath: 'E:\\ws' },
    });
    const workerId = (created.structuredContent as { worker: { workerId: string } }).worker.workerId;

    const missing = await stack.client.callTool({
      name: 'get_task_status',
      arguments: { taskId: 'task_missing' },
    });
    expect(missing.isError).toBe(true);

    await stack.client.callTool({
      name: 'dispatch_worker_task',
      arguments: { workerId, message: 'first', requestKey: 'once' },
    });
    const busy = await stack.client.callTool({
      name: 'dispatch_worker_task',
      arguments: { workerId, message: 'second', requestKey: 'twice' },
    });
    expect(busy.isError).toBe(true);
    expect(JSON.stringify(busy.structuredContent)).toContain('WORKER_BUSY');

    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const conflict = await stack.client.callTool({
      name: 'dispatch_worker_task',
      arguments: { workerId, message: 'other', requestKey: 'once' },
    });
    expect(conflict.isError).toBe(true);
    expect(JSON.stringify(conflict.structuredContent)).toContain('REQUEST_KEY_CONFLICT');
  });
});
