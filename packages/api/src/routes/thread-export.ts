import type { FastifyPluginAsync } from 'fastify';
import { resolveFrontendBaseUrl } from '../config/frontend-origin.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { ImageExporter } from '../services/ImageExporter.js';
import { resolveUserId } from '../utils/request-identity.js';

export { resolveFrontendBaseUrl } from '../config/frontend-origin.js';

export interface ThreadExportRoutesOptions {
  threadStore: IThreadStore;
}

export const threadExportRoutes: FastifyPluginAsync<ThreadExportRoutesOptions> = async (fastify, opts) => {
  const { threadStore } = opts;

  // Plugin-scoped singleton ImageExporter for browser reuse across requests
  let sharedExporter: ImageExporter | null = null;

  // Cleanup Puppeteer browser via Fastify lifecycle (awaited by app.close())
  fastify.addHook('onClose', async () => {
    if (sharedExporter) {
      await sharedExporter.close();
      sharedExporter = null;
    }
  });

  fastify.post<{ Params: { threadId: string } }>('/api/threads/:threadId/export-image', async (request, reply) => {
    const { threadId } = request.params;
    const userId = resolveUserId(request);

    // Identity required
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    // Validate threadId format
    if (!threadId || typeof threadId !== 'string') {
      return reply.code(400).send({ error: 'Invalid threadId' });
    }

    // Thread ownership check
    const thread = await threadStore.get(threadId);
    if (!thread) {
      reply.status(404);
      return { error: 'Thread not found' };
    }

    // System-created threads (e.g., 'default') are accessible to all users
    // User-created threads require ownership match
    if (thread.createdBy !== 'system' && thread.createdBy !== userId) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    try {
      // Construct frontend URL
      const env = process.env;
      const frontendUrl = resolveFrontendBaseUrl(env, fastify.log);
      const url = `${frontendUrl}/thread/${threadId}`;

      fastify.log.info(`Exporting thread ${threadId} to image from ${url}`);

      // Use shared exporter (browser reuse across requests)
      const exporter = sharedExporter ?? (sharedExporter = new ImageExporter());
      const imageBuffer = await exporter.capture(url, userId);

      reply.type('image/png').send(imageBuffer);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      fastify.log.error({ error: errorMessage }, 'Image export failed');
      return reply.code(500).send({
        error: 'Export failed',
        message: errorMessage,
      });
    }
  });
};
