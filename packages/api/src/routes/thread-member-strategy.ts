/**
 * #921: PATCH /api/threads/:id/members/:catId/session-strategy
 *
 * Expose the per-member session strategy (resume / reborn) that was
 * implemented in PR #834 / #836 but lacked an API surface.
 *
 * GET returns the current strategy (undefined = default resume).
 * PATCH sets or clears it.
 */

import { catIdSchema } from '@cat-cafe/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { canAccessThread, isSharedDefaultThread } from '../domains/guides/guide-state-access.js';
import { resolveHeaderUserId } from '../utils/request-identity.js';

const strategySchema = z.object({
  strategy: z.enum(['resume', 'reborn']).nullable(),
});

export interface ThreadMemberStrategyRouteOptions {
  threadStore: {
    get(id: string): { id: string; createdBy: string } | null | Promise<{ id: string; createdBy: string } | null>;
    updateMemberSessionStrategy(
      threadId: string,
      catId: string,
      strategy: 'resume' | 'reborn' | null,
    ): void | Promise<void>;
    getMemberSessionStrategy?(
      threadId: string,
      catId: string,
      userId: string,
    ): 'resume' | 'reborn' | undefined | Promise<'resume' | 'reborn' | undefined>;
  };
}

export const threadMemberStrategyRoutes: FastifyPluginAsync<ThreadMemberStrategyRouteOptions> = async (app, opts) => {
  const { threadStore } = opts;

  // GET /api/threads/:id/members/:catId/session-strategy
  app.get<{ Params: { id: string; catId: string } }>(
    '/api/threads/:id/members/:catId/session-strategy',
    async (request, reply) => {
      const userId = resolveHeaderUserId(request);
      if (!userId) {
        reply.status(401);
        return { error: 'Identity required' };
      }

      const { id, catId } = request.params;
      const catParsed = catIdSchema().safeParse(catId);
      if (!catParsed.success) {
        reply.status(400);
        return { error: 'Invalid catId' };
      }

      const thread = await threadStore.get(id);
      if (!thread) {
        reply.status(404);
        return { error: 'Thread not found' };
      }
      if (!canAccessThread(thread, userId)) {
        reply.status(403);
        return { error: 'Access denied' };
      }
      if (isSharedDefaultThread(thread)) {
        reply.status(400);
        return { error: 'Session strategy is not available on the shared default thread' };
      }

      const current = threadStore.getMemberSessionStrategy
        ? await threadStore.getMemberSessionStrategy(id, catId, userId)
        : undefined;

      return { threadId: id, catId, strategy: current ?? 'resume' };
    },
  );

  // PATCH /api/threads/:id/members/:catId/session-strategy
  app.patch<{ Params: { id: string; catId: string } }>(
    '/api/threads/:id/members/:catId/session-strategy',
    async (request, reply) => {
      const userId = resolveHeaderUserId(request);
      if (!userId) {
        reply.status(401);
        return { error: 'Identity required' };
      }

      const { id, catId } = request.params;
      const catParsed = catIdSchema().safeParse(catId);
      if (!catParsed.success) {
        reply.status(400);
        return { error: 'Invalid catId' };
      }

      const parsed = strategySchema.safeParse(request.body);
      if (!parsed.success) {
        reply.status(400);
        return { error: 'strategy must be "resume", "reborn", or null', details: parsed.error.issues };
      }

      const thread = await threadStore.get(id);
      if (!thread) {
        reply.status(404);
        return { error: 'Thread not found' };
      }
      if (!canAccessThread(thread, userId)) {
        reply.status(403);
        return { error: 'Access denied' };
      }
      // Shared default thread stores strategy by thread+cat only (not per-user),
      // so allowing writes here would leak one user's preference to all others.
      if (isSharedDefaultThread(thread)) {
        reply.status(400);
        return { error: 'Session strategy cannot be set on the shared default thread' };
      }

      await threadStore.updateMemberSessionStrategy(id, catId, parsed.data.strategy);

      return { ok: true, threadId: id, catId, strategy: parsed.data.strategy ?? 'resume' };
    },
  );
};
