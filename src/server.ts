import { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { AgentRuntimeAdapter } from './contracts/runtime.js';
import type { SendMessageResult, WorkerView } from './contracts/worker.js';
import type { SessionRegistry } from './storage/sessionRegistry.js';
import { WorkerManager, WorkerToolError } from './workers/workerManager.js';

export const BRIDGE_NAME = 'agent-session-bridge';
export const BRIDGE_VERSION = '0.3.0';
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

const taskStatusSchema = z.enum(['accepted', 'running', 'completed', 'failed', 'unknown']);

const associationSchema = z.enum(['confirmed', 'unconfirmed', 'unavailable']);

const progressEntrySchema = z.object({
  at: z.string(),
  kind: z.string(),
  summary: z.string(),
});

const usageOutputSchema = z.object({
  input_tokens: z.number(),
  cached_input_tokens: z.number(),
  cache_write_input_tokens: z.number(),
  output_tokens: z.number(),
  reasoning_output_tokens: z.number(),
});

const taskErrorSchema = z.object({
  category: z.string(),
  message: z.string(),
});

const dispatchInputSchema = z.object({
  workerId: z.string().min(1),
  message: z.string().min(1),
  requestKey: z.string().min(1).max(256),
});

const dispatchOutputSchema = z.object({
  taskId: z.string(),
  workerId: z.string(),
  status: taskStatusSchema,
  replayed: z.boolean(),
});

const taskIdInputSchema = z.object({
  taskId: z.string().min(1),
});

const taskStatusOutputSchema = z.object({
  taskId: z.string(),
  workerId: z.string(),
  status: taskStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  nativeThreadId: z.string().nullable(),
  progress: z.array(progressEntrySchema),
  errorCategory: z.string().nullable(),
  errorMessage: z.string().nullable(),
  association: associationSchema,
  associationDetail: z.string().nullable(),
});

const taskResultOutputSchema = z.object({
  taskId: z.string(),
  workerId: z.string(),
  status: z.enum(['completed', 'failed', 'unknown', 'NOT_READY']),
  nativeThreadId: z.string().nullable(),
  response: z.string().nullable(),
  usage: usageOutputSchema.nullable(),
  completedAt: z.string().nullable(),
  error: taskErrorSchema.nullable(),
  message: z.string().nullable(),
  association: associationSchema,
  associationDetail: z.string().nullable(),
});

/**
 * Creates the MCP server. Keeps the INIT-02 tools and adds asynchronous
 * task dispatch: `dispatch_worker_task`, `get_task_status`, `get_task_result`.
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
        'exists until the first send_worker_message or dispatch_worker_task turn starts.',
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

  server.registerTool(
    'dispatch_worker_task',
    {
      title: 'Dispatch Worker Task',
      description:
        'Accepts one worker message and returns a taskId immediately. ' +
        'status "accepted" means the task was recorded in this MCP server process, ' +
        'not that the worker finished. Poll get_task_status and read get_task_result. ' +
        'The same requestKey and message replay the original task; a different message ' +
        'or worker for that key is a conflict. A busy worker is rejected and not queued. ' +
        'The turn stops if this server process exits.',
      inputSchema: dispatchInputSchema,
      outputSchema: dispatchOutputSchema,
    },
    async (args) => {
      try {
        const result = await deps.manager.dispatchTask(args.workerId, args.message, args.requestKey);
        return ok(result);
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_task_status',
    {
      title: 'Get Task Status',
      description:
        'Returns the durable status of one asynchronous worker task: state, timestamps, ' +
        'a bounded progress summary, any known native thread id, and the error category. ' +
        'Does not include the final assistant message.',
      inputSchema: taskIdInputSchema,
      outputSchema: taskStatusOutputSchema,
    },
    async (args) => {
      try {
        return ok(deps.manager.getTaskStatus(args.taskId));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    'get_task_result',
    {
      title: 'Get Task Result',
      description:
        'Returns the final assistant message and token usage when the task completed. ' +
        'status NOT_READY means the turn is still accepted or running. ' +
        'failed and unknown do not include an invented response. ' +
        'unknown tasks are not re-executed.',
      inputSchema: taskIdInputSchema,
      outputSchema: taskResultOutputSchema,
    },
    async (args) => {
      try {
        return ok(deps.manager.getTaskResult(args.taskId));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  return server;
}

export type { WorkerView };
