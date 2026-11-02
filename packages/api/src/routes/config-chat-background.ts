import { chatBackgroundMetadataSchema, chatBackgroundSchema } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  readChatBackgroundPreferences,
  saveChatBackgroundPreference,
} from '../config/user-preferences-chat-background.js';
import type { IThreadStore } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { resolveOwnerGate } from '../utils/owner-gate.js';
import { resolveStrictUserId } from '../utils/request-identity.js';

const putSchema = z.discriminatedUnion('scope', [
  z
    .object({
      scope: z.literal('global'),
      background: chatBackgroundSchema.nullable(),
      metadata: chatBackgroundMetadataSchema.optional(),
    })
    .strict(),
  z
    .object({
      scope: z.literal('thread'),
      threadId: z.string().trim().min(1).max(200),
      background: chatBackgroundSchema.nullable(),
      metadata: chatBackgroundMetadataSchema.optional(),
    })
    .strict(),
]);

function owner(request: FastifyRequest, reply: FastifyReply): string | null {
  const userId = resolveStrictUserId(request);
  if (!userId) {
    reply.status(401);
    return null;
  }
  const denied = resolveOwnerGate(userId, { errorMessage: 'Owner identity required' });
  if (denied) {
    reply.status(denied.status);
    return null;
  }
  return userId;
}

export async function configChatBackgroundRoutes(
  app: FastifyInstance,
  opts: { projectRoot: string; threadStore?: Pick<IThreadStore, 'get'> },
): Promise<void> {
  app.get('/api/config/chat-background', async (request, reply) => {
    if (!owner(request, reply)) return { error: 'Owner identity required' };
    return readChatBackgroundPreferences(opts.projectRoot);
  });
  app.put('/api/config/chat-background', async (request, reply) => {
    const userId = owner(request, reply);
    if (!userId) return { error: 'Owner identity required' };
    const parsed = putSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: 'Invalid background', details: parsed.error.issues });
    const input = parsed.data;
    if (input.metadata && input.background?.kind !== 'image')
      return reply.status(400).send({ error: 'Image metadata requires an image' });
    if (input.scope === 'thread') {
      if (!opts.threadStore) return reply.status(503).send({ error: 'Thread store unavailable' });
      const thread = await opts.threadStore.get(input.threadId);
      if (!thread || thread.createdBy !== userId) return reply.status(404).send({ error: 'Thread not found' });
    }
    return saveChatBackgroundPreference(opts.projectRoot, input);
  });
}
