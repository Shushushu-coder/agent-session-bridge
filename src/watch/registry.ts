import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { TaskUsage } from '../contracts/task.js';

/**
 * Lenient, strictly read-only access to the bridge data files.
 *
 * The bridge writes workers.json/tasks.json atomically (tmp + rename), so
 * reads always see a complete document — but this watcher must never use
 * TaskStore.open / SessionRegistry.open: those have recovery side effects
 * (marking live tasks unknown and persisting them). Unknown keys are
 * stripped, not rejected, so older files still load.
 */

const progressSchema = z.object({
  at: z.string(),
  kind: z.string(),
  summary: z.string(),
});

const usageSchema = z.object({
  input_tokens: z.number(),
  cached_input_tokens: z.number(),
  cache_write_input_tokens: z.number(),
  output_tokens: z.number(),
  reasoning_output_tokens: z.number(),
});

const workerSchema = z.object({
  workerId: z.string(),
  name: z.string(),
  threadId: z.string().nullable(),
  workspacePath: z.string(),
  model: z.string().optional(),
  state: z.string(),
});

const taskSchema = z.object({
  taskId: z.string(),
  workerId: z.string(),
  status: z.string(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  updatedAt: z.string(),
  completedAt: z.string().nullable(),
  nativeThreadId: z.string().nullable(),
  requestedModel: z.string().nullable().default(null),
  progress: z.array(progressSchema),
  result: z.string().nullable(),
  usage: usageSchema.nullable(),
  error: z.object({ category: z.string(), message: z.string() }).nullable(),
});

const workersFileSchema = z.object({ workers: z.array(workerSchema) });
const tasksFileSchema = z.object({ tasks: z.array(taskSchema) });

export type WatchWorker = z.infer<typeof workerSchema>;
export type WatchTask = z.infer<typeof taskSchema>;

export interface BoardData {
  workers: WatchWorker[];
  tasks: WatchTask[];
  /** False when a file exists but could not be parsed this tick. */
  readable: boolean;
}

/** Last task per worker, ordered by createdAt. */
export function latestTasksByWorker(tasks: WatchTask[]): Map<string, WatchTask> {
  const latest = new Map<string, WatchTask>();
  for (const task of tasks) {
    const current = latest.get(task.workerId);
    if (!current || task.createdAt > current.createdAt) latest.set(task.workerId, task);
  }
  return latest;
}

async function readJson(path: string): Promise<unknown | null> {
  if (!existsSync(path)) return undefined; // missing file = empty data
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null; // unreadable / mid-write on an unexpected path
  }
}

export async function loadBoardData(dataDir: string): Promise<BoardData> {
  const workersRaw = await readJson(join(dataDir, 'workers.json'));
  const tasksRaw = await readJson(join(dataDir, 'tasks.json'));

  const workersParsed =
    workersRaw === undefined ? { success: true as const, data: { workers: [] } }
    : workersRaw === null ? { success: false as const }
    : workersFileSchema.safeParse(workersRaw);
  const tasksParsed =
    tasksRaw === undefined ? { success: true as const, data: { tasks: [] } }
    : tasksRaw === null ? { success: false as const }
    : tasksFileSchema.safeParse(tasksRaw);

  const workersOk = workersParsed.success;
  const tasksOk = tasksParsed.success;
  return {
    workers: workersOk ? workersParsed.data.workers : [],
    tasks: tasksOk ? tasksParsed.data.tasks : [],
    readable: workersOk && tasksOk,
  };
}
