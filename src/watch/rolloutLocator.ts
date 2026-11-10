import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Locates the Codex rollout file for a native thread id.
 *
 * Codex writes `rollout-<created>-<threadId>.jsonl` under
 * `~/.codex/sessions/<YYYY>/<MM>/<DD>/`. The watcher only reads these
 * files; nothing here writes into the Codex directory.
 */

export function defaultSessionsRoot(home: string = homedir()): string {
  return join(home, '.codex', 'sessions');
}

const MAX_DEPTH = 4;

async function walk(dir: string, threadId: string, depth: number, found: string[]): Promise<void> {
  if (depth > MAX_DEPTH) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory — treat as empty
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      await walk(join(dir, entry.name), threadId, depth + 1, found);
    } else if (
      entry.isFile() &&
      entry.name.startsWith('rollout-') &&
      entry.name.endsWith(`${threadId}.jsonl`)
    ) {
      found.push(join(dir, entry.name));
    }
  }
}

/**
 * Full scan for the rollout file matching `threadId`. Returns the newest
 * match by mtime, or null. The scan is shallow (sessions/YYYY/MM/DD) and
 * cheap enough to repeat while waiting for a thread's first turn.
 */
export async function findRolloutFile(
  threadId: string,
  sessionsRoot: string = defaultSessionsRoot(),
): Promise<string | null> {
  if (!existsSync(sessionsRoot)) return null;
  const found: string[] = [];
  await walk(sessionsRoot, threadId, 0, found);
  if (found.length === 0) return null;
  if (found.length === 1) return found[0]!;
  let best = found[0]!;
  let bestMtime = 0;
  for (const file of found) {
    const { mtimeMs } = await stat(file);
    if (mtimeMs > bestMtime) {
      bestMtime = mtimeMs;
      best = file;
    }
  }
  return best;
}
