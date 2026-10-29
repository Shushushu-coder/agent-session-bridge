import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SERVER_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));

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

describe('MCP stdio smoke test', () => {
  it(
    'spawns the built server, completes init/listTools/callTool, and leaves no child process',
    { timeout: 30000 },
    async () => {
      expect(existsSync(SERVER_ENTRY)).toBe(true);

      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [SERVER_ENTRY],
        stderr: 'pipe',
      });

      const stderrChunks: Buffer[] = [];
      transport.stderr?.on('data', (chunk: Buffer) => stderrChunks.push(chunk));

      const client = new Client({ name: 'mcp-smoke-client', version: '0.0.1' });
      await client.connect(transport);
      const pid = transport.pid;
      expect(pid).toBeTypeOf('number');

      try {
        // initialize handshake already done by connect(); verify negotiated identity.
        expect(client.getServerVersion()).toEqual({
          name: 'agent-session-bridge',
          version: '0.1.0',
        });
        await client.ping();

        // Tool discovery: only the implemented tool is advertised.
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toEqual(['bridge_status']);

        // Tool call: structured content carries the honest skeleton status.
        const result = await client.callTool({ name: 'bridge_status', arguments: {} });
        expect(result.isError).toBeFalsy();
        expect(result.structuredContent).toMatchObject({
          name: 'agent-session-bridge',
          status: 'skeleton_ready',
          runtime: 'codex',
          runtimeConnected: false,
          sessionOrchestrationAvailable: false,
        });

        // No session-orchestration tools are prematurely exposed.
        const names = tools.map((t) => t.name);
        for (const forbidden of ['session_create', 'session_resume', 'task_dispatch', 'task_run']) {
          expect(names).not.toContain(forbidden);
        }
      } finally {
        await client.close();
      }

      // Child process must be fully gone after close.
      expect(await waitForExit(pid!)).toBe(true);

      // Diagnostics go to stderr, never to the stdio protocol channel —
      // reaching this assertion at all proves stdout stayed clean JSON-RPC.
      const stderrText = Buffer.concat(stderrChunks).toString('utf8');
      expect(stderrText).not.toContain('"jsonrpc"');
    },
  );
});
