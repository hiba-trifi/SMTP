type ShutdownHandler = () => Promise<void>;

const handlers: ShutdownHandler[] = [];
let shuttingDown = false;

export function onShutdown(handler: ShutdownHandler): void {
  handlers.push(handler);
}

export function isShuttingDown(): boolean {
  return shuttingDown;
}

async function gracefulShutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  process.stderr.write(
    JSON.stringify({
      ts: new Date().toISOString(),
      level: 'info',
      msg: `Received ${signal}, shutting down gracefully…`,
    }) + '\n',
  );

  for (const handler of handlers) {
    try {
      await handler();
    } catch (err) {
      process.stderr.write(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: 'error',
          msg: 'Shutdown handler error',
          error: String(err),
        }) + '\n',
      );
    }
  }

  process.exit(0);
}

process.on('SIGTERM', () => {
  gracefulShutdown('SIGTERM');
});
process.on('SIGINT', () => {
  gracefulShutdown('SIGINT');
});
