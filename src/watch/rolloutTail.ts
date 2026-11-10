import { open, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';

/**
 * Byte-offset tail of a rollout JSONL file.
 *
 * Codex appends events to the rollout file while a turn runs. Reads use
 * a byte offset and buffer partial lines *as bytes* — a multi-byte UTF-8
 * character or a half-written line split across two reads is held until
 * its newline arrives, so emitted lines are always complete and valid.
 *
 * fs.watch is a latency hint only; the poll timer does the real work so
 * missed/unsupported watch events never stall the stream.
 */

/** Split a text buffer into complete lines and a trailing partial. */
export function extractLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split('\n');
  const rest = parts.pop() ?? '';
  const lines = parts
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line.length > 0);
  return { lines, rest };
}

export interface TailOptions {
  /** Poll interval; fs.watch may deliver earlier. Default 500ms. */
  pollMs?: number;
  /** Start reading at this byte offset. Default: end of file (follow only). */
  offset?: number;
  onLines(lines: string[]): void;
  onError?(error: unknown): void;
}

export class RolloutTail {
  private offset: number;
  private pending = Buffer.alloc(0);
  private watcher: FSWatcher | null = null;
  private timer: NodeJS.Timeout | null = null;
  private pumping = false;
  private stopped = false;

  constructor(
    private readonly file: string,
    private readonly opts: TailOptions,
  ) {
    this.offset = Math.max(0, opts.offset ?? Number.MAX_SAFE_INTEGER);
  }

  async start(): Promise<void> {
    if (this.offset === Number.MAX_SAFE_INTEGER) {
      this.offset = await this.size();
    }
    try {
      this.watcher = watch(this.file, () => void this.pump());
      this.watcher.on('error', () => undefined); // polling covers failures
    } catch {
      this.watcher = null;
    }
    this.timer = setInterval(() => void this.pump(), this.opts.pollMs ?? 500);
    this.timer.unref?.();
    await this.pump();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.watcher?.close();
    this.watcher = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async size(): Promise<number> {
    try {
      return (await stat(this.file)).size;
    } catch {
      return 0;
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopped) return;
    this.pumping = true;
    try {
      let fh;
      try {
        fh = await open(this.file, 'r');
      } catch {
        return; // file not created yet (or transiently gone) — retry next tick
      }
      try {
        const { size } = await fh.stat();
        if (size < this.offset) {
          // Truncated or replaced — restart from the beginning.
          this.offset = 0;
          this.pending = Buffer.alloc(0);
        }
        if (size > this.offset) {
          const length = size - this.offset;
          const chunk = Buffer.alloc(length);
          const { bytesRead } = await fh.read(chunk, 0, length, this.offset);
          this.offset += bytesRead;
          this.pending = Buffer.concat([this.pending, chunk.subarray(0, bytesRead)]);
          const lastNewline = this.pending.lastIndexOf(0x0a);
          if (lastNewline >= 0) {
            // Every segment before the last newline is a complete line.
            const done = this.pending.subarray(0, lastNewline).toString('utf8');
            this.pending = this.pending.subarray(lastNewline + 1);
            const lines = done
              .split('\n')
              .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
              .filter((line) => line.length > 0);
            if (lines.length > 0) this.opts.onLines(lines);
          }
        }
      } finally {
        await fh.close();
      }
    } catch (error) {
      this.opts.onError?.(error);
    } finally {
      this.pumping = false;
    }
  }
}

/**
 * Read the last `count` complete lines of `file` for backfill context.
 * Reads at most `window` trailing bytes so huge rollouts stay cheap.
 */
export async function readTailLines(
  file: string,
  count: number,
  window = 256 * 1024,
): Promise<string[]> {
  let fh;
  try {
    fh = await open(file, 'r');
  } catch {
    return [];
  }
  try {
    const { size } = await fh.stat();
    const length = Math.min(size, window);
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, size - length);
    const { lines } = extractLines(buf.subarray(0, bytesRead).toString('utf8'));
    // The first line may be a fragment when the window cut mid-line.
    const complete = bytesRead < size ? lines.slice(1) : lines;
    return complete.slice(-count);
  } finally {
    await fh.close();
  }
}
