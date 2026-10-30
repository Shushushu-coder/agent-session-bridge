/**
 * V1 tasks live only inside this MCP server process. When stdin closes or
 * the process is signalled, in-flight tasks are marked `unknown` and the
 * process exits. They are not re-executed and are not handed to a daemon.
 */
export function installProcessShutdown(options: {
  handle: { close(): Promise<void> };
  abandon: (reason: string) => Promise<void>;
}): void {
  let shuttingDown = false;
  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void options
      .abandon(reason)
      .catch(() => undefined)
      .finally(() => {
        void options.handle
          .close()
          .catch(() => undefined)
          .finally(() => {
            process.exit(0);
          });
      });
  };

  process.stdin.on('end', () => shutdown('stdin closed'));
  process.on('SIGINT', () => shutdown('received SIGINT'));
  process.on('SIGTERM', () => shutdown('received SIGTERM'));
}
