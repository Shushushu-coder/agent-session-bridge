import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AgentRuntimeAdapter } from './contracts/runtime.js';
import type { SendMessageResult, WorkerView } from './contracts/worker.js';
import type { SessionRegistry } from './storage/sessionRegistry.js';
import { WorkerManager, WorkerToolError } from './workers/workerManager.js';

export const BRIDGE_NAME = 'agent-session-bridge';
export const BRIDGE_VERSION = '0.2.0';
export const BRIDGE_RUNTIME = 'codex';

export interface BridgeDeps {
  manager: WorkerManager;
  adapter: AgentRuntimeAdapter;
  registry: SessionRegistry;
}

export interface BridgeStatus {
  name: string;
  version: string;
  status: 'ready' | 'runtime_unavailable';
  runtime: string;
  runtimeConnected: boolean;
  sessionOrchestrationAvailable: boolean;
  managedWorkers: number;
}

/**
 * Honest status: `runtimeConnected` reflects whether the Codex adapter could
 * resolve its CLI binary at startup; `sessionOrchestrationAvailable` reflects
 * that the registry and worker tools are wired (they still report
 * RUNTIME_UNAVAILABLE honestly when the runtime is down).
 */
export function getBridgeStatus(deps: BridgeDeps): BridgeStatus {
  const connected = deps.adapter.isConnected();
  return {
    name: BRIDGE_NAME,
    version: BRIDGE_VERSION,
    status: connected ? 'ready' : 'runtime_unavailable',
    runtime: BRIDGE_RUNTIME,
    runtimeConnected: connected,
    sessionOrchestrationAvailable: true,
    managedWorkers: deps.registry.list().length,
  };
}

const workerStateSchema = z.enum([
  'pending_initialization',
  'initializing',
  'ready',
  'initialization_uncertain',
  'error',
  'busy',
]);

const workerViewSchema = z.object({
  workerId: z.string(),
  name: z.string(),
  runtime: z.string(),
  threadId: z.string().nullable(),
  workspacePath: z.string(),
  model: z.string().optional(),
  state: workerStateSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  lastError: z.string().optional(),
});

const bridgeStatusSchema = z.object({
  name: z.string(),
  version: z.string(),
  status: z.enum(['ready', 'runtime_unavailable']),
  runtime: z.string(),
  runtimeConnected: z.boolean(),
  sessionOrchestrationAvailable: z.boolean(),
  managedWorkers: z.number(),
});

const createWorkerInputSchema = z.object({
  name: z.string().min(1).max(128),
  workspacePath: z.string().min(1),
  model: z.string().min(1).optional(),
});

const sendWorkerMessageInputSchema = z.object({
  workerId: z.string().min(1),
  message: z.string().min(1),
});

const getWorkerInputSchema = z.object({
  workerId: z.string().min(1),
});

const sendMessageOutputSchema = z.object({
  workerId: z.string(),
  status: z.enum(['completed', 'failed', 'busy']),
  state: workerStateSchema,
  threadId: z.string().nullable(),
  response: z.string().optional(),
  error: z.string().optional(),
});

type TextContent = { type: 'text'; text: string };
interface ToolReply {
  [key: string]: unknown;
  content: TextContent[];
  structuredContent?: unknown;
  isError?: boolean;
}

function ok(data: unknown): ToolReply {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    structuredContent: data,
  };
}

function toolError(error: unknown): ToolReply {
  if (error instanceof WorkerToolError) {
    const payload = { error: { code: error.code, message: error.message } };
    return {
      content: [{ type: 'text', text: JSON.stringify(payload) }],
      structuredContent: payload,
      isError: true,
    };
  }
  throw error;
}

/**
 * Creates the MCP server. Exposes `bridge_status` plus the worker tools
 * introduced in INIT-02: `create_worker`, `list_workers`, `get_worker`,
 * `send_worker_message`.
 */
export function createServer(deps: BridgeDeps): McpServer {
  const server = new McpServer({ name: BRIDGE_NAME, version: BRIDGE_VERSION });

  server.registerTool(
    'bridge_status',
    {
      title: 'Bridge Status',
      description:
        'Reports the current status of agent-session-bridge: runtime connectivity, ' +
        'orchestration availability, and managed worker count.',
      outputSchema: bridgeStatusSchema,
    },
    async () => ok(getBridgeStatus(deps)),
  );

  server.registerTool(
    'create_worker',
    {
      title: 'Create Worker',
      description:
        'Registers a new persistent Codex worker bound to a git workspace. ' +
        'The worker starts in pending_initialization — no native Codex thread ' +
        'exists until the first send_worker_message turn completes.',
      inputSchema: createWorkerInputSchema,
      outputSchema: z.object({ worker: workerViewSchema }),
    },
    async (args) => {
      try {
        const worker = await deps.manager.createWorker({
          name: args.name,
          workspacePath: args.workspacePath,
          ...(args.model ? { model: args.model } : {}),
        });
        return ok({ worker });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'list_workers',
    {
      title: 'List Workers',
      description: 'Lists all managed workers with identity, state, and native thread id.',
      outputSchema: z.object({ workers: z.array(workerViewSchema) }),
    },
    async () => ok({ workers: deps.manager.listWorkers() }),
  );

  server.registerTool(
    'get_worker',
    {
      title: 'Get Worker',
      description: 'Returns the identity and current state of one managed worker.',
      inputSchema: getWorkerInputSchema,
      outputSchema: z.object({ worker: workerViewSchema }),
    },
    async (args) => {
      try {
        return ok({ worker: deps.manager.getWorker(args.workerId) });
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'send_worker_message',
    {
      title: 'Send Worker Message',
      description:
        'Runs one prompt turn on a managed worker and waits for completion. ' +
        'First message initializes the native Codex thread; later messages ' +
        'resume it. Returns busy when the worker is mid-turn — V1 runs at ' +
        'most one turn per worker at a time.',
      inputSchema: sendWorkerMessageInputSchema,
      outputSchema: sendMessageOutputSchema,
    },
    async (args) => {
      try {
        const result: SendMessageResult = await deps.manager.sendMessage(
          args.workerId,
          args.message,
        );
        return ok(result);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

export type { WorkerView };
