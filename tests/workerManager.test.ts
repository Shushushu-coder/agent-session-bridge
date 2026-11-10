import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkspaceCheck } from '../src/workers/workspaceVerifier.js';
import { WorkerManager, WorkerToolError } from '../src/workers/workerManager.js';
import { SessionRegistry } from '../src/storage/sessionRegistry.js';
import { TaskStore } from '../src/storage/taskStore.js';
import type { TaskResult } from '../src/contracts/task.js';
import { FakeRuntimeAdapter } from './helpers/fakes.js';

let dir: string;
let registryFile: string;
let adapter: FakeRuntimeAdapter;
let registry: SessionRegistry;
let manager: WorkerManager;
let taskStore: TaskStore;

const okWorkspace = async (p: string): Promise<WorkspaceCheck> => ({
  ok: true,
  resolvedPath: p,
});

function makeManager(r: SessionRegistry, a: FakeRuntimeAdapter, store: TaskStore = taskStore) {
  return new WorkerManager({
    registry: r,
    taskStore: store,
    adapter: a,
    verifyWorkspace: okWorkspace,
  });
}

function failedResult(externalSessionId?: string): TaskResult {
  return {
    taskId: '',
    sessionId: '',
    status: 'failed',
    error: 'sdk blew up',
    ...(externalSessionId ? { externalSessionId } : {}),
    completedAt: new Date().toISOString(),
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'asb-manager-'));
  registryFile = join(dir, 'workers.json');
  registry = await SessionRegistry.open(registryFile);
  taskStore = await TaskStore.open(join(dir, 'tasks.json'));
  adapter = new FakeRuntimeAdapter();
  manager = makeManager(registry, adapter);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('WorkerManager', () => {
  it('registers a worker in pending_initialization with no thread id', async () => {
    const worker = await manager.createWorker({ name: 'w1', workspacePath: 'E:\\ws' });
    expect(worker.workerId).toMatch(/^wrk_/);
    expect(worker.state).toBe('pending_initialization');
    expect(worker.threadId).toBeNull();

    const reloaded = await SessionRegistry.open(registryFile);
    expect(reloaded.get(worker.workerId)?.state).toBe('pending_initialization');
    expect(adapter.calls).toEqual([]);
  });

  it('rejects an invalid workspace before registering', async () => {
    const m = new WorkerManager({
      registry,
      taskStore,
      adapter,
      verifyWorkspace: async () => ({ ok: false, error: 'not a git work tree' }),
    });
    await expect(
      m.createWorker({ name: 'w', workspacePath: 'E:\\nope' }),
    ).rejects.toMatchObject({ code: 'INVALID_WORKSPACE' } satisfies Partial<WorkerToolError>);
    expect(registry.list()).toEqual([]);
  });

  it('first send initializes the thread and persists its native id', async () => {
    adapter.nextResults.push({
      taskId: '',
      sessionId: '',
      status: 'succeeded',
      output: 'hello back',
      externalSessionId: 'thread_xyz',
      completedAt: new Date().toISOString(),
    });
    const worker = await manager.createWorker({ name: 'w1', workspacePath: 'E:\\ws' });
    const result = await manager.sendMessage(worker.workerId, 'hi');

    expect(result.status).toBe('completed');
    expect(result.response).toBe('hello back');
    expect(result.threadId).toBe('thread_xyz');
    expect(result.state).toBe('ready');
    expect(adapter.calls.map((c) => c.method)).toEqual(['createSession', 'runTask']);

    const reloaded = await SessionRegistry.open(registryFile);
    expect(reloaded.get(worker.workerId)).toMatchObject({
      threadId: 'thread_xyz',
      state: 'ready',
    });
  });

  it('reuses the cached session for the second send in the same process', async () => {
    adapter.runTaskImpl = async (_s, task) => ({
      taskId: task.id,
      sessionId: task.sessionId,
      status: 'succeeded',
      output: 'ok',
      externalSessionId: 'thread_abc',
      completedAt: new Date().toISOString(),
    });
    const worker = await manager.createWorker({ name: 'w1', workspacePath: 'E:\\ws' });
    await manager.sendMessage(worker.workerId, 'first');
    const second = await manager.sendMessage(worker.workerId, 'second');

    expect(second.status).toBe('completed');
    expect(adapter.calls.map((c) => c.method)).toEqual([
      'createSession',
      'runTask',
      'runTask',
    ]);
    expect(adapter.calls[2]?.prompt).toBe('second');
  });

  it('after a simulated restart, send resumes the persisted thread', async () => {
    adapter.nextResults.push({
      taskId: '',
      sessionId: '',
      status: 'succeeded',
      externalSessionId: 'thread_persisted',
      completedAt: new Date().toISOString(),
    });
    const worker = await manager.createWorker({ name: 'w1', workspacePath: 'E:\\ws' });
    await manager.sendMessage(worker.workerId, 'init');

    // New process simulation: fresh registry + adapter + manager, same file.
    const registry2 = await SessionRegistry.open(registryFile);
    const adapter2 = new FakeRuntimeAdapter();
    const manager2 = makeManager(registry2, adapter2);

    const restored = manager2.getWorker(worker.workerId);
    expect(restored.threadId).toBe('thread_persisted');
    expect(restored.state).toBe('ready');

    const result = await manager2.sendMessage(worker.workerId, 'again');
    expect(result.status).toBe('completed');
    expect(adapter2.calls.map((c) => c.method)).toEqual(['resumeSession', 'runTask']);
    expect(adapter2.calls[0]?.externalSessionId).toBe('thread_persisted');
  });

  it('rejects a concurrent send with busy while a turn runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    adapter.runTaskImpl = async (_s, task) => {
      await gate;
      return {
        taskId: task.id,
        sessionId: task.sessionId,
        status: 'succeeded',
        externalSessionId: 'thread_b',
        completedAt: new Date().toISOString(),
      };
    };
    const worker = await manager.createWorker({ name: 'w1', workspacePath: 'E:\\ws' });
    const first = manager.sendMessage(worker.workerId, 'slow');
    await new Promise((r) => setTimeout(r, 10));

    const second = await manager.sendMessage(worker.workerId, 'concurrent');
    expect(second.status).toBe('busy');
    release();
    await first;

    const after = await manager.sendMessage(worker.workerId, 'after');
    expect(after.status).not.toBe('busy');
  });

  it('failed first turn without a thread id marks the worker uncertain and blocks retry', async () => {
    adapter.nextResults.push(failedResult());
    const worker = await manager.createWorker({ name: 'w1', workspacePath: 'E:\\ws' });
    const first = await manager.sendMessage(worker.workerId, 'init');

    expect(first.status).toBe('failed');
    expect(first.threadId).toBeNull();

    const reloaded = await SessionRegistry.open(registryFile);
    expect(reloaded.get(worker.workerId)?.state).toBe('initialization_uncertain');

    await expect(manager.sendMessage(worker.workerId, 'retry')).rejects.toMatchObject({
      code: 'STATE_BLOCKED',
    });
    // No retry hit the adapter.
    expect(adapter.calls.filter((c) => c.method === 'runTask')).toHaveLength(1);
  });

  it('failed first turn that still captured a thread id keeps the worker resumable', async () => {
    adapter.nextResults.push(failedResult('thread_partial'));
    const worker = await manager.createWorker({ name: 'w1', workspacePath: 'E:\\ws' });
    const first = await manager.sendMessage(worker.workerId, 'init');

    expect(first.status).toBe('failed');
    const saved = (await SessionRegistry.open(registryFile)).get(worker.workerId);
    expect(saved).toMatchObject({ threadId: 'thread_partial', state: 'ready' });
  });

  it('a failed resume turn marks the worker error without pretending success', async () => {
    adapter.nextResults.push(
      {
        taskId: '',
        sessionId: '',
        status: 'succeeded',
        externalSessionId: 'thread_live',
        completedAt: new Date().toISOString(),
      },
      failedResult('thread_live'),
    );
    const worker = await manager.createWorker({ name: 'w1', workspacePath: 'E:\\ws' });
    await manager.sendMessage(worker.workerId, 'init');
    const second = await manager.sendMessage(worker.workerId, 'boom');

    expect(second.status).toBe('failed');
    expect(second.error).toContain('sdk blew up');
    expect(manager.getWorker(worker.workerId).state).toBe('error');
  });

  it('reports WORKER_NOT_FOUND and RUNTIME_UNAVAILABLE explicitly', async () => {
    await expect(manager.sendMessage('wrk_missing', 'hi')).rejects.toMatchObject({
      code: 'WORKER_NOT_FOUND',
    });
    expect(() => manager.getWorker('wrk_missing')).toThrowError(
      expect.objectContaining({ code: 'WORKER_NOT_FOUND' }) as Error,
    );

    adapter.connected = false;
    const worker = await manager.createWorker({ name: 'w1', workspacePath: 'E:\\ws' });
    await expect(manager.sendMessage(worker.workerId, 'hi')).rejects.toMatchObject({
      code: 'RUNTIME_UNAVAILABLE',
    });
  });

  it('reports the resolved model and a resume hint on the worker view', async () => {
    adapter.nextResults.push({
      taskId: '',
      sessionId: '',
      status: 'succeeded',
      externalSessionId: 'thread_hint',
      completedAt: new Date().toISOString(),
    });
    const pinned = await manager.createWorker({
      name: 'pinned',
      workspacePath: 'E:\\ws',
      model: 'gpt-pinned',
    });
    expect(pinned).toMatchObject({
      effectiveModel: 'gpt-pinned',
      modelSource: 'worker',
      resumeHint: null,
    });

    const unpinned = await manager.createWorker({ name: 'free', workspacePath: 'E:\\ws2' });
    expect(unpinned).toMatchObject({
      effectiveModel: null,
      modelSource: 'runtime_default',
      resumeHint: null,
    });

    await manager.sendMessage(pinned.workerId, 'hi');
    expect(manager.getWorker(pinned.workerId)).toMatchObject({
      state: 'ready',
      resumeHint: 'codex resume thread_hint',
    });
  });

  it('reports the bridge default model when the worker does not pin one', async () => {
    adapter.defaultModel = 'bridge-fallback';
    const worker = await manager.createWorker({ name: 'w1', workspacePath: 'E:\\ws' });
    expect(worker).toMatchObject({
      effectiveModel: 'bridge-fallback',
      modelSource: 'bridge_default',
    });
  });

  it('re-validates the workspace on every send', async () => {
    const calls: string[] = [];
    const m = new WorkerManager({
      registry,
      taskStore,
      adapter,
      verifyWorkspace: async (p) => {
        calls.push(p);
        return { ok: true, resolvedPath: p };
      },
    });
    const worker = await m.createWorker({ name: 'w1', workspacePath: 'E:\\ws' });
    await m.sendMessage(worker.workerId, 'go');
    expect(calls).toEqual(['E:\\ws', 'E:\\ws']);
  });

  it('blocks a worker whose first turn was interrupted (initializing → uncertain)', async () => {
    // Seed a registry file as if the process died mid-first-turn.
    const now = new Date().toISOString();
    await writeFile(
      registryFile,
      JSON.stringify({
        schemaVersion: 1,
        workers: [
          {
            workerId: 'wrk_crashed',
            name: 'w',
            runtime: 'codex',
            threadId: null,
            workspacePath: 'E:\\ws',
            state: 'initializing',
            createdAt: now,
            updatedAt: now,
          },
        ],
      }),
      'utf8',
    );
    const crashed = await SessionRegistry.open(registryFile);
    const m = makeManager(crashed, new FakeRuntimeAdapter());
    expect(m.getWorker('wrk_crashed').state).toBe('initialization_uncertain');
    await expect(m.sendMessage('wrk_crashed', 'retry')).rejects.toMatchObject({
      code: 'STATE_BLOCKED',
    });
  });
});
