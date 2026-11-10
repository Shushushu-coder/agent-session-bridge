import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WorkerRecord } from '../src/contracts/worker.js';
import {
  DuplicateWorkerError,
  RegistryCorruptedError,
  SessionRegistry,
} from '../src/storage/sessionRegistry.js';

let dir: string;
let file: string;

function record(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  const now = new Date().toISOString();
  return {
    workerId: 'wrk_test01',
    name: 'tester',
    runtime: 'codex',
    threadId: null,
    workspacePath: 'E:\\ws',
    sessionId: 'ses_test',
    state: 'pending_initialization',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'asb-registry-'));
  file = join(dir, 'workers.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('SessionRegistry', () => {
  it('opens empty when the file does not exist', async () => {
    const registry = await SessionRegistry.open(file);
    expect(registry.list()).toEqual([]);
  });

  it('persists records across reloads', async () => {
    const registry = await SessionRegistry.open(file);
    await registry.add(record());
    await registry.update('wrk_test01', {
      threadId: 'thread_abc',
      state: 'ready',
    });

    const reloaded = await SessionRegistry.open(file);
    const saved = reloaded.get('wrk_test01');
    expect(saved).toMatchObject({
      workerId: 'wrk_test01',
      name: 'tester',
      threadId: 'thread_abc',
      state: 'ready',
    });
    const raw = JSON.parse(await readFile(file, 'utf8'));
    expect(raw.schemaVersion).toBe(1);
  });

  it('preserves update ordering and clears lastError via explicit undefined', async () => {
    const registry = await SessionRegistry.open(file);
    await registry.add(record({ lastError: 'boom' }));
    await registry.update('wrk_test01', { lastError: undefined });
    expect(registry.get('wrk_test01')?.lastError).toBeUndefined();
    expect(registry.list().map((w) => w.workerId)).toEqual(['wrk_test01']);
  });

  it('throws on duplicate workerId', async () => {
    const registry = await SessionRegistry.open(file);
    await registry.add(record());
    await expect(registry.add(record())).rejects.toBeInstanceOf(DuplicateWorkerError);
  });

  it('refuses to silently reset a corrupted file', async () => {
    await writeFile(file, '{ not json !!!', 'utf8');
    await expect(SessionRegistry.open(file)).rejects.toBeInstanceOf(RegistryCorruptedError);
  });

  it('rejects schema mismatches and duplicate ids in the file', async () => {
    await writeFile(file, JSON.stringify({ schemaVersion: 1, workers: [{ bad: true }] }), 'utf8');
    await expect(SessionRegistry.open(file)).rejects.toBeInstanceOf(RegistryCorruptedError);

    const dup = record();
    await writeFile(
      file,
      JSON.stringify({ schemaVersion: 1, workers: [dup, dup] }),
      'utf8',
    );
    await expect(SessionRegistry.open(file)).rejects.toBeInstanceOf(RegistryCorruptedError);
  });

  it('rejects unknown schemaVersion', async () => {
    await writeFile(file, JSON.stringify({ schemaVersion: 99, workers: [] }), 'utf8');
    await expect(SessionRegistry.open(file)).rejects.toBeInstanceOf(RegistryCorruptedError);
  });

  it('normalizes a persisted initializing marker into initialization_uncertain', async () => {
    await writeFile(
      file,
      JSON.stringify({
        schemaVersion: 1,
        workers: [record({ state: 'initializing' })],
      }),
      'utf8',
    );
    const registry = await SessionRegistry.open(file);
    const worker = registry.get('wrk_test01');
    expect(worker?.state).toBe('initialization_uncertain');
    expect(worker?.lastError).toContain('interrupted');
  });

  it('serializes concurrent writes without losing updates', async () => {
    const registry = await SessionRegistry.open(file);
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        registry.add(record({ workerId: `wrk_${i}`, name: `w${i}` })),
      ),
    );
    const reloaded = await SessionRegistry.open(file);
    expect(reloaded.list()).toHaveLength(10);
  });

  it('leaves no temp files behind after writes', async () => {
    const registry = await SessionRegistry.open(file);
    await registry.add(record());
    const entries = await readdir(dir);
    expect(entries).toEqual(['workers.json']);
  });
});
