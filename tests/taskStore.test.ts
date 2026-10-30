import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskBatch } from '../src/contracts/batch.js';
import type { WorkerTask } from '../src/contracts/task.js';
import { redactSensitive } from '../src/storage/redact.js';
import {
  DuplicateRequestKeyError,
  TaskStore,
  TaskStoreCorruptedError,
  batchFingerprint,
  requestFingerprint,
} from '../src/storage/taskStore.js';

let dir: string;
let file: string;

function task(overrides: Partial<WorkerTask> = {}): WorkerTask {
  const now = '2026-10-30T00:00:00.000Z';
  return {
    taskId: 'task_alpha',
    workerId: 'wrk_alpha',
    requestKey: 'req-1',
    requestFingerprint: requestFingerprint('wrk_alpha', 'hello'),
    status: 'completed',
    createdAt: now,
    startedAt: now,
    updatedAt: now,
    completedAt: now,
    nativeThreadId: 'thread_alpha',
    progress: [{ at: now, kind: 'turn.completed', summary: 'turn completed' }],
    result: 'done',
    usage: {
      input_tokens: 2,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 1,
      reasoning_output_tokens: 0,
    },
    error: null,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'asb-tasks-'));
  file = join(dir, 'tasks.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('TaskStore', () => {
  it('opens empty when the file does not exist', async () => {
    const store = await TaskStore.open(file);
    expect(store.list()).toEqual([]);
  });

  it('persists tasks across reloads in a file separate from the worker registry', async () => {
    const store = await TaskStore.open(file);
    await store.create(task());
    const reloaded = await TaskStore.open(file);
    expect(reloaded.get('task_alpha')).toMatchObject({
      result: 'done',
      nativeThreadId: 'thread_alpha',
      usage: { input_tokens: 2, output_tokens: 1 },
    });
    expect(reloaded.getByRequestKey('req-1')?.taskId).toBe('task_alpha');
    const names = await readdir(dir);
    expect(names.filter((name) => !name.endsWith('.json') && !name.includes('.tmp-'))).toEqual([]);
    expect(names).toContain('tasks.json');
    expect(names).not.toContain('workers.json');
  });

  it('refuses to silently reset corrupted JSON and leaves the file untouched', async () => {
    const original = '{ not json !!!';
    await writeFile(file, original, 'utf8');
    await expect(TaskStore.open(file)).rejects.toBeInstanceOf(TaskStoreCorruptedError);
    expect(await readFile(file, 'utf8')).toBe(original);
  });

  it('refuses a schema mismatch', async () => {
    await writeFile(file, JSON.stringify({ schemaVersion: 1, tasks: [{ taskId: 'x' }] }), 'utf8');
    await expect(TaskStore.open(file)).rejects.toBeInstanceOf(TaskStoreCorruptedError);
  });

  it('marks accepted and running tasks unknown on open and does not drop completed ones', async () => {
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        tasks: [
          task({ taskId: 'task_live', requestKey: 'live', status: 'running', result: null }),
          task({ taskId: 'task_new', requestKey: 'new', status: 'accepted', result: null, nativeThreadId: null }),
          task({ taskId: 'task_ok', requestKey: 'ok' }),
          task({
            taskId: 'task_bad',
            requestKey: 'bad',
            status: 'failed',
            result: null,
            error: { category: 'turn_failed', message: 'boom' },
          }),
        ],
      }),
      'utf8',
    );

    const store = await TaskStore.open(file);
    expect(store.get('task_live')?.status).toBe('unknown');
    expect(store.get('task_live')?.error?.category).toBe('interrupted');
    expect(store.get('task_new')?.status).toBe('unknown');
    expect(store.get('task_ok')).toMatchObject({ status: 'completed', result: 'done' });
    expect(store.get('task_bad')).toMatchObject({
      status: 'failed',
      error: { category: 'turn_failed', message: 'boom' },
    });

    const persisted = JSON.parse(await readFile(file, 'utf8')) as { tasks: WorkerTask[] };
    expect(persisted.tasks.find((item) => item.taskId === 'task_live')?.status).toBe('unknown');
    expect(persisted.tasks.find((item) => item.taskId === 'task_ok')?.result).toBe('done');
  });

  it('does not apply an update after the task has left the live statuses', async () => {
    const store = await TaskStore.open(file);
    await store.create(task({ status: 'running', result: null }));
    await store.update('task_alpha', {
      status: 'unknown',
      error: { category: 'interrupted', message: 'stopped' },
    });
    const raced = await store.update(
      'task_alpha',
      { status: 'completed', result: 'late' },
      { ifStatus: ['accepted', 'running'] },
    );
    expect(raced.status).toBe('unknown');
    expect(raced.result).toBeNull();
  });

  it('rejects a duplicate requestKey', async () => {
    const store = await TaskStore.open(file);
    await store.create(task());
    await expect(store.create(task({ taskId: 'task_other' }))).rejects.toBeInstanceOf(
      DuplicateRequestKeyError,
    );
  });
});

