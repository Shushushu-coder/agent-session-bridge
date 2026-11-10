import { rm } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { BOARD_RESOURCE_URI } from '../src/server.js';
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

interface SnapshotBody {
  generatedAt: string;
  runtimeConnected: boolean;
  workerCount: number;
  workers: {
    workerId: string;
    state: string;
    taskCount: number;
    activeTaskId: string | null;
    usageTotals: { output_tokens: number } | null;
    latestTask: { taskId: string; status: string; progressCount: number } | null;
    resumeHint: string | null;
  }[];
  recentTasks: { taskId: string; workerId: string; status: string }[];
  recentBatches: {
    batchId: string;
    dispatchedCount: number;
    statusCounts: Record<string, number>;
    allSettled: boolean;
    allCompleted: boolean;
  }[];
}

describe('board MCP tools', () => {
  it('aggregates workers, their latest task, usage totals, and batch summaries', async () => {
    const adapter = new FakeRuntimeAdapter();
    const stack = await createTestStack(adapter);
    stacks.push(stack);
    const backend = await makeWorker(stack, 'backend');
    const frontend = await makeWorker(stack, 'frontend');

    const empty = await stack.client.callTool({ name: 'get_board_snapshot', arguments: {} });
    const emptyBody = empty.structuredContent as SnapshotBody;
    expect(emptyBody.runtimeConnected).toBe(true);
    expect(emptyBody.workerCount).toBe(2);
    for (const w of emptyBody.workers) {
      expect(w.taskCount).toBe(0);
      expect(w.activeTaskId).toBeNull();
      expect(w.latestTask).toBeNull();
      expect(w.usageTotals).toBeNull();
    }
    expect(emptyBody.recentBatches).toEqual([]);

    const dispatched = await stack.client.callTool({
      name: 'dispatch_worker_batch',
      arguments: {
        requestKey: 'board-batch-1',
        tasks: [
          { workerId: backend, message: 'audit backend' },
          { workerId: frontend, message: 'audit frontend' },
        ],
      },
    });
    const batchId = (dispatched.structuredContent as { batchId: string }).batchId;
    const taskIds = (dispatched.structuredContent as { tasks: { taskId: string }[] }).tasks.map(
      (t) => t.taskId,
    );
    await Promise.all(taskIds.map((id) => stack.deps.manager.whenTaskSettled(id)));

    const snap = await stack.client.callTool({ name: 'get_board_snapshot', arguments: {} });
    const body = snap.structuredContent as SnapshotBody;
    expect(body.workerCount).toBe(2);
    const byId = new Map(body.workers.map((w) => [w.workerId, w]));
    for (const workerId of [backend, frontend]) {
      const w = byId.get(workerId)!;
      expect(w.state).toBe('ready');
      expect(w.taskCount).toBe(1);
      expect(w.activeTaskId).toBeNull();
      expect(w.latestTask?.status).toBe('completed');
      expect(w.latestTask?.progressCount).toBeGreaterThan(0);
      expect(w.usageTotals?.output_tokens).toBeGreaterThan(0);
    }
    expect(body.recentTasks.length).toBe(2);
    expect(body.recentTasks.every((t) => t.status === 'completed')).toBe(true);
    expect(new Set(body.recentTasks.map((t) => t.workerId))).toEqual(
      new Set([backend, frontend]),
    );
    expect(body.recentBatches).toHaveLength(1);
    expect(body.recentBatches[0]).toMatchObject({
      batchId,
      dispatchedCount: 2,
      allSettled: true,
      allCompleted: true,
    });
    expect(body.recentBatches[0]!.statusCounts.completed).toBe(2);
  });

  it('reports the live task on a worker while a turn is in flight', async () => {
    const adapter = new FakeRuntimeAdapter();
    let release!: () => void;
    adapter.streamHold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stack = await createTestStack(adapter);
    stacks.push(stack);
    const workerId = await makeWorker(stack, 'slow');

    const dispatched = await stack.client.callTool({
      name: 'dispatch_worker_task',
      arguments: { workerId, message: 'long audit', requestKey: 'board-live-1' },
    });
    const taskId = (dispatched.structuredContent as { taskId: string }).taskId;

    // Wait until the task is actually running, not just accepted.
    let live: SnapshotBody | null = null;
    for (let i = 0; i < 50; i += 1) {
      const snap = await stack.client.callTool({ name: 'get_board_snapshot', arguments: {} });
      live = snap.structuredContent as SnapshotBody;
      if (live.workers[0]?.latestTask?.status === 'running') break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const w = live!.workers[0]!;
    expect(w.activeTaskId).toBe(taskId);
    expect(w.state).toBe('busy');
    expect(w.latestTask?.status).toBe('running');
    expect(w.resumeHint).toBeNull();

    release();
    await stack.deps.manager.whenTaskSettled(taskId);
    const settled = await stack.client.callTool({ name: 'get_board_snapshot', arguments: {} });
    const done = (settled.structuredContent as SnapshotBody).workers[0]!;
    expect(done.activeTaskId).toBeNull();
    expect(done.latestTask?.status).toBe('completed');
  });

  it('exposes the board resource with the app mime type and wires ui meta on the tool', async () => {
    const adapter = new FakeRuntimeAdapter();
    const stack = await createTestStack(adapter);
    stacks.push(stack);

    const tools = await stack.client.listTools();
    const opener = tools.tools.find((t) => t.name === 'open_worker_board');
    expect(opener).toBeDefined();
    const meta = opener!._meta as { ui?: { resourceUri?: string } } | undefined;
    expect(meta?.ui?.resourceUri).toBe(BOARD_RESOURCE_URI);

    const called = await stack.client.callTool({ name: 'open_worker_board', arguments: {} });
    expect(called.isError).toBeFalsy();
    expect((called.structuredContent as SnapshotBody).workerCount).toBe(0);

    const resource = await stack.client.readResource({ uri: BOARD_RESOURCE_URI });
    expect(resource.contents).toHaveLength(1);
    const item = resource.contents[0]!;
    expect(item.mimeType).toBe('text/html;profile=mcp-app');
    expect(item.uri).toBe(BOARD_RESOURCE_URI);
    const text = 'text' in item ? item.text : '';
    expect(text).toContain('<div id="app">');
    expect(text).toContain('get_board_snapshot');
  });
});
