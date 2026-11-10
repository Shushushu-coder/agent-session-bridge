import type { TaskProgressEntry, TaskStatus, TaskUsage } from './task.js';
import type { WorkerView } from './worker.js';

/** Bounded per-task summary used by the board snapshot. No prompt/result text. */
export interface BoardTaskSummary {
  taskId: string;
  workerId: string;
  requestKey: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  progressCount: number;
  lastProgress: TaskProgressEntry | null;
  usage: TaskUsage | null;
  errorCategory: string | null;
  errorMessage: string | null;
}

/** One worker row in the board snapshot: identity plus task aggregation. */
export interface BoardWorkerView extends WorkerView {
  taskCount: number;
  /** Live (accepted/running) task id, when one exists. */
  activeTaskId: string | null;
  /** Summed usage across all of this worker's recorded tasks; null when none did. */
  usageTotals: TaskUsage | null;
  latestTask: BoardTaskSummary | null;
}

export interface BoardBatchSummary {
  batchId: string;
  requestKey: string;
  createdAt: string;
  dispatchedCount: number;
  rejectedCount: number;
  statusCounts: Record<TaskStatus, number>;
  allSettled: boolean;
  allCompleted: boolean;
}

export interface BoardSnapshot {
  generatedAt: string;
  runtimeConnected: boolean;
  workerCount: number;
  workers: BoardWorkerView[];
  recentTasks: BoardTaskSummary[];
  recentBatches: BoardBatchSummary[];
}
