import { redactSensitive } from '../storage/redact.js';
import { latestTasksByWorker, type WatchTask, type WatchWorker } from './registry.js';

/**
 * Renders the multi-worker status board. Pure function over the loaded
 * registry/task data so it is trivially testable.
 */

const STATE_LABEL: Record<string, string> = {
  pending_initialization: 'pending',
  initializing: 'init',
  initialization_uncertain: 'uncertain',
  ready: 'ready',
  error: 'error',
  busy: 'BUSY',
};

function ago(iso: string | null, now: number): string {
  if (!iso) return '';
  const delta = now - Date.parse(iso);
  if (!Number.isFinite(delta) || delta < 0) return '';
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function taskLine(task: WatchTask, now: number): string {
  const bits: string[] = [task.status.toUpperCase()];
  if (task.status === 'running' && task.startedAt) {
    bits[0] = `RUNNING ${ago(task.startedAt, now)}`;
  } else if (task.updatedAt) {
    bits[0] = `${task.status.toUpperCase()} ${ago(task.updatedAt, now)} ago`;
  }
  const last = task.progress[task.progress.length - 1];
  if (last) bits.push(`last: ${redactSensitive(last.summary, 50)}`);
  if (task.status === 'completed' && task.result) {
    bits.push(`"${redactSensitive(task.result, 60)}"`);
  }
  if (task.error) bits.push(`err ${task.error.category}`);
  if (task.usage) bits.push(`${task.usage.input_tokens}in/${task.usage.output_tokens}out`);
  return `    ${task.taskId}  ${bits.join(' · ')}`;
}

export function renderBoard(
  workers: WatchWorker[],
  tasks: WatchTask[],
  opts: { now?: number; readable?: boolean } = {},
): string {
  const now = opts.now ?? Date.now();
  const latest = latestTasksByWorker(tasks);
  const lines: string[] = [];
  const hh = new Date(now).toTimeString().slice(0, 8);
  lines.push(`worker-session-bridge watch        ${hh}`);
  lines.push('─'.repeat(46));
  if (opts.readable === false) lines.push('  (data files unreadable this tick — retrying)');
  if (workers.length === 0) lines.push('  no workers registered');
  for (const worker of workers) {
    const state = STATE_LABEL[worker.state] ?? worker.state;
    const thread = worker.threadId ? `thread ${worker.threadId.slice(0, 8)}` : 'no thread';
    const model = worker.model ?? 'default-model';
    lines.push(`${worker.name.padEnd(14)} ${worker.workerId.padEnd(18)} ${state.padEnd(9)} ${thread.padEnd(16)} ${model}`);
    const task = latest.get(worker.workerId);
    if (task) lines.push(taskLine(task, now));
  }
  lines.push('─'.repeat(46));
  lines.push('Ctrl+C exits · npm run watch -- --follow <worker> for live messages');
  return lines.join('\n');
}
