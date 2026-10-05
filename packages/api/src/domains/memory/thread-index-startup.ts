import type { FastifyInstance } from 'fastify';
import type { IIndexBuilder } from './interfaces.js';

/** Keep persisted lexical history available while the live source catches up. */
export function registerThreadIndexCatchUp(
  app: FastifyInstance,
  builder: IIndexBuilder,
  catchUpVectors: () => void | Promise<unknown> = () => builder.startPassageEmbeddingWarmup(),
): void {
  const controller = new AbortController();
  let scheduled: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;

  const start = (): void => {
    scheduled = undefined;
    if (controller.signal.aborted) return;
    running = builder
      .refreshThreadIndex({
        signal: controller.signal,
        onProgress: (phase, percent) =>
          app.log.info({ phase, percent }, '[api] F102: background thread index progress'),
      })
      .then(async (result) => {
        app.log.info(result, '[api] F102: background thread index caught up');
        if (controller.signal.aborted) return;
        try {
          await catchUpVectors();
        } catch (error) {
          app.log.warn({ error }, '[api] F102: thread vector catch-up failed (non-fatal)');
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        app.log.warn({ error }, '[api] F102: background thread index failed; retrying in 30s');
        scheduled = setTimeout(start, 30_000);
        scheduled.unref();
      });
  };

  app.addHook('onListen', async () => {
    app.log.info('[api] F102: serving persisted thread index; scheduling background catch-up');
    scheduled = setTimeout(start, 0);
    scheduled.unref();
  });
  app.addHook('onClose', async () => {
    controller.abort();
    clearTimeout(scheduled);
    await running;
  });
}
