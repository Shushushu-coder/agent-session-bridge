import { mkdir, mkdtemp, appendFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderBoard } from '../src/watch/board.js';
import { formatRolloutLine } from '../src/watch/format.js';
import { latestTasksByWorker, loadBoardData } from '../src/watch/registry.js';
import { findRolloutFile } from '../src/watch/rolloutLocator.js';
import { extractLines, readTailLines, RolloutTail } from '../src/watch/rolloutTail.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wsb-watch-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

describe('extractLines', () => {
  it('splits complete lines and keeps the trailing partial', () => {
    expect(extractLines('aa\nbb\ncc')).toEqual({ lines: ['aa', 'bb'], rest: 'cc' });
    expect(extractLines('a\r\nb\n')).toEqual({ lines: ['a', 'b'], rest: '' });
    expect(extractLines('')).toEqual({ lines: [], rest: '' });
  });
});

describe('formatRolloutLine', () => {
  const env = (type: string, payload: object) =>
    JSON.stringify({ timestamp: '2026-11-10T11:40:08.123Z', ordinal: 7, type, payload });

  it('renders turn lifecycle and messages', () => {
    expect(formatRolloutLine(env('event_msg', { type: 'task_started', turn_id: 'turn_abcdef123456' })))
      .toContain('turn started · turn turn_abc');
    expect(
      formatRolloutLine(
        env('event_msg', {
          type: 'item_completed',
          item: { type: 'UserMessage', id: 'u1', content: [{ type: 'text', text: 'Reply with PONG' }] },
        }),
      ),
    ).toContain('user: Reply with PONG');
    expect(
      formatRolloutLine(
        env('event_msg', {
          type: 'item_completed',
          item: { type: 'AgentMessage', id: 'a1', content: [{ type: 'Text', text: 'PONG' }] },
        }),
      ),
    ).toContain('agent: PONG');
    expect(
      formatRolloutLine(
        env('event_msg', { type: 'task_complete', turn_id: 't', duration_ms: 6482, last_agent_message: 'PONG' }),
      ),
    ).toContain('turn done 6.5s · PONG');
  });

  it('renders token usage and redacts secrets', () => {
    const line = env('event_msg', {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: 100, output_tokens: 5, reasoning_output_tokens: 2 } },
    });
    expect(formatRolloutLine(line)).toContain('tokens 100 in / 5 out (+2 reasoning)');

    const secret = env('event_msg', {
      type: 'item_completed',
      item: { type: 'UserMessage', id: 'u', content: [{ type: 'text', text: 'key sk-abc123456789 here' }] },
    });
    expect(formatRolloutLine(secret)).not.toContain('sk-abc123456789');
  });

  it('skips bulk records and tolerates garbage', () => {
    expect(formatRolloutLine(env('response_item', { type: 'message', role: 'developer' }))).toBeNull();
    expect(formatRolloutLine(env('turn_context', {}))).toBeNull();
    expect(formatRolloutLine('not json {')).toBeNull();
    expect(formatRolloutLine('{}')).toBeNull();
  });
});

describe('findRolloutFile', () => {
  it('locates a rollout file by thread id under the date-sharded tree', async () => {
    const nested = join(dir, 'sessions', '2026', '11', '10');
    await mkdir(nested, { recursive: true });
    const file = join(nested, 'rollout-2026-11-10T11-40-08-thread_abc123.jsonl');
    await writeFile(file, '{}\n', 'utf8');
    await writeFile(join(nested, 'rollout-other-thread_zzz.jsonl'), '{}\n', 'utf8');

    expect(await findRolloutFile('thread_abc123', join(dir, 'sessions'))).toBe(file);
    expect(await findRolloutFile('thread_nope', join(dir, 'sessions'))).toBeNull();
    expect(await findRolloutFile('x', join(dir, 'missing-root'))).toBeNull();
  });
});

describe('RolloutTail', () => {
  it('emits complete lines as the file grows, holding partial writes', async () => {
    const file = join(dir, 'rollout-test.jsonl');
    await writeFile(file, '{"type":"session_meta"}\n', 'utf8');

    const seen: string[] = [];
    const tail = new RolloutTail(file, { pollMs: 20, offset: 0, onLines: (l) => seen.push(...l) });
    await tail.start();
    try {
      // Split a line across two writes; multibyte char inside.
      await appendFile(file, '{"a":"hél');
      await new Promise((r) => setTimeout(r, 80));
      await appendFile(file, 'lo"}\n{"b":1}\n');
      await waitFor(() => seen.length >= 3, 'three lines');
      expect(seen).toEqual(['{"type":"session_meta"}', '{"a":"héllo"}', '{"b":1}']);
    } finally {
      await tail.stop();
    }
  });
});

describe('readTailLines', () => {
  it('returns the last N complete lines', async () => {
    const file = join(dir, 'r.jsonl');
    await writeFile(file, 'l1\nl2\nl3\npartial', 'utf8');
    expect(await readTailLines(file, 2)).toEqual(['l2', 'l3']);
    expect(await readTailLines(join(dir, 'missing.jsonl'), 2)).toEqual([]);
  });
});

describe('board rendering and data loading', () => {
  it('loads bridge data files and renders worker rows with latest task', async () => {
    const now = '2026-11-10T11:40:00.000Z';
    await writeFile(
      join(dir, 'workers.json'),
      JSON.stringify({
        workers: [
          {
            workerId: 'wrk_a',
            name: 'alpha',
            threadId: 'thread_alpha_123',
            workspacePath: 'E:\\ws',
            model: 'gpt-pinned',
            state: 'ready',
          },
          { workerId: 'wrk_b', name: 'beta', threadId: null, workspacePath: 'E:\\ws', state: 'pending_initialization' },
        ],
      }),
      'utf8',
    );
    await writeFile(
      join(dir, 'tasks.json'),
      JSON.stringify({
        tasks: [
          {
            taskId: 'task_old', workerId: 'wrk_a', requestKey: 'k1', status: 'completed',
            createdAt: '2026-11-10T11:00:00.000Z', startedAt: now, updatedAt: now,
            completedAt: now, nativeThreadId: 'thread_alpha_123',
            progress: [{ at: now, kind: 'turn.completed', summary: 'turn completed' }],
            result: 'done', usage: null, error: null,
          },
          {
            taskId: 'task_new', workerId: 'wrk_a', requestKey: 'k2', status: 'running',
            createdAt: '2026-11-10T11:39:00.000Z', startedAt: now, updatedAt: now,
            completedAt: null, nativeThreadId: null,
            progress: [{ at: now, kind: 'item.completed', summary: 'item agent_message' }],
            result: null, usage: null, error: null,
          },
        ],
      }),
      'utf8',
    );

    const data = await loadBoardData(dir);
    expect(data.readable).toBe(true);
    expect(latestTasksByWorker(data.tasks).get('wrk_a')?.taskId).toBe('task_new');

    const board = renderBoard(data.workers, data.tasks, { now: Date.parse('2026-11-10T11:41:00.000Z') });
    expect(board).toContain('alpha');
    expect(board).toContain('ready');
    expect(board).toContain('RUNNING');
    expect(board).toContain('task_new');
    expect(board).toContain('pending');
    expect(board).toContain('beta');
  });

  it('reports unreadable files without throwing', async () => {
    await writeFile(join(dir, 'workers.json'), '{bad', 'utf8');
    const data = await loadBoardData(dir);
    expect(data.readable).toBe(false);
    expect(renderBoard(data.workers, data.tasks, { readable: data.readable })).toContain('unreadable');
  });
});
