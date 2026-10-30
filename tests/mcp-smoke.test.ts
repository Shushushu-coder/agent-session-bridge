import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const SERVER_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));

const tempDirs: string[] = [];

async function tempDataDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'asb-smoke-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })),
  );
});

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !processAlive(pid);
}

async function spawnServer(dataDir: string, extraEnv: Record<string, string> = {}) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    stderr: 'pipe',
    env: {
      ...process.env,
      AGENT_SESSION_BRIDGE_DATA_DIR: dataDir,
      ...extraEnv,
    } as Record<string, string>,
  });
  const client = new Client({ name: 'mcp-smoke-client', version: '0.0.1' });
  await client.connect(transport);
  return { client, transport, pid: transport.pid! };
}

describe('MCP stdio smoke test', () => {
  it(
    'spawns the built server, completes init/listTools/callTool, and leaves no child process',
    { timeout: 30000 },
    async () => {
      expect(existsSync(SERVER_ENTRY)).toBe(true);

      const dataDir = await tempDataDir();
      const { client, transport, pid } = await spawnServer(dataDir);
      const stderrChunks: Buffer[] = [];
      transport.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      try {
        expect(client.getServerVersion()).toEqual({
          name: 'agent-session-bridge',
          version: '0.2.0',
        });
        await client.ping();

        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual([
          'bridge_status',
          'create_worker',
          'get_worker',
          'list_workers',
          'send_worker_message',
        ]);

        const result = await client.callTool({ name: 'bridge_status', arguments: {} });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          name: 'agent-session-bridge',
          runtime: 'codex',
          sessionOrchestrationAvailable: true,
          managedWorkers: 0,
        });
      } finally {
        await client.close();
      }

      expect(await waitForExit(pid)).toBe(true);
      const stderrText = Buffer.concat(stderrChunks).toString('utf8');
      expect(stderrText).not.toContain('"jsonrpc"');
    },
  );

  it(
    'restores worker identity and thread mapping from the registry across a process restart',
    { timeout: 30000 },
    async () => {
      const dataDir = await tempDataDir();
      const now = new Date().toISOString();
      // A worker that finished initialization in a previous server lifetime.
      await writeFile(
        join(dataDir, 'workers.json'),
        JSON.stringify({
          schemaVersion: 1,
          workers: [
            {
              workerId: 'wrk_restart1',
              name: 'restored',
              runtime: 'codex',
              threadId: 'thread_from_past_life',
              workspacePath: 'E:\\Projects\\agent-session-bridge',
              state: 'ready',
              createdAt: now,
              updatedAt: now,
            },
          ],
        }),
        'utf8',
      );

      const first = await spawnServer(dataDir);
      try {
        const listed = await first.client.callTool({ name: 'list_workers', arguments: {} });
        expect(listed.structuredContent).toMatchObject({
          workers: [
            {
              workerId: 'wrk_restart1',
              threadId: 'thread_from_past_life',
              state: 'ready',
            },
          ],
        });
      } finally {
        await first.client.close();
        await waitForExit(first.pid);
      }

      // Second process instance: same file, same mapping, no re-registration.
      const second = await spawnServer(dataDir);
      try {
        const got = await second.client.callTool({
          name: 'get_worker',
          arguments: { workerId: 'wrk_restart1' },
        });
        expect(got.isError).toBeFalsy();
        expect(got.structuredContent).toMatchObject({
          worker: {
            workerId: 'wrk_restart1',
            threadId: 'thread_from_past_life',
            state: 'ready',
          },
        });
      } finally {
        await second.client.close();
        await waitForExit(second.pid);
      }
    },
  );
});
