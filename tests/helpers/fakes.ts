import type {
  AgentRuntimeAdapter,
  CreateSessionInput,
  RuntimeStreamEvent,
} from '../../src/contracts/runtime.js';
import type { WorkerSession } from '../../src/contracts/session.js';
import type { AgentTask, TaskResult, TaskUsage } from '../../src/contracts/task.js';
import type {
  CodexSdkLike,
  CodexThreadLike,
  ThreadEvent,
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
  streamCalls: string[] = [];
  /** Events yielded by runStreamed. Empty unless a test sets them. */
  streamEvents: ThreadEvent[] = [];
  /** When set, runStreamed waits before yielding. */
  streamHold: Promise<void> | null = null;
  /** When set, runStreamed throws after streamHold. */
  streamError: Error | null = null;

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

  async runStreamed(input: string) {
    this.streamCalls.push(input);
    const events = this.streamEvents;
    const hold = this.streamHold;
    const error = this.streamError;
    const self = this;
    return {
      events: (async function* () {
        if (hold) await hold;
        if (self.idOnRun) self._id = self.idOnRun;
        if (error) throw error;
        for (const event of events) yield event;
      })(),
    };
  }
}

export const FAKE_STREAM_USAGE: TaskUsage = {
  input_tokens: 3,
  cached_input_tokens: 1,
  cache_write_input_tokens: 0,
  output_tokens: 2,
  reasoning_output_tokens: 0,
};

export interface FakeAdapterCall {
  method: 'createSession' | 'resumeSession' | 'runTask' | 'runTaskStreamed';
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
  /** Bridge-level default model; set in tests to cover bridge_default. */
  defaultModel: string | undefined = undefined;
  calls: FakeAdapterCall[] = [];
  nextResults: TaskResult[] = [];
  runTaskImpl:
    | ((sessionId: string, task: AgentTask) => Promise<TaskResult>)
    | null = null;
  /** When set, runTaskStreamed waits before yielding events. */
  streamHold: Promise<void> | null = null;
  /** Extra delay after the hold, so status can be observed mid-turn. */
  streamDelayMs = 0;
  streamImpl: ((sessionId: string, task: AgentTask) => AsyncIterable<RuntimeStreamEvent>) | null =
    null;
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

  async *runTaskStreamed(sessionId: string, task: AgentTask): AsyncIterable<RuntimeStreamEvent> {
    this.calls.push({ method: 'runTaskStreamed', sessionId, prompt: task.prompt });
    if (this.streamHold) await this.streamHold;
    if (this.streamDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.streamDelayMs));
    }
    if (this.streamImpl) {
      yield* this.streamImpl(sessionId, task);
      return;
    }
    const session = this.sessions.get(sessionId);
    if (session) session.externalSessionId = 'thread_fake_async';
    yield { type: 'thread.started', threadId: 'thread_fake_async' };
    yield { type: 'turn.started' };
    yield { type: 'item.started', itemType: 'agent_message', itemId: 'msg_1' };
    yield {
      type: 'item.completed',
      itemType: 'agent_message',
      itemId: 'msg_1',
      text: `FAKE_ASYNC:${task.prompt}`,
    };
    yield { type: 'turn.completed', usage: { ...FAKE_STREAM_USAGE } };
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
