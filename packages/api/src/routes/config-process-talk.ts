import { processTalkChangeSchema } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readProcessTalkPreference, saveProcessTalkPreference } from '../config/user-preferences-process-talk.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

export async function configProcessTalkRoutes(app: FastifyInstance, opts: { projectRoot: string }): Promise<void> {
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

  app.get('/api/config/process-talk', async (request, reply) => {
    const userId = owner(request, reply);
    if (!userId) return { error: 'Owner identity required' };
    try {
      return readProcessTalkPreference(opts.projectRoot, userId);
    } catch (error) {
      request.log.warn({ err: error }, 'Cannot read process-talk preference');
      return reply.code(503).send({ error: 'Process-talk preference is unavailable' });
    }
  });

  app.put('/api/config/process-talk', async (request, reply) => {
    const userId = owner(request, reply);
    if (!userId) return { error: 'Owner identity required' };
    const parsed = processTalkChangeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Invalid process-talk preference' });
    if (parsed.data.expectedOwnerUserId !== userId)
      return reply.code(409).send({ error: 'Owner changed; reload before saving' });
    try {
      return saveProcessTalkPreference(opts.projectRoot, userId, parsed.data.mode);
    } catch (error) {
      request.log.warn({ err: error }, 'Cannot save process-talk preference');
      return reply.code(503).send({ error: 'Process-talk preference could not be saved' });
    }
  });
}
