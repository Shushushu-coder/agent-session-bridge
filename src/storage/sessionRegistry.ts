import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { WorkerRecord, WorkerState } from '../contracts/worker.js';

export const REGISTRY_SCHEMA_VERSION = 1;

const workerStateSchema = z.enum([
  'pending_initialization',
  'initializing',
  'ready',
  'initialization_uncertain',
  'error',
]);

const workerRecordSchema = z.object({
  workerId: z.string().min(1),
  name: z.string().min(1),
  runtime: z.literal('codex'),
  threadId: z.string().min(1).nullable(),
  workspacePath: z.string().min(1),
  model: z.string().min(1).optional(),
  // Optional so files written before session tagging existed still load.
  sessionId: z.string().min(1).nullable().default(null),
  state: workerStateSchema,
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
  lastError: z.string().optional(),
});

const registryFileSchema = z.object({
  schemaVersion: z.literal(REGISTRY_SCHEMA_VERSION),
  workers: z.array(workerRecordSchema),
});

export class RegistryCorruptedError extends Error {
  constructor(
    readonly filePath: string,
    reason: string,
  ) {
    super(`Session registry at ${filePath} is corrupted: ${reason}`);
    this.name = 'RegistryCorruptedError';
  }
}

export class DuplicateWorkerError extends Error {
  constructor(workerId: string) {
    super(`Worker ${workerId} already exists in the registry`);
    this.name = 'DuplicateWorkerError';
  }
}

/**
 * Persists managed-worker records as a single JSON file.
 *
 * - Writes are atomic: serialize to a unique temp file in the same directory,
 *   then `rename` over the target (atomic replace on NTFS/POSIX).
 * - Writes within this process are serialized through a promise chain so
 *   concurrent updates cannot interleave or lose data.
 * - On `open`, a missing file means an empty registry; a present-but-invalid
 *   file throws {@link RegistryCorruptedError} — never silently reset.
 * - Records whose persisted state is `initializing` crashed mid-first-turn:
 *   they are surfaced as `initialization_uncertain` with an explanatory
 *   `lastError` (in memory; the file is left untouched for forensics).
 */
export class SessionRegistry {
  private readonly workers = new Map<string, WorkerRecord>();
  private order: string[] = [];
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(readonly filePath: string) {}

  static async open(filePath: string): Promise<SessionRegistry> {
    const registry = new SessionRegistry(filePath);
    if (!existsSync(filePath)) return registry;

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(filePath, 'utf8'));
    } catch (error) {
      throw new RegistryCorruptedError(
        filePath,
        `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const result = registryFileSchema.safeParse(parsed);
    if (!result.success) {
      throw new RegistryCorruptedError(filePath, `schema mismatch: ${result.error.message}`);
    }
    for (const record of result.data.workers) {
      if (registry.workers.has(record.workerId)) {
        throw new RegistryCorruptedError(
          filePath,
          `duplicate workerId ${record.workerId}`,
        );
      }
      registry.workers.set(
        record.workerId,
        record.state === 'initializing'
          ? {
              ...record,
              state: 'initialization_uncertain',
              lastError:
                'interrupted during first turn; native thread existence is unknown',
            }
          : { ...record },
      );
      registry.order.push(record.workerId);
    }
    return registry;
  }

  list(): WorkerRecord[] {
    return this.order.map((id) => ({ ...this.workers.get(id)! }));
  }

  get(workerId: string): WorkerRecord | undefined {
    const record = this.workers.get(workerId);
    return record ? { ...record } : undefined;
  }

  async add(record: WorkerRecord): Promise<void> {
    if (this.workers.has(record.workerId)) {
      throw new DuplicateWorkerError(record.workerId);
    }
    this.workers.set(record.workerId, { ...record });
    this.order.push(record.workerId);
    await this.persist();
  }

  async update(
    workerId: string,
    patch: Partial<Omit<WorkerRecord, 'workerId' | 'createdAt'>>,
  ): Promise<WorkerRecord> {
    const record = this.workers.get(workerId);
    if (!record) {
      throw new Error(`Cannot update unknown worker ${workerId}`);
    }
    const next: WorkerRecord = {
      ...record,
      ...patch,
      workerId: record.workerId,
      createdAt: record.createdAt,
      updatedAt: patch.updatedAt ?? new Date().toISOString(),
    };
    this.workers.set(workerId, next);
    await this.persist();
    return { ...next };
  }

  /** Atomic, serialized write of the whole registry file. */
  private persist(): Promise<void> {
    const write = this.writeChain.then(() => this.writeNow());
    this.writeChain = write.catch(() => {});
    return write;
  }

  private async writeNow(): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    const payload = {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      workers: this.list(),
    };
    try {
      await writeFile(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
      await rename(tmp, this.filePath);
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  }
}

/** Re-export the state type used by schema/records. */
export type { WorkerState };
