import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MessageSearchAccessError, type MessageSearchService } from '../domains/memory/MessageSearchService.js';
import { resolveDirectLocalAuthorizationUserId } from '../utils/request-identity.js';

const sourceSchema = z
  .object({
    threadId: z.string().min(1).max(256),
    messageId: z.string().min(1).max(256).optional(),
    contentRevision: z.string().min(1).max(128).optional(),
    contextCount: z.coerce.number().int().min(0).max(3).optional(),
  })
  .refine((input) => (!input.contentRevision && input.contextCount === undefined) || !!input.messageId);

export function registerMessageNavigationSourceRoute(app: FastifyInstance, service?: MessageSearchService) {
  app.get('/api/evidence/navigation-source', async (request, reply) => {
    const parsed = sourceSchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid source coordinates' });
    const userId = resolveDirectLocalAuthorizationUserId(request);
    if (!userId) return reply.status(401).send({ error: 'Source identity required' });
    if (!service) return reply.status(503).send({ error: 'Source verification unavailable' });
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new DOMException('Source read deadline exceeded', 'TimeoutError')),
      15_000,
    );
    const disconnect = () => {
      if (!reply.raw.writableEnded) controller.abort(new DOMException('Source client disconnected', 'AbortError'));
    };
    request.raw.once('aborted', disconnect);
    reply.raw.once('close', disconnect);
    try {
      const result = await service.resolveNavigationReference(
        parsed.data,
        { userId, viewer: { type: 'user' } },
        parsed.data.contextCount,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      return result ?? reply.status(404).send({ error: 'Source unavailable' });
    } catch (error) {
      if (error instanceof MessageSearchAccessError)
        return reply.status(403).send({ error: 'Source is not accessible' });
      request.log.warn({ err: error }, 'Source verification unavailable');
      return reply.status(503).send({ error: 'Source verification unavailable' });
    } finally {
      clearTimeout(timeout);
      request.raw.removeListener('aborted', disconnect);
      reply.raw.removeListener('close', disconnect);
    }
  });
}
