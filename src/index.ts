import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createServer } from './server.js';

const handle = serveStdio(() => createServer(), {
  onerror(error) {
    console.error('[agent-session-bridge] transport error:', error);
  },
});

console.error('[agent-session-bridge] MCP server listening on stdio');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void handle.close().finally(() => process.exit(0));
  });
}
