import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RuntimeStreamEvent } from '../src/contracts/runtime.js';
import type { TaskUsage } from '../src/contracts/task.js';
import { SessionRegistry } from '../src/storage/sessionRegistry.js';
import { TaskStore, requestFingerprint } from '../src/storage/taskStore.js';
import { WorkerManager, WorkerToolError } from '../src/workers/workerManager.js';
import { FAKE_STREAM_USAGE, FakeRuntimeAdapter } from './helpers/fakes.js';

let dir: string;
let registry: SessionRegistry;
let taskStore: TaskStore;
let adapter: FakeRuntimeAdapter;
let manager: WorkerManager;

const USAGE: TaskUsage = {
  input_tokens: 9,
  cached_input_tokens: 4,
  cache_write_input_tokens: 1,
  output_tokens: 3,
  reasoning_output_tokens: 2,
};

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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'asb-async-'));
  registry = await SessionRegistry.open(join(dir, 'workers.json'));
  taskStore = await TaskStore.open(join(dir, 'tasks.json'));
  adapter = new FakeRuntimeAdapter();
  manager = new WorkerManager({
    registry,
    taskStore,
    adapter,
    verifyWorkspace: async (workspacePath) => ({ ok: true, resolvedPath: workspacePath }),
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('asynchronous worker tasks', () => {
  it('returns a task id before the fake runtime finishes and then completes', async () => {
    const gate = hold();
    adapter.streamHold = gate.promise;
    const worker = await manager.createWorker({ name: 'w', workspacePath: 'E:\\ws' });

    const accepted = await manager.dispatchTask(worker.workerId, 'review', 'req-1');
    expect(accepted).toMatchObject({ status: 'accepted', replayed: false, workerId: worker.workerId });
    expect(accepted.taskId).toMatch(/^task_/);
    expect(manager.getTaskStatus(accepted.taskId).status).toBe('accepted');
    expect(adapter.calls.filter((call) => call.method === 'runTaskStreamed')).toHaveLength(0);

    await waitFor(() => manager.getTaskStatus(accepted.taskId).status === 'running', 'running');
    expect(manager.getTaskResult(accepted.taskId)).toMatchObject({
      status: 'NOT_READY',
      response: null,
    });

    gate.release();
    await manager.whenTaskSettled(accepted.taskId);

    const status = manager.getTaskStatus(accepted.taskId);
    expect(status.status).toBe('completed');
    expect(status.nativeThreadId).toBe('thread_fake_async');
    expect(status.progress.map((entry) => entry.kind)).toEqual([
      'thread.started',
      'turn.started',
      'item.started',
      'item.completed',
      'turn.completed',
    ]);
    expect(manager.getTaskResult(accepted.taskId)).toMatchObject({
      status: 'completed',
      response: 'FAKE_ASYNC:review',
      usage: FAKE_STREAM_USAGE,
      nativeThreadId: 'thread_fake_async',
      association: 'confirmed',
    });
    expect(manager.getWorker(worker.workerId)).toMatchObject({
      state: 'ready',
      threadId: 'thread_fake_async',
    });
    const raw = await readFile(join(dir, 'tasks.json'), 'utf8');
    expect(raw).not.toContain('turnId');
    expect(raw).not.toContain('"prompt"');
  });

  it('rejects a second task and a synchronous send while the worker is busy', async () => {
    const gate = hold();
    adapter.streamHold = gate.promise;
    const worker = await manager.createWorker({ name: 'w', workspacePath: 'E:\\ws' });
    const first = await manager.dispatchTask(worker.workerId, 'one', 'req-1');
    await waitFor(() => adapter.calls.some((call) => call.method === 'runTaskStreamed'), 'stream start');

    await expect(manager.dispatchTask(worker.workerId, 'two', 'req-2')).rejects.toMatchObject({
      code: 'WORKER_BUSY',
    } satisfies Partial<WorkerToolError>);
    const sync = await manager.sendMessage(worker.workerId, 'sync');
    expect(sync.status).toBe('busy');
    expect(adapter.calls.filter((call) => call.method === 'runTask')).toHaveLength(0);
    expect(taskStore.list()).toHaveLength(1);

    gate.release();
    await manager.whenTaskSettled(first.taskId);
    const after = await manager.sendMessage(worker.workerId, 'later');
    expect(after.status).toBe('completed');
  });

  it('keeps results on the task that produced them', async () => {
    adapter.streamImpl = (_sessionId, agentTask) =>
      (async function* (): AsyncGenerator<RuntimeStreamEvent> {
        yield { type: 'thread.started', threadId: `thread_${agentTask.prompt}` };
        yield {
          type: 'item.completed',
          itemType: 'agent_message',
          text: `reply:${agentTask.prompt}`,
        };
        yield { type: 'turn.completed', usage: { ...USAGE } };
      })();
    const first = await manager.createWorker({ name: 'a', workspacePath: 'E:\\a' });
    const second = await manager.createWorker({ name: 'b', workspacePath: 'E:\\b' });
    const taskA = await manager.dispatchTask(first.workerId, 'alpha', 'key-a');
    const taskB = await manager.dispatchTask(second.workerId, 'beta', 'key-b');
    await manager.whenTaskSettled(taskA.taskId);
    await manager.whenTaskSettled(taskB.taskId);

    expect(manager.getTaskResult(taskA.taskId)).toMatchObject({
      response: 'reply:alpha',
      nativeThreadId: 'thread_alpha',
      usage: USAGE,
    });
    expect(manager.getTaskResult(taskB.taskId)).toMatchObject({
      response: 'reply:beta',
      nativeThreadId: 'thread_beta',
    });
  });

  it('replays the same requestKey and conflicts when the message differs', async () => {
    const worker = await manager.createWorker({ name: 'w', workspacePath: 'E:\\ws' });
    const first = await manager.dispatchTask(worker.workerId, 'same', 'req-same');
    await manager.whenTaskSettled(first.taskId);
    const replay = await manager.dispatchTask(worker.workerId, 'same', 'req-same');
    expect(replay).toMatchObject({ taskId: first.taskId, replayed: true, status: 'completed' });
    expect(adapter.calls.filter((call) => call.method === 'runTaskStreamed')).toHaveLength(1);

    await expect(manager.dispatchTask(worker.workerId, 'different', 'req-same')).rejects.toMatchObject({
      code: 'REQUEST_KEY_CONFLICT',
    } satisfies Partial<WorkerToolError>);
    expect(adapter.calls.filter((call) => call.method === 'runTaskStreamed')).toHaveLength(1);
  });

  it('records an explicit turn failure without inventing a response', async () => {
    adapter.streamImpl = async function* () {
      yield { type: 'thread.started', threadId: 'thread_failed' };
      yield { type: 'turn.failed', message: 'api_key=super-secret exploded' };
    };
    const worker = await manager.createWorker({ name: 'w', workspacePath: 'E:\\ws' });
    const dispatched = await manager.dispatchTask(worker.workerId, 'boom', 'req-fail');
    await manager.whenTaskSettled(dispatched.taskId);

    const result = manager.getTaskResult(dispatched.taskId);
    expect(result.status).toBe('failed');
    expect(result.response).toBeNull();
    expect(result.error?.category).toBe('turn_failed');
    expect(result.error?.message).not.toContain('super-secret');
    expect(result.nativeThreadId).toBe('thread_failed');
    expect(manager.getWorker(worker.workerId)).toMatchObject({
      state: 'ready',
      threadId: 'thread_failed',
    });
  });

  it('marks a thrown stream unknown, redacts the error, and does not crash', async () => {
    const reasons: unknown[] = [];
    const onRejection = (reason: unknown) => {
      reasons.push(reason);
    };
    process.on('unhandledRejection', onRejection);
    adapter.streamImpl = async function* () {
      yield { type: 'thread.started', threadId: 'thread_uncertain' };
      throw new Error('socket hang up sk-abcdefghijklmnopqrst');
    };
    const worker = await manager.createWorker({ name: 'w', workspacePath: 'E:\\ws' });
    const dispatched = await manager.dispatchTask(worker.workerId, 'maybe', 'req-unknown');
    await manager.whenTaskSettled(dispatched.taskId);
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.off('unhandledRejection', onRejection);

    expect(reasons).toEqual([]);
    const result = manager.getTaskResult(dispatched.taskId);
    expect(result.status).toBe('unknown');
    expect(result.response).toBeNull();
    expect(JSON.stringify(result)).not.toContain('sk-abcdefghijklmnopqrst');
    expect(manager.getWorker(worker.workerId).state).toBe('initialization_uncertain');
    await expect(manager.dispatchTask(worker.workerId, 'maybe', 'req-other')).rejects.toMatchObject({
      code: 'STATE_BLOCKED',
    } satisfies Partial<WorkerToolError>);
    const replay = await manager.dispatchTask(worker.workerId, 'maybe', 'req-unknown');
    expect(replay).toMatchObject({ taskId: dispatched.taskId, replayed: true, status: 'unknown' });
    expect(adapter.calls.filter((call) => call.method === 'runTaskStreamed')).toHaveLength(1);
  });

  it('bounds progress and still saves the final result', async () => {
    adapter.streamImpl = async function* () {
      for (let index = 0; index < 40; index += 1) {
        yield { type: 'item.started', itemType: 'command_execution', itemId: `c${index}` };
      }
      yield { type: 'item.completed', itemType: 'agent_message', text: 'bounded' };
      yield { type: 'turn.completed', usage: null };
    };
    const worker = await manager.createWorker({ name: 'w', workspacePath: 'E:\\ws' });
    const dispatched = await manager.dispatchTask(worker.workerId, 'lots', 'req-progress');
    await manager.whenTaskSettled(dispatched.taskId);
    const status = manager.getTaskStatus(dispatched.taskId);
    expect(status.progress.length).toBeLessThanOrEqual(24);
    expect(status.progress.some((entry) => entry.summary.includes('running command'))).toBe(true);
    expect(JSON.stringify(status.progress)).not.toContain('aggregated_output');
    expect(manager.getTaskResult(dispatched.taskId).response).toBe('bounded');
  });

  it('reads a completed result after a new store open and does not rerun it', async () => {
    const worker = await manager.createWorker({ name: 'w', workspacePath: 'E:\\ws' });
    const dispatched = await manager.dispatchTask(worker.workerId, 'persist me', 'req-persist');
    await manager.whenTaskSettled(dispatched.taskId);

    const reloadedStore = await TaskStore.open(join(dir, 'tasks.json'));
    const reloadedRegistry = await SessionRegistry.open(join(dir, 'workers.json'));
    const nextAdapter = new FakeRuntimeAdapter();
    const next = new WorkerManager({
      registry: reloadedRegistry,
      taskStore: reloadedStore,
      adapter: nextAdapter,
      verifyWorkspace: async (workspacePath) => ({ ok: true, resolvedPath: workspacePath }),
    });
    expect(next.getTaskResult(dispatched.taskId)).toMatchObject({
      status: 'completed',
      response: 'FAKE_ASYNC:persist me',
      nativeThreadId: 'thread_fake_async',
    });
    expect(nextAdapter.calls).toEqual([]);
  });

  it('marks an interrupted running task unknown on open and reports a split registry', async () => {
    const now = new Date().toISOString();
    const worker = await manager.createWorker({ name: 'w', workspacePath: 'E:\\ws' });
    const fingerprint = requestFingerprint(worker.workerId, 'in flight');
    await writeFile(
      join(dir, 'tasks.json'),
      JSON.stringify({
        schemaVersion: 1,
        tasks: [
          {
            taskId: 'task_split',
            workerId: worker.workerId,
            requestKey: 'split',
            requestFingerprint: fingerprint,
            status: 'running',
            createdAt: now,
            startedAt: now,
            updatedAt: now,
            completedAt: null,
            nativeThreadId: 'thread_from_task_only',
            progress: [],
            result: 'should-not-be-returned',
            usage: null,
            error: null,
          },
        ],
      }),
      'utf8',
    );

    const reloadedStore = await TaskStore.open(join(dir, 'tasks.json'));
    const reloadedRegistry = await SessionRegistry.open(join(dir, 'workers.json'));
    const nextAdapter = new FakeRuntimeAdapter();
    const next = new WorkerManager({
      registry: reloadedRegistry,
      taskStore: reloadedStore,
      adapter: nextAdapter,
      verifyWorkspace: async (workspacePath) => ({ ok: true, resolvedPath: workspacePath }),
    });

    expect(next.getTaskStatus('task_split')).toMatchObject({
      status: 'unknown',
      nativeThreadId: 'thread_from_task_only',
      association: 'unconfirmed',
      // Seeded record predates requestedModel; loads as null.
      requestedModel: null,
    });
    const result = next.getTaskResult('task_split');
    expect(result.status).toBe('unknown');
    expect(result.response).toBeNull();
    expect(result.associationDetail).toContain('thread_from_task_only');
    expect(nextAdapter.calls).toEqual([]);
    const replay = await next.dispatchTask(worker.workerId, 'in flight', 'split');
    expect(replay).toMatchObject({ taskId: 'task_split', replayed: true, status: 'unknown' });
    await expect(next.dispatchTask(worker.workerId, 'new prompt', 'split-2')).rejects.toMatchObject({
      code: 'STATE_BLOCKED',
    } satisfies Partial<WorkerToolError>);
    await expect(next.sendMessage(worker.workerId, 'new prompt')).rejects.toMatchObject({
      code: 'STATE_BLOCKED',
    } satisfies Partial<WorkerToolError>);
    expect(nextAdapter.calls).toEqual([]);
  });

  it('records the model requested at dispatch on the task record', async () => {
    adapter.defaultModel = 'bridge-fallback';
    const pinned = await manager.createWorker({
      name: 'p',
      workspacePath: 'E:\\ws',
      model: 'gpt-pinned',
    });
    const unpinned = await manager.createWorker({ name: 'f', workspacePath: 'E:\\ws2' });
    const first = await manager.dispatchTask(pinned.workerId, 'a', 'key-pinned');
    const second = await manager.dispatchTask(unpinned.workerId, 'b', 'key-free');
    await manager.whenTaskSettled(first.taskId);
    await manager.whenTaskSettled(second.taskId);

    expect(manager.getTaskStatus(first.taskId).requestedModel).toBe('gpt-pinned');
    expect(manager.getTaskResult(first.taskId).requestedModel).toBe('gpt-pinned');
    expect(manager.getTaskStatus(second.taskId).requestedModel).toBe('bridge-fallback');

    const persisted = taskStore.get(first.taskId);
    expect(persisted?.requestedModel).toBe('gpt-pinned');
  });

  it('hides the resume hint while the worker is mid-turn', async () => {
    adapter.nextResults.push({
      taskId: '',
      sessionId: '',
      status: 'succeeded',
      externalSessionId: 'thread_busy',
      completedAt: new Date().toISOString(),
    });
    const worker = await manager.createWorker({ name: 'w', workspacePath: 'E:\\ws' });
    await manager.sendMessage(worker.workerId, 'init');
    expect(manager.getWorker(worker.workerId).resumeHint).toBe('codex resume thread_busy');

    const gate = hold();
    adapter.streamHold = gate.promise;
    adapter.streamImpl = async function* () {
      yield { type: 'thread.started', threadId: 'thread_busy' };
      yield { type: 'item.completed', itemType: 'agent_message', text: 'done' };
      yield { type: 'turn.completed', usage: null };
    };
    const dispatched = await manager.dispatchTask(worker.workerId, 'slow', 'req-busy');
    await waitFor(
      () => manager.getTaskStatus(dispatched.taskId).status === 'running',
      'running',
    );
    expect(manager.getWorker(worker.workerId)).toMatchObject({
      state: 'busy',
      resumeHint: null,
    });

    gate.release();
    await manager.whenTaskSettled(dispatched.taskId);
    expect(manager.getWorker(worker.workerId).resumeHint).toBe('codex resume thread_busy');
  });

  it('does not let a late success overwrite a task abandoned on shutdown', async () => {
    const gate = hold();
    adapter.streamHold = gate.promise;
    const worker = await manager.createWorker({ name: 'w', workspacePath: 'E:\\ws' });
    const dispatched = await manager.dispatchTask(worker.workerId, 'stop', 'req-stop');
    await waitFor(() => manager.getTaskStatus(dispatched.taskId).status === 'running', 'running');

    await manager.abandonInFlight('stdin closed');
    gate.release();
    await manager.whenTaskSettled(dispatched.taskId);

    expect(manager.getTaskResult(dispatched.taskId)).toMatchObject({
      status: 'unknown',
      response: null,
      error: { category: 'interrupted' },
    });
    expect(manager.getWorker(worker.workerId).state).toBe('initialization_uncertain');
  });
});
