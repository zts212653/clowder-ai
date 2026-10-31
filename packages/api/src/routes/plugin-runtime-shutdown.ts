import type { FastifyInstance } from 'fastify';

/** Stop plugin operations while HTTP requests can still observe their cancellation. */
export function registerPluginRuntimeShutdown(
  app: FastifyInstance,
  runtime: { shutdown(reason: string): Promise<void> },
): void {
  // onClose runs after HTTP drain; an action waiting on plugin cancellation
  // would keep that drain alive and prevent its own shutdown from starting.
  // Fastify copies a late preClose hook into existing route plugin scopes.
  // Every scope must await the same shutdown, including its failure.
  let shutdown: Promise<void> | undefined;
  app.addHook('preClose', async () => {
    shutdown ??= (async () => {
      app.log.info('[api] Plugin shutdown entered');
      await runtime.shutdown('api_shutdown');
      app.log.info('[api] Plugin shutdown complete');
    })();
    await shutdown;
  });
  app.addHook('onResponse', async () => {
    // A request active when server.close() starts can finish into keep-alive
    // after that call has swept idle sockets. Preserve its response, then reap
    // only idle connections so HTTP drain does not wait for the keep-alive timer.
    if (shutdown) app.server.closeIdleConnections();
  });
}
