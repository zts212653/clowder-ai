import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type AppearanceImage,
  appearanceImageIdSchema,
  appearanceImageSchema,
  chatBackgroundMetadataSchema,
  chatBackgroundSchema,
} from '@cat-cafe/shared';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  readChatBackgroundPreferences,
  saveChatBackgroundPreference,
} from '../config/user-preferences-chat-background.js';
import { readUserPreferencesStrict, updateUserPreferences } from '../config/user-preferences-store.js';
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
  const denied = userId ? resolveOwnerGate(userId, { errorMessage: 'Owner identity required' }) : { status: 401 };
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
  const directory = join(opts.projectRoot, '.cat-cafe', 'appearance-images');
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
  const images = () => readUserPreferencesStrict(opts.projectRoot).appearance?.background.images ?? [];
  const saveImages = (images: AppearanceImage[]) =>
    updateUserPreferences(opts.projectRoot, (current) => ({
      ...current,
      appearance: { ...current.appearance, background: { ...current.appearance?.background, images } },
    }));
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
  app.get('/api/config/chat-background/images', async (request, reply) => {
    if (!owner(request, reply)) return { error: 'Owner identity required' };
    return { images: images() };
  });
  app.post('/api/config/chat-background/images', async (request, reply) => {
    if (!owner(request, reply)) return { error: 'Owner identity required' };
    const file = await request.file();
    const mime = appearanceImageSchema.shape.mime.safeParse(file?.mimetype);
    if (!file || !mime.success) return reply.status(400).send({ error: 'Unsupported image' });
    const bytes = await file.toBuffer();
    const current = images();
    if (current.length >= 20) return reply.status(409).send({ error: 'Background catalogue is full' });
    const id = 'user.' + randomUUID();
    const image: AppearanceImage = {
      id,
      name: file.filename,
      mime: mime.data,
      source: `/api/config/chat-background/images/${id}`,
    };
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, id), bytes, { flag: 'wx', mode: 0o600 });
    try {
      saveImages([...current, image]);
    } catch (error) {
      unlinkSync(join(directory, id));
      throw error;
    }
    return image;
  });
  app.get<{ Params: { id: string } }>('/api/config/chat-background/images/:id', async (request, reply) => {
    if (!owner(request, reply)) return { error: 'Owner identity required' };
    const id = appearanceImageIdSchema.safeParse(request.params.id);
    const image = id.success && images().find((image) => image.id === id.data);
    if (!image) return reply.status(404).send({ error: 'Background image not found' });
    return reply
      .type(image.mime)
      .header('Cache-Control', 'private, no-store')
      .header('X-Content-Type-Options', 'nosniff')
      .send(readFileSync(join(directory, image.id)));
  });
  app.delete<{ Params: { id: string } }>('/api/config/chat-background/images/:id', async (request, reply) => {
    if (!owner(request, reply)) return { error: 'Owner identity required' };
    const id = appearanceImageIdSchema.safeParse(request.params.id);
    const current = images();
    const image = id.success && current.find((image) => image.id === id.data);
    if (!image) return reply.status(404).send({ error: 'Background image not found' });
    const remaining = current.filter((entry) => entry.id !== image.id);
    saveImages(remaining);
    unlinkSync(join(directory, image.id));
    return { images: remaining };
  });
}
