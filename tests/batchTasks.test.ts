import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeStreamEvent } from '../src/contracts/runtime.js';
import type { TaskUsage } from '../src/contracts/task.js';
import { SessionRegistry } from '../src/storage/sessionRegistry.js';
import { TaskStore } from '../src/storage/taskStore.js';
import { WorkerManager, WorkerToolError } from '../src/workers/workerManager.js';
import { FAKE_STREAM_USAGE, FakeRuntimeAdapter } from './helpers/fakes.js';

let dir: string;
let registry: SessionRegistry;
let taskStore: TaskStore;
let adapter: FakeRuntimeAdapter;
let manager: WorkerManager;

function hold(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function makeManager(maxBatchTasks?: number): Promise<WorkerManager> {
  return new WorkerManager({
    registry,
    taskStore,
    adapter,
    verifyWorkspace: async (workspacePath) => ({ ok: true, resolvedPath: workspacePath }),
    ...(maxBatchTasks !== undefined ? { maxBatchTasks } : {}),
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wsb-batch-'));
  registry = await SessionRegistry.open(join(dir, 'workers.json'));
  taskStore = await TaskStore.open(join(dir, 'tasks.json'));
  adapter = new FakeRuntimeAdapter();
  manager = await makeManager();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function settled(batchId: string): Promise<void> {
  const batch = taskStore.getBatch(batchId)!;
  await Promise.all(
    batch.tasks
      .filter((entry) => entry.taskId !== null)
      .map((entry) => manager.whenTaskSettled(entry.taskId!)),
  );
}

describe('multi-worker batch dispatch', () => {
  it('runs three workers truly in parallel and returns before they finish', async () => {
    const gate = hold();
    let active = 0;
    let maxActive = 0;
    adapter.streamImpl = async function* (): AsyncGenerator<RuntimeStreamEvent> {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await gate.promise;
        yield { type: 'turn.completed', usage: { ...FAKE_STREAM_USAGE } };
      } finally {
        active -= 1;
      }
    };
    const workers = await Promise.all([
      manager.createWorker({ name: 'backend', workspacePath: 'E:\\be' }),
      manager.createWorker({ name: 'frontend', workspacePath: 'E:\\fe' }),
      manager.createWorker({ name: 'reviewer', workspacePath: 'E:\\rev' }),
    ]);

    const batch = await manager.dispatchBatch('batch-1', [
      { workerId: workers[0]!.workerId, message: 'audit backend' },
      { workerId: workers[1]!.workerId, message: 'audit frontend' },
      { workerId: workers[2]!.workerId, message: 'review architecture' },
    ]);

    // The batch call returned while every turn was still gated: nothing
    // completed and every member was accepted with its own task id.
    expect(batch.replayed).toBe(false);
    expect(batch.batchId).toMatch(/^batch_/);
    expect(batch.dispatchedCount).toBe(3);
    expect(batch.rejectedCount).toBe(0);
    expect(new Set(batch.tasks.map((entry) => entry.taskId)).size).toBe(3);
    expect(manager.getBatchStatus(batch.batchId).statusCounts.completed).toBe(0);

    await waitFor(() => maxActive === 3, 'three overlapping streams');
    gate.release();
    await settled(batch.batchId);

    expect(maxActive).toBe(3);
    const status = manager.getBatchStatus(batch.batchId);
    expect(status.statusCounts).toMatchObject({ completed: 3, running: 0, accepted: 0 });
    expect(status.allSettled).toBe(true);
    expect(status.allCompleted).toBe(true);
  });

  it('keeps each worker reply, thread id, and usage on its own task', async () => {
    adapter.streamImpl = (_sessionId, agentTask) =>
      (async function* (): AsyncGenerator<RuntimeStreamEvent> {
        yield { type: 'thread.started', threadId: `thread_${agentTask.prompt}` };
        yield {
          type: 'item.completed',
          itemType: 'agent_message',
          text: `reply:${agentTask.prompt}`,
        };
        yield {
          type: 'turn.completed',
          usage: {
            input_tokens: 1,
            cached_input_tokens: 0,
            cache_write_input_tokens: 0,
            output_tokens: 1,
            reasoning_output_tokens: 0,
          },
        };
      })();
    const a = await manager.createWorker({ name: 'a', workspacePath: 'E:\\a' });
    const b = await manager.createWorker({ name: 'b', workspacePath: 'E:\\b' });

    const batch = await manager.dispatchBatch('batch-iso', [
      { workerId: a.workerId, message: 'alpha' },
      { workerId: b.workerId, message: 'beta' },
    ]);
    await settled(batch.batchId);

    const results = manager.getBatchResults(batch.batchId);
    const byWorker = new Map(results.tasks.map((entry) => [entry.workerId, entry]));
    expect(byWorker.get(a.workerId)).toMatchObject({
      status: 'completed',
      response: 'reply:alpha',
      nativeThreadId: 'thread_alpha',
    });
    expect(byWorker.get(b.workerId)).toMatchObject({
      status: 'completed',
      response: 'reply:beta',
      nativeThreadId: 'thread_beta',
    });
    expect(results.usageTotals).toMatchObject({ input_tokens: 2, output_tokens: 2 });
    expect(manager.getWorker(a.workerId).threadId).toBe('thread_alpha');
    expect(manager.getWorker(b.workerId).threadId).toBe('thread_beta');
  });

  it('rejects a repeated workerId without rejecting its siblings', async () => {
    const a = await manager.createWorker({ name: 'a', workspacePath: 'E:\\a' });
    const b = await manager.createWorker({ name: 'b', workspacePath: 'E:\\b' });

    const batch = await manager.dispatchBatch('batch-dup', [
      { workerId: a.workerId, message: 'first' },
      { workerId: a.workerId, message: 'second on same worker' },
      { workerId: b.workerId, message: 'third' },
    ]);
    await settled(batch.batchId);

    expect(batch.dispatchedCount).toBe(2);
    expect(batch.rejectedCount).toBe(1);
    expect(batch.tasks[1]).toMatchObject({
      workerId: a.workerId,
      taskId: null,
      dispatchStatus: 'rejected',
      errorCategory: 'DUPLICATE_WORKER',
    });
    expect(taskStore.list()).toHaveLength(2);
    const status = manager.getBatchStatus(batch.batchId);
    expect(status.allCompleted).toBe(true);
    expect(status.tasks[1]?.dispatchStatus).toBe('rejected');
  });

  it('rejects members beyond the configured parallel cap', async () => {
    manager = await makeManager(2);
    const a = await manager.createWorker({ name: 'a', workspacePath: 'E:\\a' });
    const b = await manager.createWorker({ name: 'b', workspacePath: 'E:\\b' });
    const c = await manager.createWorker({ name: 'c', workspacePath: 'E:\\c' });

    const batch = await manager.dispatchBatch('batch-cap', [
      { workerId: a.workerId, message: 'one' },
      { workerId: b.workerId, message: 'two' },
      { workerId: c.workerId, message: 'three' },
    ]);
    await settled(batch.batchId);

    expect(batch.dispatchedCount).toBe(2);
    expect(batch.tasks[2]).toMatchObject({
      workerId: c.workerId,
      taskId: null,
      dispatchStatus: 'rejected',
      errorCategory: 'BATCH_LIMIT_EXCEEDED',
    });
  });

  it('keeps sibling tasks when one worker is busy and another is unknown', async () => {
    const gate = hold();
    adapter.streamHold = gate.promise;
    const busyWorker = await manager.createWorker({ name: 'busy', workspacePath: 'E:\\a' });
    const freeWorker = await manager.createWorker({ name: 'free', workspacePath: 'E:\\b' });
    const running = await manager.dispatchTask(busyWorker.workerId, 'already running', 'pre-1');
    await waitFor(
      () => manager.getTaskStatus(running.taskId).status === 'running',
      'pre-existing task running',
    );

    const batch = await manager.dispatchBatch('batch-partial', [
      { workerId: busyWorker.workerId, message: 'blocked' },
      { workerId: 'wrk_missing', message: 'nobody home' },
      { workerId: freeWorker.workerId, message: 'goes through' },
    ]);

    expect(batch.dispatchedCount).toBe(1);
    expect(batch.rejectedCount).toBe(2);
    expect(batch.tasks[0]).toMatchObject({
      dispatchStatus: 'rejected',
      errorCategory: 'WORKER_BUSY',
    });
    expect(batch.tasks[1]).toMatchObject({
      dispatchStatus: 'rejected',
      errorCategory: 'WORKER_NOT_FOUND',
    });
    const accepted = batch.tasks[2]!;
    expect(accepted.dispatchStatus).toBe('accepted');
    expect(accepted.taskId).toMatch(/^task_/);

    // The partial batch is fully queryable while work is still in flight.
    const status = manager.getBatchStatus(batch.batchId);
    expect(status.dispatchedCount).toBe(1);
    expect(status.rejectedCount).toBe(2);
    expect(status.allSettled).toBe(false);

    gate.release();
    await settled(batch.batchId);
    await manager.whenTaskSettled(running.taskId);
    expect(manager.getTaskResult(accepted.taskId!)).toMatchObject({
      status: 'completed',
      response: 'FAKE_ASYNC:goes through',
    });
  });

  it('keeps sibling state when one member fails at runtime', async () => {
    adapter.streamImpl = (_sessionId, agentTask) =>
      (async function* (): AsyncGenerator<RuntimeStreamEvent> {
        if (agentTask.prompt === 'bad') {
          yield { type: 'turn.failed', message: 'kaboom' };
          return;
        }
        yield {
          type: 'item.completed',
          itemType: 'agent_message',
          text: `FAKE_ASYNC:${agentTask.prompt}`,
        };
        yield { type: 'turn.completed', usage: { ...FAKE_STREAM_USAGE } };
      })();
    const a = await manager.createWorker({ name: 'a', workspacePath: 'E:\\a' });
    const b = await manager.createWorker({ name: 'b', workspacePath: 'E:\\b' });
    const c = await manager.createWorker({ name: 'c', workspacePath: 'E:\\c' });

    const batch = await manager.dispatchBatch('batch-mixed', [
      { workerId: a.workerId, message: 'good' },
      { workerId: b.workerId, message: 'bad' },
      { workerId: c.workerId, message: 'good' },
    ]);
    await settled(batch.batchId);

    const status = manager.getBatchStatus(batch.batchId);
    expect(status.statusCounts).toMatchObject({ completed: 2, failed: 1 });
    expect(status.allSettled).toBe(true);
    expect(status.allCompleted).toBe(false);

    const results = manager.getBatchResults(batch.batchId);
    expect(results.resultCounts).toMatchObject({ completed: 2, failed: 1, notReady: 0 });
    expect(results.allCompleted).toBe(false);
    const failed = results.tasks.find((entry) => entry.workerId === b.workerId)!;
    expect(failed).toMatchObject({ status: 'failed', response: null });
    expect(failed.errorCategory).toBe('turn_failed');
    // A failure on one member neither erased nor rewrote sibling results.
    expect(results.tasks.find((entry) => entry.workerId === a.workerId)?.response).toBe(
      'FAKE_ASYNC:good',
    );
  });

  it('reports NOT_READY members without inventing results', async () => {
    const gate = hold();
    adapter.streamHold = gate.promise;
    const a = await manager.createWorker({ name: 'a', workspacePath: 'E:\\a' });
    const b = await manager.createWorker({ name: 'b', workspacePath: 'E:\\b' });

    const batch = await manager.dispatchBatch('batch-live', [
      { workerId: a.workerId, message: 'one' },
      { workerId: b.workerId, message: 'two' },
    ]);
    await waitFor(
      () => manager.getBatchStatus(batch.batchId).statusCounts.running === 2,
      'both running',
    );

    const results = manager.getBatchResults(batch.batchId);
    expect(results.allSettled).toBe(false);
    expect(results.resultCounts.notReady).toBe(2);
    for (const entry of results.tasks) {
      expect(entry.status).toBe('NOT_READY');
      expect(entry.response).toBeNull();
      expect(entry.usage).toBeNull();
    }
    gate.release();
    await settled(batch.batchId);
  });

  it('replays an identical batch and conflicts on different content for the same key', async () => {
    const a = await manager.createWorker({ name: 'a', workspacePath: 'E:\\a' });
    const b = await manager.createWorker({ name: 'b', workspacePath: 'E:\\b' });
    const inputs = [
      { workerId: a.workerId, message: 'one' },
      { workerId: b.workerId, message: 'two' },
    ];
    const first = await manager.dispatchBatch('batch-key', inputs);
    await settled(first.batchId);

    const replay = await manager.dispatchBatch('batch-key', inputs);
    expect(replay).toMatchObject({ batchId: first.batchId, replayed: true });
    expect(replay.tasks.map((entry) => entry.taskId)).toEqual(
      first.tasks.map((entry) => entry.taskId),
    );
    // The replay reports the stored dispatch outcome, not a re-execution.
    expect(adapter.calls.filter((call) => call.method === 'runTaskStreamed')).toHaveLength(2);

    await expect(
      manager.dispatchBatch('batch-key', [{ workerId: a.workerId, message: 'one' }]),
    ).rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' } satisfies Partial<WorkerToolError>);
    expect(adapter.calls.filter((call) => call.method === 'runTaskStreamed')).toHaveLength(2);
  });

  it('does not let a task requestKey collide with a batch requestKey', async () => {
    const a = await manager.createWorker({ name: 'a', workspacePath: 'E:\\a' });
    const lone = await manager.dispatchTask(a.workerId, 'lone', 'shared-key');
    await manager.whenTaskSettled(lone.taskId);
    await expect(
      manager.dispatchBatch('shared-key', [{ workerId: a.workerId, message: 'lone' }]),
    ).rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' } satisfies Partial<WorkerToolError>);

    const claimed = await manager.dispatchBatch('batch-claim', [
      { workerId: a.workerId, message: 'x' },
    ]);
    await settled(claimed.batchId);
    await expect(
      manager.dispatchTask(a.workerId, 'x', 'batch-claim'),
    ).rejects.toMatchObject({ code: 'REQUEST_KEY_CONFLICT' } satisfies Partial<WorkerToolError>);
  });

  it('persists the batch mapping and member results across a store reopen', async () => {
    adapter.streamImpl = (_sessionId, agentTask) =>
      (async function* (): AsyncGenerator<RuntimeStreamEvent> {
        yield { type: 'thread.started', threadId: `thread_${agentTask.prompt}` };
        yield {
          type: 'item.completed',
          itemType: 'agent_message',
          text: `reply:${agentTask.prompt}`,
        };
        yield { type: 'turn.completed', usage: { ...FAKE_STREAM_USAGE } };
      })();
    const a = await manager.createWorker({ name: 'a', workspacePath: 'E:\\a' });
    const b = await manager.createWorker({ name: 'b', workspacePath: 'E:\\b' });
    const batch = await manager.dispatchBatch('batch-persist', [
      { workerId: a.workerId, message: 'alpha' },
      { workerId: b.workerId, message: 'beta' },
    ]);
    await settled(batch.batchId);
    const storedIds = batch.tasks.map((entry) => entry.taskId);

    const reloadedStore = await TaskStore.open(join(dir, 'tasks.json'));
    const reloadedRegistry = await SessionRegistry.open(join(dir, 'workers.json'));
    const nextAdapter = new FakeRuntimeAdapter();
    const next = new WorkerManager({
      registry: reloadedRegistry,
      taskStore: reloadedStore,
      adapter: nextAdapter,
      verifyWorkspace: async (workspacePath) => ({ ok: true, resolvedPath: workspacePath }),
    });

    const status = next.getBatchStatus(batch.batchId);
    expect(status.allCompleted).toBe(true);
    expect(status.tasks.map((entry) => entry.taskId)).toEqual(storedIds);

    const results = next.getBatchResults(batch.batchId);
    expect(results.tasks.map((entry) => entry.response)).toEqual(['reply:alpha', 'reply:beta']);
    expect(nextAdapter.calls).toEqual([]);

    // The batch requestKey also survives: replay returns the stored batch.
    const replay = await next.dispatchBatch('batch-persist', [
      { workerId: a.workerId, message: 'alpha' },
      { workerId: b.workerId, message: 'beta' },
    ]);
    expect(replay).toMatchObject({ batchId: batch.batchId, replayed: true });
    expect(nextAdapter.calls).toEqual([]);
  });

  it('marks an interrupted batch member unknown on reopen without re-dispatching', async () => {
    const a = await manager.createWorker({ name: 'a', workspacePath: 'E:\\a' });
    const now = new Date().toISOString();
    await writeFile(
      join(dir, 'tasks.json'),
      JSON.stringify({
        schemaVersion: 1,
        tasks: [
          {
            taskId: 'task_inflight',
            workerId: a.workerId,
            requestKey: 'batch-x#a',
            requestFingerprint: 'fp',
            status: 'running',
            createdAt: now,
            startedAt: now,
            updatedAt: now,
            completedAt: null,
            nativeThreadId: null,
            progress: [],
            result: null,
            usage: null,
            error: null,
          },
        ],
        batches: [
          {
            batchId: 'batch_x',
            requestKey: 'batch-x',
            requestFingerprint: 'fpb',
            createdAt: now,
            tasks: [{ workerId: a.workerId, taskId: 'task_inflight', dispatchStatus: 'accepted' }],
          },
        ],
      }),
      'utf8',
    );

    const reloaded = await TaskStore.open(join(dir, 'tasks.json'));
    expect(reloaded.getBatch('batch_x')).toMatchObject({ requestKey: 'batch-x' });
    expect(reloaded.get('task_inflight')?.status).toBe('unknown');

    const next = new WorkerManager({
      registry: await SessionRegistry.open(join(dir, 'workers.json')),
      taskStore: reloaded,
      adapter: new FakeRuntimeAdapter(),
      verifyWorkspace: async (workspacePath) => ({ ok: true, resolvedPath: workspacePath }),
    });
    const status = next.getBatchStatus('batch_x');
    expect(status.statusCounts.unknown).toBe(1);
    expect(status.allSettled).toBe(true);
    expect(status.allCompleted).toBe(false);
    const results = next.getBatchResults('batch_x');
    expect(results.tasks[0]).toMatchObject({ status: 'unknown', response: null });
  });

  it('truncates a long member response and points to get_task_result', async () => {
    const longText = 'x'.repeat(9000);
    adapter.streamImpl = async function* (): AsyncGenerator<RuntimeStreamEvent> {
      yield { type: 'item.completed', itemType: 'agent_message', text: longText };
      yield { type: 'turn.completed', usage: { ...FAKE_STREAM_USAGE } };
    };
    const a = await manager.createWorker({ name: 'a', workspacePath: 'E:\\a' });
    const batch = await manager.dispatchBatch('batch-long', [
      { workerId: a.workerId, message: 'long' },
    ]);
    await settled(batch.batchId);

    const entry = manager.getBatchResults(batch.batchId).tasks[0]!;
    expect(entry.truncated).toBe(true);
    expect(entry.responseLength).toBe(9000);
    expect(entry.response!.length).toBeLessThan(9000);
    expect(manager.getTaskResult(entry.taskId!).response).toBe(longText);
  });

  it('reports BATCH_NOT_FOUND for unknown batch ids', async () => {
    await expect(manager.dispatchBatch('k', [])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    } satisfies Partial<WorkerToolError>);
    expect(() => manager.getBatchStatus('batch_none')).toThrowError(
      expect.objectContaining({ code: 'BATCH_NOT_FOUND' }) as Error,
    );
    expect(() => manager.getBatchResults('batch_none')).toThrowError(
      expect.objectContaining({ code: 'BATCH_NOT_FOUND' }) as Error,
    );
  });

  it('never produces an unhandled rejection when batch members fail', async () => {
    const reasons: unknown[] = [];
    const onRejection = (reason: unknown) => {
      reasons.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    adapter.streamImpl = async function* (): AsyncGenerator<RuntimeStreamEvent> {
      throw new Error('stream blew up');
    };
    const a = await manager.createWorker({ name: 'a', workspacePath: 'E:\\a' });
    const b = await manager.createWorker({ name: 'b', workspacePath: 'E:\\b' });
    const batch = await manager.dispatchBatch('batch-crash', [
      { workerId: a.workerId, message: 'one' },
      { workerId: b.workerId, message: 'two' },
    ]);
    await settled(batch.batchId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off('unhandledRejection', onRejection);

    expect(reasons).toEqual([]);
    const status = manager.getBatchStatus(batch.batchId);
    expect(status.statusCounts.unknown).toBe(2);
  });
});
