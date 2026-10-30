import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WorkspaceCheck {
  ok: boolean;
  /** Absolute, normalized path when ok. */
  resolvedPath?: string;
  error?: string;
}

export type WorkspaceVerifier = (workspacePath: string) => Promise<WorkspaceCheck>;

const GIT_TIMEOUT_MS = 10_000;

/**
 * Default verifier: the path must exist, be a directory, and lie inside a
 * real git work tree (`git rev-parse --is-inside-work-tree`). We never pass
 * `--skip-git-repo-check` to Codex, so a non-git workspace is rejected up
 * front instead of failing cryptically at turn time.
 */
export const verifyGitWorkspace: WorkspaceVerifier = async (workspacePath) => {
  const resolved = resolve(workspacePath);
  let stats;
  try {
    stats = await stat(resolved);
  } catch {
    return { ok: false, error: `workspace path does not exist: ${resolved}` };
  }
  if (!stats.isDirectory()) {
    return { ok: false, error: `workspace path is not a directory: ${resolved}` };
  }
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['-C', resolved, 'rev-parse', '--is-inside-work-tree'],
      { timeout: GIT_TIMEOUT_MS, windowsHide: true },
    );
    if (stdout.trim() === 'true') {
      return { ok: true, resolvedPath: resolved };
    }
    return { ok: false, error: `not inside a git work tree: ${resolved}` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `git work-tree check failed for ${resolved}: ${detail}` };
  }
};
