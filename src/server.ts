import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

export const BRIDGE_NAME = 'agent-session-bridge';
export const BRIDGE_VERSION = '0.1.0';
export const BRIDGE_RUNTIME = 'codex';

export interface BridgeStatus {
  name: string;
  version: string;
  status: 'skeleton_ready';
  runtime: string;
  runtimeConnected: boolean;
  sessionOrchestrationAvailable: boolean;
}

/**
 * Returns the honest, current status of the bridge. Until a runtime adapter
 * is wired in (INIT-02+), no worker runtime is connected and no session
 * orchestration is available.
 */
export function getBridgeStatus(): BridgeStatus {
  return {
    name: BRIDGE_NAME,
    version: BRIDGE_VERSION,
    status: 'skeleton_ready',
    runtime: BRIDGE_RUNTIME,
    runtimeConnected: false,
    sessionOrchestrationAvailable: false,
  };
}

const bridgeStatusSchema = z.object({
  name: z.string(),
  version: z.string(),
  status: z.literal('skeleton_ready'),
  runtime: z.string(),
  runtimeConnected: z.boolean(),
  sessionOrchestrationAvailable: z.boolean(),
});

/**
 * Creates the MCP server instance. Only `bridge_status` is exposed in INIT-01;
 * session and task tools are intentionally absent until the runtime adapter
 * exists to back them.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: BRIDGE_NAME, version: BRIDGE_VERSION });

  server.registerTool(
    'bridge_status',
    {
      title: 'Bridge Status',
      description:
        'Reports the current status of agent-session-bridge. No runtime worker is connected yet.',
      outputSchema: bridgeStatusSchema,
    },
    async () => {
      const status = getBridgeStatus();
      return {
        content: [{ type: 'text', text: JSON.stringify(status, null, 2) }],
        structuredContent: status,
      };
    },
  );

  return server;
}
