/**
 * Offline end-to-end test: a compiled fake `codex` executable speaks the SDK's
 * JSONL protocol, so the REAL @openai/codex-sdk code path (arg building,
 * subprocess spawn, event parsing, resume) runs without any model call.
 *
 * Requires csc.exe (inbox .NET Framework compiler) and a prior `npm run build`.
 * Skipped automatically when unavailable.
 */
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { CodexRuntimeAdapter } from '../src/runtime/codex/codexRuntimeAdapter.js';

const execFileAsync = promisify(execFile);

const CSC_CANDIDATES = [
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
  'C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe',
];
const csc = CSC_CANDIDATES.find((p) => existsSync(p));
const FIXTURE = fileURLToPath(new URL('./fixtures/FakeCodex.cs', import.meta.url));
const SERVER_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const RUN = csc !== undefined && existsSync(SERVER_ENTRY);

let workDir: string;
let fakeExe: string;

async function ensureFakeBuilt(): Promise<void> {
  if (fakeExe) return;
  workDir = await mkdtemp(join(tmpdir(), 'wsb-e2e-'));
  fakeExe = join(workDir, 'fake-codex.exe');
  await execFileAsync(csc!, ['/nologo', '/target:exe', `/out:${fakeExe}`, FIXTURE], {
    timeout: 60_000,
  });
}

function readArgLog(logFile: string): Promise<string[][]> {
  return readFile(logFile, 'utf8').then((text) =>
    text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line).argv as string[]),
  );
}

afterAll(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

describe.skipIf(!RUN)('codex exec E2E via fake CLI (offline, no model)', () => {
  it('drives a real SDK thread through the fake executable', async () => {
    await ensureFakeBuilt();
    const argvLog = join(workDir, 'argv-adapter.jsonl');
    const adapter = new CodexRuntimeAdapter({
      codexOptions: {
        codexPathOverride: fakeExe,
        env: { ...process.env, FAKE_CODEX_LOG: argvLog } as Record<string, string>,
      },
    });
    await adapter.connect();
    expect(adapter.isConnected()).toBe(true);

    const session = await adapter.createSession({ cwd: workDir });
    expect(session.externalSessionId).toBeUndefined();

    const result = await adapter.runTask(session.id, {
      id: 't1',
      sessionId: session.id,
      prompt: 'first turn',
      status: 'pending',
      createdAt: new Date().toISOString(),
    });

    expect(result.status).toBe('succeeded');
    expect(result.externalSessionId).toMatch(/^thread_/);
    expect(result.output).toContain('FAKE_ECHO: first turn');

    const argv = (await readArgLog(argvLog))[0]!;
    expect(argv).toContain('exec');
    expect(argv).toContain('--experimental-json');
    expect(argv).toContain('--sandbox');
    expect(argv[argv.indexOf('--sandbox') + 1]).toBe('read-only');
    expect(argv).toContain('--cd');
    expect(argv).toContain('approval_policy="never"');
    expect(argv).toContain('web_search="disabled"');
    expect(argv).not.toContain('--skip-git-repo-check');
  }, 60_000);

  it(
    'persists a worker across real server restarts and resumes the same thread',
    { timeout: 90_000 },
    async () => {
      await ensureFakeBuilt();
      const dataDir = join(workDir, 'data');
      const argvLog = join(workDir, 'argv-server.jsonl');
      const env = {
        ...process.env,
        WORKER_SESSION_BRIDGE_DATA_DIR: dataDir,
        WORKER_SESSION_BRIDGE_CODEX_PATH: fakeExe,
        FAKE_CODEX_LOG: argvLog,
      } as Record<string, string>;

      const spawn = async () => {
        const transport = new StdioClientTransport({
          command: process.execPath,
          args: [SERVER_ENTRY],
          stderr: 'pipe',
          env,
        });
        const client = new Client({ name: 'e2e-client', version: '0.0.1' });
        await client.connect(transport);
        return { client, pid: transport.pid! };
      };
      const exitOf = async (pid: number) => {
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          try {
            process.kill(pid, 0);
          } catch {
            return;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      };

      // --- lifetime 1: register + first turn ---
      const first = await spawn();
      const created = await first.client.callTool({
        name: 'create_worker',
        arguments: { name: 'e2e-worker', workspacePath: workDir },
      });
      expect(created.isError).toBeFalsy();
      const workerId = (
        created.structuredContent as { worker: { workerId: string } }
      ).worker.workerId;

      const turn1 = await first.client.callTool({
        name: 'send_worker_message',
        arguments: { workerId, message: 'turn one' },
      });
      expect(turn1.isError).toBeFalsy();
      const turn1Data = turn1.structuredContent as {
        status: string;
        threadId: string;
        response: string;
      };
      expect(turn1Data.status).toBe('completed');
      expect(turn1Data.threadId).toMatch(/^thread_/);
      expect(turn1Data.response).toContain('FAKE_ECHO: turn one');
      await first.client.close();
      await exitOf(first.pid);

      // --- lifetime 2: same registry file, resume persisted thread ---
      const second = await spawn();
      const turn2 = await second.client.callTool({
        name: 'send_worker_message',
        arguments: { workerId, message: 'turn two' },
      });
      expect(turn2.isError).toBeFalsy();
      const turn2Data = turn2.structuredContent as { status: string; threadId: string };
      expect(turn2Data.status).toBe('completed');
      expect(turn2Data.threadId).toBe(turn1Data.threadId);
      await second.client.close();
      await exitOf(second.pid);

      // Process 2's codex exec really was a `resume <threadId>` invocation.
      const calls = await readArgLog(argvLog);
      expect(calls).toHaveLength(2);
      const resumeIdx = calls[1]!.indexOf('resume');
      expect(resumeIdx).toBeGreaterThan(-1);
      expect(calls[1]![resumeIdx + 1]).toBe(turn1Data.threadId);
      expect(calls[0]).not.toContain('resume');
    },
  );

  it(
    'reports a failed turn honestly and marks first-turn-without-id as blocked',
    { timeout: 60_000 },
    async () => {
      await ensureFakeBuilt();
      const dataDir = join(workDir, 'data-fail');
      const env = {
        ...process.env,
        WORKER_SESSION_BRIDGE_DATA_DIR: dataDir,
        WORKER_SESSION_BRIDGE_CODEX_PATH: fakeExe,
        FAKE_CODEX_FAIL: '1',
      } as Record<string, string>;
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER_ENTRY],
        stderr: 'pipe',
        env,
      });
      const client = new Client({ name: 'e2e-client', version: '0.0.1' });
      await client.connect(transport);
      try {
        const created = await client.callTool({
          name: 'create_worker',
          arguments: { name: 'w', workspacePath: workDir },
        });
        const workerId = (
          created.structuredContent as { worker: { workerId: string } }
        ).worker.workerId;

        const sent = await client.callTool({
          name: 'send_worker_message',
          arguments: { workerId, message: 'will fail' },
        });
        expect(sent.isError).toBeFalsy();
        expect(sent.structuredContent).toMatchObject({
          status: 'failed',
          threadId: null,
          state: 'initialization_uncertain',
        });

        const retry = await client.callTool({
          name: 'send_worker_message',
          arguments: { workerId, message: 'retry' },
        });
        expect(retry.isError).toBe(true);
        expect(
          retry.content
            .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
            .map((c) => c.text)
            .join(''),
        ).toContain('STATE_BLOCKED');
      } finally {
        await client.close();
      }
    },
  );
});
