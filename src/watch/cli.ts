#!/usr/bin/env node
import { homedir } from 'node:os';
import { join } from 'node:path';
import { formatRolloutLine } from './format.js';
import { renderBoard } from './board.js';
import { loadBoardData, type WatchWorker } from './registry.js';
import { defaultSessionsRoot, findRolloutFile } from './rolloutLocator.js';
import { readTailLines, RolloutTail } from './rolloutTail.js';

/**
 * `bridge watch` — read-only live observer for managed workers.
 *
 * Board mode (default): refreshes the worker/task table in place.
 * Follow mode (--follow <workerId|name>): tails the worker's Codex
 * rollout file and prints message-level events as they land.
 *
 * This process only reads bridge data files and Codex rollout files.
 * It never writes to either store and never touches Codex Desktop.
 */

const defaultDataDir =
  process.env.AGENT_SESSION_BRIDGE_DATA_DIR ?? join(homedir(), '.agent-session-bridge');

interface Args {
  follow: string | undefined;
  dataDir: string;
  intervalMs: number;
  sessionsRoot: string;
  backfillLines: number;
  once: boolean;
  help: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    follow: undefined,
    dataDir: defaultDataDir,
    intervalMs: 500,
    sessionsRoot: defaultSessionsRoot(),
    backfillLines: 40,
    once: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--follow': args.follow = next(); break;
      case '--dir': args.dataDir = next() ?? args.dataDir; break;
      case '--interval': args.intervalMs = Math.max(100, Number(next()) || args.intervalMs); break;
      case '--codex-home': args.sessionsRoot = next() ?? args.sessionsRoot; break;
      case '--lines': args.backfillLines = Math.max(0, Number(next()) || args.backfillLines); break;
      case '--once': args.once = true; break;
      case '--help': case '-h': args.help = true; break;
      default:
        if (arg?.startsWith('--follow=')) args.follow = arg.slice(9);
        else if (arg?.startsWith('--dir=')) args.dataDir = arg.slice(6);
        else if (arg?.startsWith('--codex-home=')) args.sessionsRoot = arg.slice(13);
        else if (arg?.startsWith('--interval=')) args.intervalMs = Math.max(100, Number(arg.slice(11)) || 500);
        else if (arg?.startsWith('--lines=')) args.backfillLines = Math.max(0, Number(arg.slice(8)) || 40);
    }
  }
  return args;
}

const HELP = `agent-session-bridge watch — live worker observer (read-only)

Usage:
  agent-session-bridge-watch                          status board for all workers
  agent-session-bridge-watch --follow <id|name>       live message stream for one worker
  agent-session-bridge-watch --once                   print the board once and exit
  (from a source checkout: npm run watch [-- ...])

Options:
  --follow <workerId|name>   tail that worker's Codex rollout file
  --dir <path>               bridge data dir (default: ~/.agent-session-bridge or env)
  --codex-home <path>        rollout root (default: ~/.codex/sessions)
  --interval <ms>            board refresh interval (default 500)
  --lines <n>                backfill lines in follow mode (default 40)
  --once                     render once, no refresh loop
`;

function resolveWorker(workers: WatchWorker[], query: string): WatchWorker | undefined {
  const byId = workers.find((w) => w.workerId === query);
  if (byId) return byId;
  const byName = workers.filter((w) => w.name === query);
  return byName.length === 1 ? byName[0] : byName[0];
}

async function waitFor<T>(produce: () => Promise<T | undefined>, label: string): Promise<T> {
  for (;;) {
    const value = await produce();
    if (value !== undefined) return value;
    process.stdout.write(`\rwaiting for ${label}…   `);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

function emit(line: string): void {
  const formatted = formatRolloutLine(line);
  if (formatted !== null) process.stdout.write(`${formatted}\n`);
}

async function runFollow(args: Args, query: string): Promise<void> {
  const worker = await waitFor(async () => {
    const { workers } = await loadBoardData(args.dataDir);
    return resolveWorker(workers, query);
  }, `worker ${query}`);

  const withThread = await waitFor(async () => {
    const { workers } = await loadBoardData(args.dataDir);
    const current = workers.find((w) => w.workerId === worker.workerId);
    return current?.threadId ? current : undefined;
  }, `${worker.name} to run its first turn`);
  const threadId = withThread.threadId!;

  const file = await waitFor(
    async () => (await findRolloutFile(threadId, args.sessionsRoot)) ?? undefined,
    `rollout file for thread ${threadId.slice(0, 8)}`,
  );

  process.stdout.write(
    `\nfollowing ${worker.name} (${worker.workerId}) · thread ${threadId}\n${file}\n${'─'.repeat(46)}\n`,
  );
  for (const line of await readTailLines(file, args.backfillLines)) emit(line);
  process.stdout.write(`${'─'.repeat(46)}\n`);

  const tail = new RolloutTail(file, { pollMs: 400, onLines: (lines) => lines.forEach(emit) });
  await tail.start();
  process.on('SIGINT', () => {
    void tail.stop().finally(() => process.exit(0));
  });
}

async function runBoard(args: Args): Promise<void> {
  const tick = async () => {
    const data = await loadBoardData(args.dataDir);
    const out = `${renderBoard(data.workers, data.tasks, { readable: data.readable })}\n`;
    if (args.once) process.stdout.write(out);
    else process.stdout.write(`\x1b[2J\x1b[0;0H${out}`);
  };
  await tick();
  if (args.once) return;
  setInterval(() => void tick(), args.intervalMs);
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (args.follow) await runFollow(args, args.follow);
else await runBoard(args);
