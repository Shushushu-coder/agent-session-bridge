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

async function makeWorker(stack: TestStack, name: string): Promise<string> {
  const created = await stack.client.callTool({
    name: 'create_worker',
    arguments: { name, workspacePath: `E:\\ws-${name}` },
  });
  return (created.structuredContent as { worker: { workerId: string } }).worker.workerId;
}

describe('batch MCP tools', () => {
  it('dispatches a batch, polls its status, and reads member results', async () => {
    const adapter = new FakeRuntimeAdapter();
    const stack = await createTestStack(adapter);
    stacks.push(stack);
    const backend = await makeWorker(stack, 'backend');
    const frontend = await makeWorker(stack, 'frontend');
    const reviewer = await makeWorker(stack, 'reviewer');

    const dispatched = await stack.client.callTool({
      name: 'dispatch_worker_batch',
      arguments: {
        requestKey: 'batch-review-001',
        tasks: [
          { workerId: backend, message: 'Read-only audit of backend services.' },
          { workerId: frontend, message: 'Read-only audit of frontend components.' },
          { workerId: reviewer, message: 'Read-only architecture review.' },
        ],
      },
    });
    expect(dispatched.isError).toBeFalsy();
    expect(dispatched.structuredContent).toMatchObject({
      requestKey: 'batch-review-001',
      replayed: false,
      dispatchedCount: 3,
      rejectedCount: 0,
    });
    const batchId = (dispatched.structuredContent as { batchId: string }).batchId;
    expect(batchId).toMatch(/^batch_/);
    const taskIds = (
      dispatched.structuredContent as { tasks: { taskId: string | null }[] }
    ).tasks.map((entry) => entry.taskId!);

    let settled = false;
    for (let attempt = 0; attempt < 50 && !settled; attempt += 1) {
      const status = await stack.client.callTool({
        name: 'get_batch_status',
        arguments: { batchId },
      });
      const body = status.structuredContent as {
        allSettled: boolean;
        statusCounts: Record<string, number>;
      };
      settled = body.allSettled;
      if (!settled) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(settled).toBe(true);
    await Promise.all(taskIds.map((id) => stack.deps.manager.whenTaskSettled(id)));

    const results = await stack.client.callTool({
      name: 'get_batch_results',
      arguments: { batchId },
    });
    expect(results.isError).toBeFalsy();
    const body = results.structuredContent as {
      allCompleted: boolean;
      resultCounts: Record<string, number>;
      usageTotals: { input_tokens: number } | null;
      tasks: {
        workerId: string;
        taskId: string;
        status: string;
        response: string | null;
        truncated: boolean;
        nativeThreadId: string | null;
      }[];
    };
    expect(body.allCompleted).toBe(true);
    expect(body.resultCounts).toMatchObject({ completed: 3, notReady: 0 });
    expect(body.usageTotals).not.toBeNull();
    const byWorker = new Map(body.tasks.map((entry) => [entry.workerId, entry]));
    expect(byWorker.get(backend)?.response).toBe(
      'FAKE_ASYNC:Read-only audit of backend services.',
    );
    expect(byWorker.get(frontend)?.response).toBe(
      'FAKE_ASYNC:Read-only audit of frontend components.',
    );
    expect(byWorker.get(reviewer)?.response).toBe('FAKE_ASYNC:Read-only architecture review.');
    for (const entry of body.tasks) {
      expect(entry.taskId).toMatch(/^task_/);
      expect(entry.truncated).toBe(false);
      expect(entry.nativeThreadId).toBe('thread_fake_async');
    }
  });

  it('rejects a duplicate worker member and an unknown batch id as tool errors', async () => {
    const adapter = new FakeRuntimeAdapter();
    const stack = await createTestStack(adapter);
    stacks.push(stack);
    const workerId = await makeWorker(stack, 'only');

    const missing = await stack.client.callTool({
      name: 'get_batch_status',
      arguments: { batchId: 'batch_none' },
    });
    expect(missing.isError).toBe(true);
    expect(JSON.stringify(missing.structuredContent)).toContain('BATCH_NOT_FOUND');

    const dispatched = await stack.client.callTool({
      name: 'dispatch_worker_batch',
      arguments: {
        requestKey: 'batch-dup',
        tasks: [
          { workerId, message: 'one' },
          { workerId, message: 'two' },
        ],
      },
    });
    expect(dispatched.isError).toBeFalsy();
    const body = dispatched.structuredContent as {
      tasks: { taskId: string | null; dispatchStatus: string; errorCategory: string | null }[];
    };
    expect(body.tasks[1]).toMatchObject({
      dispatchStatus: 'rejected',
      errorCategory: 'DUPLICATE_WORKER',
    });
    const acceptedIds = body.tasks
      .filter((entry) => entry.taskId !== null)
      .map((entry) => entry.taskId!);
    await Promise.all(acceptedIds.map((id) => stack.deps.manager.whenTaskSettled(id)));

    const conflict = await stack.client.callTool({
      name: 'dispatch_worker_batch',
      arguments: {
        requestKey: 'batch-dup',
        tasks: [{ workerId, message: 'different' }],
      },
    });
    expect(conflict.isError).toBe(true);
    expect(JSON.stringify(conflict.structuredContent)).toContain('REQUEST_KEY_CONFLICT');

    const replay = await stack.client.callTool({
      name: 'dispatch_worker_batch',
      arguments: {
        requestKey: 'batch-dup',
        tasks: [
          { workerId, message: 'one' },
          { workerId, message: 'two' },
        ],
      },
    });
    expect(replay.isError).toBeFalsy();
    expect(replay.structuredContent).toMatchObject({ replayed: true });
  });
});
