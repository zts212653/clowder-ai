import { join } from 'node:path';
import { isContentFileBasename } from '@cat-cafe/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { gifFirstFrame } from '../domains/video-studio/content-owner/gif-image.js';
import { readImageFile } from '../utils/image-storage.js';
import { resolveUserId } from '../utils/request-identity.js';

/** The caller already authorized this file. Decode work stays bounded and originals stay untouched. */
export async function sendStoredGifPoster(reply: FastifyReply, path: string) {
  const pixels = await gifFirstFrame(await readImageFile(path));
  return reply
    .header('Content-Type', 'image/png')
    .header('X-Content-Type-Options', 'nosniff')
    .header('Cache-Control', 'private, no-store')
    .send(pixels);
}

/** Decoding requires the existing user read identity, even though raw uploads are public byte reads. */
export function registerUploadedGifPoster(app: FastifyInstance, uploadDir: string) {
  app.get('/uploads/:filename/gif-poster', async (request, reply) => {
    if (!resolveUserId(request)) return reply.code(401).send({ error: 'identity_required' });
    try {
      const { filename } = z
        .object({ filename: z.string().refine(isContentFileBasename) })
        .strict()
        .parse(request.params);
      return await sendStoredGifPoster(reply, join(uploadDir, filename));
    } catch (error) {
      const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
      return reply.code(missing ? 404 : 400).send({ error: 'gif_preview_unavailable' });
    }
  });
}
