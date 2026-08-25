import type { FastifyPluginAsync } from 'fastify';
import { MessageSelectionResolver } from '../domains/cats/services/context/MessageSelectionResolver.js';
import type { IMessageStore } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

export interface MessageBundleRoutesOptions {
  messageStore: IMessageStore;
  threadStore: IThreadStore;
}

export const messageBundleRoutes: FastifyPluginAsync<MessageBundleRoutesOptions> = async (app, opts) => {
  const resolver = new MessageSelectionResolver(opts);

  app.get('/api/message-bundles/:messageId', async (request, reply) => {
    const userId = resolveStrictUserId(request);
    if (!userId) {
      reply.status(401);
      return { error: 'Identity required (session cookie or X-Cat-Cafe-User header)' };
    }

    const { messageId } = request.params as { messageId: string };
    if (!messageId || messageId.length > 128) {
      reply.status(400);
      return { error: 'Invalid Message Bundle ID' };
    }

    const targetMessage = await opts.messageStore.getById(messageId);
    if (
      !targetMessage ||
      targetMessage.deletedAt !== undefined ||
      targetMessage._tombstone === true ||
      targetMessage.deliveryStatus === 'canceled' ||
      targetMessage.catId !== null ||
      !targetMessage.extra?.messageBundle
    ) {
      reply.status(404);
      return { error: 'Message Bundle not found' };
    }

    const targetThread = await opts.threadStore.get(targetMessage.threadId);
    if (
      targetMessage.userId !== userId ||
      !targetThread ||
      targetThread.deletedAt !== undefined ||
      (targetThread.createdBy !== userId && targetThread.createdBy !== 'system')
    ) {
      reply.status(403);
      return { error: 'Access denied' };
    }

    const resolution = await resolver.resolveCarrier(targetMessage.extra.messageBundle, { userId });
    if (resolution.status === 'invalid') {
      reply.status(409);
      return { error: resolution.reason, code: 'INVALID_MESSAGE_BUNDLE' };
    }

    return {
      messageBundleId: targetMessage.id,
      targetThreadId: targetMessage.threadId,
      createdBy: targetMessage.userId,
      createdAt: targetMessage.timestamp,
      sourceThread: resolution.sourceThread,
      note: resolution.note,
      items: resolution.items,
    };
  });
};
