import type {
  AgentRuntimeAdapter,
  CreateSessionInput,
} from '../../src/contracts/runtime.js';
import type { WorkerSession } from '../../src/contracts/session.js';
import type { AgentTask, TaskResult } from '../../src/contracts/task.js';
import type {
  CodexSdkLike,
  CodexThreadLike,
  ThreadOptions,
} from '../../src/runtime/codex/codexSdk.js';

/** Records every ThreadOptions handed to startThread/resumeThread. */
export class FakeCodexSdk implements CodexSdkLike {
  readonly startCalls: (ThreadOptions | undefined)[] = [];
  readonly resumeCalls: { id: string; options: ThreadOptions | undefined }[] = [];
  threads: FakeThread[] = [];

  startThread(options?: ThreadOptions): CodexThreadLike {
    this.startCalls.push(options);
    const thread = new FakeThread();
    this.threads.push(thread);
    return thread;
  }

  resumeThread(id: string, options?: ThreadOptions): CodexThreadLike {
    this.resumeCalls.push({ id, options });
    const thread = new FakeThread(id);
    this.threads.push(thread);
    return thread;
  }
}

export class FakeThread implements CodexThreadLike {
  runCalls: string[] = [];

  /** Set before run() resolves to simulate thread.started mid-turn. */
  idOnRun: string | null = null;
  /** Reject run() with this error. */
  failWith: Error | null = null;
  /** Resolve run() with this response text. */
  response = 'FAKE_RESPONSE';
  /** Deferred gate: when set, run() waits until released. */
  gate: Promise<void> | null = null;

  constructor(private _id: string | null = null) {}

  get id(): string | null {
    return this._id;
  }

  async run(input: string) {
    this.runCalls.push(input);
    if (this.gate) await this.gate;
    if (this.idOnRun) this._id = this.idOnRun;
    if (this.failWith) throw this.failWith;
    return {
      items: [],
      finalResponse: this.response,
      usage: null,
    };
  }
}

export interface FakeAdapterCall {
  method: 'createSession' | 'resumeSession' | 'runTask';
  input?: CreateSessionInput;
  externalSessionId?: string;
  sessionId?: string;
  prompt?: string;
}

/**
 * AgentRuntimeAdapter fake for WorkerManager tests. runTask behaviour is
 * scripted via `nextResults` / `runTaskImpl`.
 */
export class FakeRuntimeAdapter implements AgentRuntimeAdapter {
  readonly kind = 'codex';
  connected = true;
  calls: FakeAdapterCall[] = [];
  nextResults: TaskResult[] = [];
  runTaskImpl:
    | ((sessionId: string, task: AgentTask) => Promise<TaskResult>)
    | null = null;
  private sessions = new Map<string, WorkerSession>();
  private counter = 0;

  isConnected(): boolean {
    return this.connected;
  }

  connect(): Promise<void> {
    return Promise.resolve();
  }

  createSession(input?: CreateSessionInput): Promise<WorkerSession> {
    this.calls.push({ method: 'createSession', ...(input ? { input } : {}) });
    const session = this.makeSession();
    return Promise.resolve(session);
  }

  resumeSession(
    externalSessionId: string,
    input?: CreateSessionInput,
  ): Promise<WorkerSession> {
    this.calls.push({
      method: 'resumeSession',
      externalSessionId,
      ...(input ? { input } : {}),
    });
    const session = this.makeSession(externalSessionId);
    return Promise.resolve(session);
  }

  runTask(sessionId: string, task: AgentTask): Promise<TaskResult> {
    this.calls.push({ method: 'runTask', sessionId, prompt: task.prompt });
    if (this.runTaskImpl) return this.runTaskImpl(sessionId, task);
    const scripted = this.nextResults.shift();
    if (scripted) return Promise.resolve({ ...scripted, sessionId, taskId: task.id });
    return Promise.resolve({
      taskId: task.id,
      sessionId,
      status: 'succeeded',
      output: 'FAKE_OUTPUT',
      completedAt: new Date().toISOString(),
    });
  }

  getSession(sessionId: string): WorkerSession | undefined {
    const s = this.sessions.get(sessionId);
    return s ? { ...s } : undefined;
  }

  dispose(): Promise<void> {
    this.sessions.clear();
    return Promise.resolve();
  }

  private makeSession(externalSessionId?: string): WorkerSession {
    const session: WorkerSession = {
      id: `fake_sess_${++this.counter}`,
      runtime: 'codex',
      status: externalSessionId ? 'ready' : 'created',
      createdAt: new Date().toISOString(),
      ...(externalSessionId ? { externalSessionId } : {}),
    };
    this.sessions.set(session.id, session);
    return session;
  }
}