describe('TaskStore batches', () => {
  function batch(overrides: Partial<TaskBatch> = {}): TaskBatch {
    return {
      batchId: 'batch_one',
      requestKey: 'batch-key',
      requestFingerprint: batchFingerprint([{ workerId: 'wrk_alpha', message: 'hello' }]),
      createdAt: '2026-10-30T00:00:00.000Z',
      tasks: [
        { workerId: 'wrk_alpha', taskId: 'task_alpha', dispatchStatus: 'accepted' },
        {
          workerId: 'wrk_beta',
          taskId: null,
          dispatchStatus: 'rejected',
          errorCategory: 'WORKER_NOT_FOUND',
          errorMessage: 'no worker with id wrk_beta',
        },
      ],
      ...overrides,
    };
  }

  it('persists batch records with their task mapping across reloads', async () => {
    const store = await TaskStore.open(file);
    await store.create(task());
    await store.createBatch(batch());

    const reloaded = await TaskStore.open(file);
    const restored = reloaded.getBatch('batch_one');
    expect(restored).toMatchObject({
      requestKey: 'batch-key',
      tasks: [
        { workerId: 'wrk_alpha', taskId: 'task_alpha', dispatchStatus: 'accepted' },
        { workerId: 'wrk_beta', taskId: null, dispatchStatus: 'rejected' },
      ],
    });
    expect(reloaded.getBatchByRequestKey('batch-key')?.batchId).toBe('batch_one');
    expect(reloaded.listBatches()).toHaveLength(1);
  });

  it('opens a pre-batch file with no batches field as an empty batch list', async () => {
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: 1, tasks: [task()] }),
      'utf8',
    );
    const store = await TaskStore.open(file);
    expect(store.list()).toHaveLength(1);
    expect(store.listBatches()).toEqual([]);
  });

  it('rejects a batch whose requestKey is claimed by a task and vice versa', async () => {
    const store = await TaskStore.open(file);
    await store.create(task({ requestKey: 'claimed' }));
    await expect(
      store.createBatch(batch({ requestKey: 'claimed' })),
    ).rejects.toBeInstanceOf(DuplicateRequestKeyError);

    await store.createBatch(batch());
    await expect(
      store.create(task({ taskId: 'task_late', requestKey: 'batch-key' })),
    ).rejects.toBeInstanceOf(DuplicateRequestKeyError);
  });

  it('refuses a batch file that references a task id the store does not have', async () => {
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        tasks: [],
        batches: [
          {
            batchId: 'batch_orphan',
            requestKey: 'orphan',
            requestFingerprint: 'fp',
            createdAt: '2026-10-30T00:00:00.000Z',
            tasks: [{ workerId: 'wrk_a', taskId: 'task_ghost', dispatchStatus: 'accepted' }],
          },
        ],
      }),
      'utf8',
    );
    await expect(TaskStore.open(file)).rejects.toBeInstanceOf(TaskStoreCorruptedError);
  });

  it('refuses a malformed batches field instead of dropping it silently', async () => {
    const original = JSON.stringify({ schemaVersion: 1, tasks: [], batches: 'not-an-array' });
    await writeFile(file, original, 'utf8');
    await expect(TaskStore.open(file)).rejects.toBeInstanceOf(TaskStoreCorruptedError);
    expect(await readFile(file, 'utf8')).toBe(original);
  });
});

describe('redactSensitive', () => {
  it('strips credential-shaped text and bounds the length', () => {
    const text = redactSensitive('failed api_key=super-secret and sk-abcdefghijklmnopqrstuvwxyz', 40);
    expect(text).not.toContain('super-secret');
    expect(text).not.toContain('sk-abc');
    expect(text.length).toBeLessThanOrEqual(41);
  });
});
