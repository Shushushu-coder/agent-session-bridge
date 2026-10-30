import { describe, expect, it } from 'vitest';
import type { AgentTask } from '../src/contracts/task.js';
import {
  CodexAdapterError,
  CodexRuntimeAdapter,
} from '../src/runtime/codex/codexRuntimeAdapter.js';
import { FakeCodexSdk, FakeThread } from './helpers/fakes.js';

function task(id = 'task_1'): AgentTask {
  return {
    id,
    sessionId: '',
    prompt: 'do something',
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
}

async function connectedAdapter(sdk: FakeCodexSdk) {
  const adapter = new CodexRuntimeAdapter({ sdk });
  await adapter.connect();
  return adapter;
}

describe('CodexRuntimeAdapter', () => {
  it('requires connect() before use and reports NOT_CONNECTED honestly', async () => {
    const adapter = new CodexRuntimeAdapter({ sdk: new FakeCodexSdk() });
    expect(adapter.isConnected()).toBe(false);
    await expect(adapter.createSession({ cwd: '/x' })).rejects.toMatchObject({
      name: 'CodexAdapterError',
      code: 'NOT_CONNECTED',
    });
  });

  it('startThread gets fixed safe defaults and the session has no native id yet', async () => {
    const sdk = new FakeCodexSdk();
    const adapter = await connectedAdapter(sdk);

    const session = await adapter.createSession({ cwd: 'E:\\ws', model: 'm1' });

    expect(session.status).toBe('created');
    expect(session.externalSessionId).toBeUndefined();
    expect(sdk.startCalls).toEqual([
      {
        workingDirectory: 'E:\\ws',
        model: 'm1',
        sandboxMode: 'read-only',
        approvalPolicy: 'never',
        webSearchMode: 'disabled',
      },
    ]);
  });

  it('omits model and workingDirectory when not provided', async () => {
    const sdk = new FakeCodexSdk();
    const adapter = await connectedAdapter(sdk);
    await adapter.createSession();
    const options = sdk.startCalls[0]!;
    expect(options).not.toHaveProperty('model');
    expect(options).not.toHaveProperty('workingDirectory');
    expect(options.sandboxMode).toBe('read-only');
  });

  it('captures the native thread id emitted during the first run', async () => {
    const sdk = new FakeCodexSdk();
    const adapter = await connectedAdapter(sdk);
    const session = await adapter.createSession({ cwd: 'E:\\ws' });

    const thread = sdk.threads[0] as FakeThread;
    thread.idOnRun = 'thread_native_1';

    const result = await adapter.runTask(session.id, task());

    expect(result.status).toBe('succeeded');
    expect(result.output).toBe('FAKE_RESPONSE');
    expect(result.externalSessionId).toBe('thread_native_1');
    expect(adapter.getSession(session.id)?.externalSessionId).toBe('thread_native_1');
    expect(adapter.getSession(session.id)?.status).toBe('ready');
  });

  it('reports failure honestly and still surfaces a thread id captured mid-turn', async () => {
    const sdk = new FakeCodexSdk();
    const adapter = await connectedAdapter(sdk);
    const session = await adapter.createSession({ cwd: 'E:\\ws' });

    const thread = sdk.threads[0] as FakeThread;
    thread.idOnRun = 'thread_native_2';
    thread.failWith = new Error('turn exploded');

    const result = await adapter.runTask(session.id, task());

    expect(result.status).toBe('failed');
    expect(result.error).toContain('turn exploded');
    expect(result.externalSessionId).toBe('thread_native_2');
    expect(adapter.getSession(session.id)?.status).toBe('failed');
  });

  it('rejects a second concurrent run on the same session', async () => {
    const sdk = new FakeCodexSdk();
    const adapter = await connectedAdapter(sdk);
    const session = await adapter.createSession({ cwd: 'E:\\ws' });

    let release!: () => void;
    const thread = sdk.threads[0] as FakeThread;
    thread.gate = new Promise<void>((r) => (release = r));

    const first = adapter.runTask(session.id, task('t1'));
    await new Promise((r) => setTimeout(r, 10));
    await expect(adapter.runTask(session.id, task('t2'))).rejects.toMatchObject({
      code: 'SESSION_BUSY',
    });
    release();
    await first;
  });

  it('resumeSession binds the given id without starting any turn', async () => {
    const sdk = new FakeCodexSdk();
    const adapter = await connectedAdapter(sdk);

    const session = await adapter.resumeSession('thread_saved_9', {
      cwd: 'E:\\ws',
      model: 'm2',
    });

    expect(session.status).toBe('ready');
    expect(session.externalSessionId).toBe('thread_saved_9');
    expect(sdk.resumeCalls).toEqual([
      {
        id: 'thread_saved_9',
        options: {
          workingDirectory: 'E:\\ws',
          model: 'm2',
          sandboxMode: 'read-only',
          approvalPolicy: 'never',
          webSearchMode: 'disabled',
        },
      },
    ]);
    expect((sdk.threads[0] as FakeThread).runCalls).toEqual([]);
  });

  it('runTask on unknown session throws SESSION_NOT_FOUND', async () => {
    const adapter = await connectedAdapter(new FakeCodexSdk());
    await expect(adapter.runTask('csess_nope', task())).rejects.toMatchObject({
      code: 'SESSION_NOT_FOUND',
    });
  });

  it('adapter-level options.model applies when session has none', async () => {
    const sdk = new FakeCodexSdk();
    const adapter = new CodexRuntimeAdapter({ sdk, model: 'default_model' });
    await adapter.connect();
    await adapter.createSession({ cwd: 'E:\\ws' });
    expect(sdk.startCalls[0]?.model).toBe('default_model');
  });
});
