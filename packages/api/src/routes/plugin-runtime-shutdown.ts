import type { FastifyInstance } from 'fastify';

/** Stop plugin operations while HTTP requests can still observe their cancellation. */
export function registerPluginRuntimeShutdown(
  app: FastifyInstance,
  runtime: { shutdown(reason: string): Promise<void> },
): void {
  // onClose runs after HTTP drain; an action waiting on plugin cancellation
  // would keep that drain alive and prevent its own shutdown from starting.
  app.addHook('preClose', async () => {
    app.log.info('[api] Plugin shutdown entered');
    await runtime.shutdown('api_shutdown');
    app.log.info('[api] Plugin shutdown complete');
  });
}
