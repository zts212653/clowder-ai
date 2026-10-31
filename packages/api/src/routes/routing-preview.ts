import { type CatId, catIdSchema } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { AgentRouter } from '../domains/cats/services/agents/routing/AgentRouter.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveUserId } from '../utils/request-identity.js';

const NEW_THREAD_PREVIEW_ID = 'routing-preview:new-thread';

const routingPreviewBodySchema = z.discriminatedUnion('scope', [
  z
    .object({
      scope: z.literal('thread'),
      threadId: z.string().trim().min(1).max(200),
      content: z.string().max(50_000),
    })
    .strict(),
  z
    .object({
      scope: z.literal('new-thread'),
      preferredCats: z.array(catIdSchema()).max(10),
      content: z.string().max(50_000),
    })
    .strict(),
]);

export interface RoutingPreviewRoutesOptions {
  threadStore: IThreadStore;
  router: Pick<AgentRouter, 'previewTargets'>;
}

/** Read-only recipient projection. It never admits a message or mutates participants. */
export const routingPreviewRoutes: FastifyPluginAsync<RoutingPreviewRoutesOptions> = async (app, opts) => {
  app.post('/api/routing/preview', async (request, reply) => {
    const parsed = routingPreviewBodySchema.safeParse(request.body);
    if (!parsed.success) {
      reply.status(400);
      return { error: 'Invalid request body', details: parsed.error.issues };
    }

    const userId = resolveUserId(request, { defaultUserId: 'default-user' });
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    if (parsed.data.scope === 'thread') {
      const thread = await opts.threadStore.get(parsed.data.threadId);
      if (!thread || thread.deletedAt) {
        reply.status(404);
        return { error: 'Thread not found' };
      }
      if (thread.createdBy !== userId && thread.createdBy !== 'system') {
        reply.status(403);
        return { error: 'Only the thread owner can preview routing' };
      }
      return opts.router.previewTargets(parsed.data.content, { threadId: parsed.data.threadId });
    }

    return opts.router.previewTargets(parsed.data.content, {
      threadId: NEW_THREAD_PREVIEW_ID,
      prospectivePreferredCats: parsed.data.preferredCats as CatId[],
    });
  });
};
