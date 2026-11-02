import { findMessageSticker } from '@cat-cafe/shared';
import type { FastifyInstance } from 'fastify';
import {
  type MessageStickerDirectories,
  openMessageSticker,
} from '../domains/collaborative-content/collective-artifact/message-sticker-owner.js';
import { resolveSessionUserId } from '../utils/request-identity.js';

/** Local My Café access. Public Channel members use the separately delegated, freshly authorized owner port. */
export function registerMessageStickerRoutes(app: FastifyInstance, directories: MessageStickerDirectories) {
  app.get<{ Params: { stickerId: string } }>('/api/message-stickers/:stickerId', async (request, reply) => {
    if (!resolveSessionUserId(request)) return reply.code(401).send({ error: 'Identity required' });
    const entry = findMessageSticker(request.params.stickerId);
    if (!entry) return reply.code(404).send({ error: 'Unknown sticker' });
    const controller = new AbortController();
    reply.raw.once('close', () => controller.abort());
    try {
      const result = await openMessageSticker(
        directories,
        entry.id,
        async () => {
          controller.signal.throwIfAborted();
          if (!resolveSessionUserId(request)) throw new Error('Session unavailable');
        },
        controller.signal,
      );
      return reply
        .type('image/png')
        .header('cache-control', 'private, no-store')
        .header('x-content-type-options', 'nosniff')
        .header('content-length', entry.byteLength)
        .send(result.body);
    } catch (error) {
      request.log.warn({ err: error, stickerId: entry.id }, 'Original sticker image unavailable');
      return reply.code(503).send({ error: 'Original sticker image unavailable' });
    }
  });
}
