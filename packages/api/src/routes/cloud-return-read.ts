import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { readCloudReturn } from '../domains/cats/services/cloud-bridge/read-cloud-return.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

const ref = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\u0000-\u001f\u007f]+$/u);
const paramsSchema = z.object({ threadId: ref, sourceMessageId: ref });
const querySchema = z
  .object({ targetCatId: ref.max(128), dispatchInvocationId: ref, replyMessageId: ref.optional() })
  .strict();

export const cloudReturnReadRoutes: FastifyPluginAsync<{
  messageStore: IMessageStore;
  threadStore: IThreadStore;
}> = async (app, deps) => {
  app.get<{ Params: { threadId: string; sourceMessageId: string } }>(
    '/api/threads/:threadId/messages/:sourceMessageId/cloud-return',
    async (request, reply) => {
      const userId = resolveStrictUserId(request);
      if (!userId) return reply.code(401).send({ error: 'Identity required' });
      const query = querySchema.safeParse(request.query);
      const params = paramsSchema.safeParse(request.params);
      if (!query.success || !params.success) return reply.code(400).send({ error: 'Invalid cloud return scope' });
      const { threadId, sourceMessageId } = params.data;
      const thread = await deps.threadStore.get(threadId);
      if (!thread || thread.createdBy !== userId || thread.deletedAt)
        return reply.code(404).send({ error: 'Thread not found' });
      const result = await readCloudReturn(deps.messageStore, {
        ...query.data,
        threadId,
        sourceMessageId,
        userId,
      });
      reply.header('Cache-Control', 'no-store');
      return result ?? { status: 'unverified' };
    },
  );
};
