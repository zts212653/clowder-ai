import { ignoredItemPatchSchema } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  IgnoredItemRevisionConflict,
  readIgnoredItemPreferences,
  saveIgnoredItemPreferences,
} from '../config/user-preferences-ignored-items.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

/** Only personal presentation is written here; approval, Work and Needs Me writers are never called. */
export async function configIgnoredItemRoutes(app: FastifyInstance, opts: { projectRoot: string }): Promise<void> {
  function owner(request: FastifyRequest, reply: FastifyReply): string | null {
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.code(401);
      return null;
    }
    const denied = resolveOwnerGate(userId);
    if (denied) {
      reply.code(denied.status);
      return null;
    }
    return userId;
  }

  app.get('/api/config/ignored-items', async (request, reply) => {
    const ownerUserId = owner(request, reply);
    if (!ownerUserId) return { error: 'Owner identity required' };
    try {
      return readIgnoredItemPreferences(opts.projectRoot, ownerUserId);
    } catch (error) {
      request.log.warn({ err: error }, 'Cannot read ignored item preferences');
      return reply.code(503).send({ error: 'Ignored item preferences are unavailable' });
    }
  });

  app.patch('/api/config/ignored-items', async (request, reply) => {
    const ownerUserId = owner(request, reply);
    if (!ownerUserId) return { error: 'Owner identity required' };
    const parsed = ignoredItemPatchSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid ignored item change' });
    // The body fences the page's actor; it never selects whose preferences are written.
    if (parsed.data.expectedOwnerUserId !== ownerUserId) {
      return reply.code(409).send({ error: 'Ignored item owner changed; refresh before saving' });
    }
    try {
      return saveIgnoredItemPreferences(opts.projectRoot, ownerUserId, parsed.data);
    } catch (error) {
      if (error instanceof IgnoredItemRevisionConflict) {
        return reply.code(409).send({ error: error.message, snapshot: error.snapshot });
      }
      request.log.warn({ err: error }, 'Cannot save ignored item preferences');
      return reply.code(503).send({ error: 'Ignored item preferences could not be saved' });
    }
  });
}
