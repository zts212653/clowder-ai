import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { MessageSearchAnswerPublicationService } from '../domains/memory/MessageSearchAnswerPublicationService.js';
import { resolveDirectLocalAuthorizationUserId } from '../utils/request-identity.js';

const coordinate = z.object({ messageId: z.string().min(1).max(256), blockId: z.string().min(1).max(128) });
export function registerMessageSearchAnswerRoute(app: FastifyInstance, service: MessageSearchAnswerPublicationService) {
  app.get('/api/evidence/answer', async (request, reply) => {
    const userId = resolveDirectLocalAuthorizationUserId(request);
    if (!userId) return reply.status(401).send({ status: 'unavailable' });
    const parsed = coordinate.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ status: 'unavailable' });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const disconnect = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.once('close', disconnect);
    try {
      return await service.read(
        parsed.data.messageId,
        parsed.data.blockId,
        { userId, viewer: { type: 'user' } },
        controller.signal,
      );
    } catch {
      return reply.status(503).send({ status: 'unavailable' });
    } finally {
      clearTimeout(timer);
      reply.raw.removeListener('close', disconnect);
    }
  });
}
