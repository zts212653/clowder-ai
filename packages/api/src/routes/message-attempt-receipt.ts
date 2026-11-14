import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

const paramsSchema = z.object({ threadId: z.string().min(1).max(100), key: z.string().min(1).max(512) });

/** Owner-only acceptance lookup. Absence is not evidence that an in-flight POST was refused. */
export function registerMessageAttemptReceipt(app: FastifyInstance, store: IMessageStore) {
  app.get('/api/threads/:threadId/message-attempts/:key', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const userId = resolveStrictUserId(request);
    if (!userId) return reply.code(401).send({ error: 'Identity required' });
    const params = paramsSchema.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'Invalid message attempt' });
    try {
      const message = await store.getByIdempotencyKey(userId, params.data.threadId, params.data.key);
      if (
        !message ||
        message.userId !== userId ||
        message.threadId !== params.data.threadId ||
        message.from?.kind !== 'user'
      )
        return { status: 'unknown' };
      return {
        status: message.deliveryStatus === 'delivered' ? 'delivered' : 'accepted',
        userMessage: { id: message.id, timestamp: message.timestamp },
      };
    } catch (error) {
      request.log.warn({ err: error }, 'Message acceptance lookup unavailable');
      return reply.code(503).send({ error: 'Message acceptance lookup unavailable' });
    }
  });
}
