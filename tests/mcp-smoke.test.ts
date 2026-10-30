import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TSX_CLI = fileURLToPath(new URL('../node_modules/tsx/dist/cli.mjs', import.meta.url));
const FAKE_SERVER = fileURLToPath(new URL('./support/fakeStdioServer.ts', import.meta.url));
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
  return spawnProcess(process.execPath, [SERVER_ENTRY], dataDir, extraEnv);
}

async function spawnFakeServer(dataDir: string, extraEnv: Record<string, string> = {}) {
  return spawnProcess(process.execPath, [TSX_CLI, FAKE_SERVER], dataDir, extraEnv);
}

async function spawnProcess(
  command: string,
  args: string[],
  dataDir: string,
  extraEnv: Record<string, string>,
) {
  const transport = new StdioClientTransport({
    command,
    args,
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
          version: '0.3.0',
        });
        await client.ping();

        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name).sort()).toEqual([
          'bridge_status',
          'create_worker',
          'dispatch_worker_batch',
          'dispatch_worker_task',
          'get_batch_results',
          'get_batch_status',
          'get_task_result',
          'get_task_status',
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

  it(
    'reads a completed task after restart and marks a non-terminal task unknown without calling a model',
    { timeout: 30000 },
    async () => {
      const dataDir = await tempDataDir();
      const now = new Date().toISOString();
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
      await writeFile(
        join(dataDir, 'tasks.json'),
        JSON.stringify({
          schemaVersion: 1,
          tasks: [
            {
              taskId: 'task_done',
              workerId: 'wrk_restart1',
              requestKey: 'done',
              requestFingerprint: 'abc',
              status: 'completed',
              createdAt: now,
              startedAt: now,
              updatedAt: now,
              completedAt: now,
              nativeThreadId: 'thread_from_past_life',
              progress: [{ at: now, kind: 'turn.completed', summary: 'turn completed' }],
              result: 'stored reply',
              usage: {
                input_tokens: 8,
                cached_input_tokens: 0,
                cache_write_input_tokens: 0,
                output_tokens: 4,
                reasoning_output_tokens: 0,
              },
              error: null,
            },
            {
              taskId: 'task_open',
              workerId: 'wrk_restart1',
              requestKey: 'open',
              requestFingerprint: 'def',
              status: 'running',
              createdAt: now,
              startedAt: now,
              updatedAt: now,
              completedAt: null,
              nativeThreadId: null,
              progress: [],
              result: null,
              usage: null,
              error: null,
            },
          ],
        }),
        'utf8',
      );

      const server = await spawnServer(dataDir);
      try {
        const done = await server.client.callTool({
          name: 'get_task_result',
          arguments: { taskId: 'task_done' },
        });
        expect(done.structuredContent).toMatchObject({
          status: 'completed',
          response: 'stored reply',
          nativeThreadId: 'thread_from_past_life',
          association: 'confirmed',
          usage: { input_tokens: 8, output_tokens: 4 },
        });
        const open = await server.client.callTool({
          name: 'get_task_result',
          arguments: { taskId: 'task_open' },
        });
        expect(open.structuredContent).toMatchObject({
          status: 'unknown',
          response: null,
          error: { category: 'interrupted' },
        });
      } finally {
        await server.client.close();
        await waitForExit(server.pid);
      }
    },
  );

  it(
    'completes an async task inside one fake MCP process and reads it after restart',
    { timeout: 30000 },
    async () => {
      const dataDir = await tempDataDir();
      const first = await spawnFakeServer(dataDir, { AGENT_SESSION_BRIDGE_STREAM_DELAY_MS: '200' });
      let taskId = '';
      try {
        const created = await first.client.callTool({
          name: 'create_worker',
          arguments: { name: 'proc', workspacePath: 'E:\\ws' },
        });
        const workerId = (created.structuredContent as { worker: { workerId: string } }).worker.workerId;
        const dispatched = await first.client.callTool({
          name: 'dispatch_worker_task',
          arguments: { workerId, message: 'process task', requestKey: 'proc-1' },
        });
        expect(dispatched.structuredContent).toMatchObject({ status: 'accepted', replayed: false });
        expect(processAlive(first.pid)).toBe(true);
        taskId = (dispatched.structuredContent as { taskId: string }).taskId;

        let sawRunning = false;
        let status = '';
        for (let attempt = 0; attempt < 40 && status !== 'completed'; attempt += 1) {
          const current = await first.client.callTool({
            name: 'get_task_status',
            arguments: { taskId },
          });
          status = (current.structuredContent as { status: string }).status;
          if (status === 'running') sawRunning = true;
          if (status !== 'completed') await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(sawRunning).toBe(true);
        const result = await first.client.callTool({
          name: 'get_task_result',
          arguments: { taskId },
        });
        expect(result.structuredContent).toMatchObject({
          status: 'completed',
          response: 'FAKE_ASYNC:process task',
        });
        expect(processAlive(first.pid)).toBe(true);
      } finally {
        await first.client.close();
        await waitForExit(first.pid);
      }

      const second = await spawnFakeServer(dataDir);
      try {
        const again = await second.client.callTool({
          name: 'get_task_result',
          arguments: { taskId },
        });
        expect(again.structuredContent).toMatchObject({
          status: 'completed',
          response: 'FAKE_ASYNC:process task',
        });
      } finally {
        await second.client.close();
        await waitForExit(second.pid);
      }
    },
  );

  it(
    'dispatches a worker batch over stdio and reads aggregated status and results',
    { timeout: 30000 },
    async () => {
      const dataDir = await tempDataDir();
      const server = await spawnFakeServer(dataDir, {
        AGENT_SESSION_BRIDGE_STREAM_DELAY_MS: '150',
      });
      try {
        const workerIds: string[] = [];
        for (const name of ['backend', 'frontend', 'reviewer']) {
          const created = await server.client.callTool({
            name: 'create_worker',
            arguments: { name, workspacePath: 'E:\\ws' },
          });
          workerIds.push(
            (created.structuredContent as { worker: { workerId: string } }).worker.workerId,
          );
        }

        const dispatched = await server.client.callTool({
          name: 'dispatch_worker_batch',
          arguments: {
            requestKey: 'smoke-batch',
            tasks: workerIds.map((workerId, index) => ({
              workerId,
              message: `read-only audit ${index}`,
            })),
          },
        });
        expect(dispatched.isError).toBeFalsy();
        expect(dispatched.structuredContent).toMatchObject({
          dispatchedCount: 3,
          rejectedCount: 0,
          replayed: false,
        });
        const batchId = (dispatched.structuredContent as { batchId: string }).batchId;

        let settled = false;
        for (let attempt = 0; attempt < 60 && !settled; attempt += 1) {
          const status = await server.client.callTool({
            name: 'get_batch_status',
            arguments: { batchId },
          });
          settled = (status.structuredContent as { allSettled: boolean }).allSettled;
          if (!settled) await new Promise((resolve) => setTimeout(resolve, 25));
        }
        expect(settled).toBe(true);

        const results = await server.client.callTool({
          name: 'get_batch_results',
          arguments: { batchId },
        });
        expect(results.structuredContent).toMatchObject({
          allCompleted: true,
          resultCounts: { completed: 3, failed: 0, unknown: 0, notReady: 0 },
          usageTotals: { input_tokens: 9 },
        });
      } finally {
        await server.client.close();
        await waitForExit(server.pid);
      }
    },
  );

  it(
    'restores a finished batch and its task mapping after a process restart',
    { timeout: 30000 },
    async () => {
      const dataDir = await tempDataDir();
      const now = new Date().toISOString();
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
      await writeFile(
        join(dataDir, 'tasks.json'),
        JSON.stringify({
          schemaVersion: 1,
          tasks: [
            {
              taskId: 'task_batch_member',
              workerId: 'wrk_restart1',
              requestKey: 'old-batch#wrk_restart1',
              requestFingerprint: 'fp',
              status: 'completed',
              createdAt: now,
              startedAt: now,
              updatedAt: now,
              completedAt: now,
              nativeThreadId: 'thread_from_past_life',
              progress: [],
              result: 'batch member reply',
              usage: null,
              error: null,
            },
          ],
          batches: [
            {
              batchId: 'batch_restored',
              requestKey: 'old-batch',
              requestFingerprint: 'fpb',
              createdAt: now,
              tasks: [
                { workerId: 'wrk_restart1', taskId: 'task_batch_member', dispatchStatus: 'accepted' },
                {
                  workerId: 'wrk_gone',
                  taskId: null,
                  dispatchStatus: 'rejected',
                  errorCategory: 'WORKER_NOT_FOUND',
                },
              ],
            },
          ],
        }),
        'utf8',
      );

      const server = await spawnServer(dataDir);
      try {
        const status = await server.client.callTool({
          name: 'get_batch_status',
          arguments: { batchId: 'batch_restored' },
        });
        expect(status.isError).toBeFalsy();
        expect(status.structuredContent).toMatchObject({
          totalTasks: 2,
          dispatchedCount: 1,
          rejectedCount: 1,
          allSettled: true,
          allCompleted: true,
          statusCounts: { completed: 1 },
        });

        const results = await server.client.callTool({
          name: 'get_batch_results',
          arguments: { batchId: 'batch_restored' },
        });
        expect(results.structuredContent).toMatchObject({
          resultCounts: { completed: 1 },
          tasks: [
            {
              workerId: 'wrk_restart1',
              taskId: 'task_batch_member',
              status: 'completed',
              response: 'batch member reply',
            },
            {
              workerId: 'wrk_gone',
              taskId: null,
              dispatchStatus: 'rejected',
              errorCategory: 'WORKER_NOT_FOUND',
            },
          ],
        });
      } finally {
        await server.client.close();
        await waitForExit(server.pid);
      }
    },
  );

  it(
    'marks an in-flight task unknown when the MCP client disconnects',
    { timeout: 30000 },
    async () => {
      const dataDir = await tempDataDir();
      const server = await spawnFakeServer(dataDir, { AGENT_SESSION_BRIDGE_STREAM_DELAY_MS: '5000' });
      const created = await server.client.callTool({
        name: 'create_worker',
        arguments: { name: 'proc', workspacePath: 'E:\\ws' },
      });
      const workerId = (created.structuredContent as { worker: { workerId: string } }).worker.workerId;
      const dispatched = await server.client.callTool({
        name: 'dispatch_worker_task',
        arguments: { workerId, message: 'do not outlive the client', requestKey: 'proc-stop' },
      });
      const taskId = (dispatched.structuredContent as { taskId: string }).taskId;
      expect(processAlive(server.pid)).toBe(true);
      await server.client.close();
      expect(await waitForExit(server.pid)).toBe(true);

      const restarted = await spawnFakeServer(dataDir);
      try {
        const result = await restarted.client.callTool({
          name: 'get_task_result',
          arguments: { taskId },
        });
        expect(result.structuredContent).toMatchObject({
          status: 'unknown',
          response: null,
        });
      } finally {
        await restarted.client.close();
        await waitForExit(restarted.pid);
      }
    },
  );
});
