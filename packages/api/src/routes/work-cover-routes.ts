import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AVATAR_RAW_FILE_LIMIT_BYTES, setWorkCoverSchema, workReferenceSchema } from '@cat-cafe/shared';
import multipart from '@fastify/multipart';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { listWorkCoverCandidates } from '../domains/collaborative-content/works/cover/cover-candidates.js';
import type { WorkCoverService } from '../domains/collaborative-content/works/cover/cover-service.js';
import { WorkCoverConflictError } from '../domains/collaborative-content/works/cover/cover-store.js';
import { MediaOwnerError } from '../domains/video-studio/content-owner/media-errors.js';
import { detectImageMime } from '../utils/image-mime.js';
import { getDefaultUploadDir } from '../utils/upload-paths.js';
import { directContentHuman } from './content-modification-routes.js';
import { failAsset, sendAsset } from './work-video-asset-routes.js';

const COVER_UPLOAD_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' } as const;
const fixedVersion = workReferenceSchema.extend({ ownerRevision: z.coerce.number().int().positive().safe() }).strict();

function fail(reply: FastifyReply, error: unknown) {
  if (error instanceof WorkCoverConflictError) return reply.code(409).send({ error: 'cover_conflict' });
  if (error instanceof z.ZodError) return reply.code(400).send({ error: 'invalid_request' });
  if (error instanceof MediaOwnerError && error.code === 'media_unavailable')
    return reply.code(404).send({ error: 'cover_unavailable' });
  return failAsset(reply, error);
}

/**
 * The person's own cover entry for the shared cards. The work's own thread is derived by the owner,
 * exactly like the existing context and asset reads, so Home and Works cards need no thread guess.
 */
export async function registerWorkCoverRoutes(app: FastifyInstance, deps: { covers: WorkCoverService }) {
  app.get('/api/works/cover', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const human = directContentHuman(request);
    if (!human) return reply.code(401).send({ error: 'identity_required' });
    try {
      const reference = fixedVersion.parse(request.query);
      return await deps.covers.read({ reference }, { ...human, threadId: '' });
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.get('/api/works/cover/candidates', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const human = directContentHuman(request);
    if (!human) return reply.code(401).send({ error: 'identity_required' });
    try {
      const reference = fixedVersion.parse(request.query);
      return { candidates: await listWorkCoverCandidates(deps.covers, reference, { ...human, threadId: '' }) };
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.post('/api/works/cover', async (request, reply) => {
    reply.header('Cache-Control', 'private, no-store');
    const human = directContentHuman(request);
    if (!human) return reply.code(401).send({ error: 'identity_required' });
    try {
      const { command } = z.object({ command: setWorkCoverSchema }).strict().parse(request.body);
      return await deps.covers.set(command, { ...human, threadId: '' });
    } catch (error) {
      return fail(reply, error);
    }
  });
  app.get('/api/works/cover/image', async (request, reply) => {
    // Fixed cover bytes still depend on the picture's revocable source authority: never cache them.
    reply.header('Cache-Control', 'private, no-store').header('X-Content-Type-Options', 'nosniff');
    const human = directContentHuman(request);
    if (!human) return reply.code(401).send({ error: 'identity_required' });
    try {
      const { coverRevision, ...reference } = fixedVersion
        .extend({ coverRevision: z.coerce.number().int().positive().safe() })
        .strict()
        .parse(request.query);
      const { opened } = await deps.covers.open(reference, coverRevision, { ...human, threadId: '' });
      return await sendAsset(request, reply, opened as Parameters<typeof sendAsset>[2]);
    } catch (error) {
      return fail(reply, error);
    }
  });
  await app.register(async (scope) => {
    await scope.register(multipart, { limits: { fileSize: AVATAR_RAW_FILE_LIMIT_BYTES, files: 1 } });
    scope.setErrorHandler((error, _request, reply) => {
      if (error.code === 'FST_REQ_FILE_TOO_LARGE' || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE')
        return reply.code(413).send({ error: 'cover_too_large', maxBytes: AVATAR_RAW_FILE_LIMIT_BYTES });
      return reply.send(error);
    });
    scope.post('/api/uploads/work-cover', async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store');
      if (!directContentHuman(request)) return reply.code(401).send({ error: 'identity_required' });
      const file = await request.file();
      if (!file) return reply.code(400).send({ error: 'no_file' });
      const buffer = await file.toBuffer();
      const detected = detectImageMime(buffer);
      const extension = detected && detected === file.mimetype ? COVER_UPLOAD_TYPES[detected as 'image/png'] : null;
      if (!extension) return reply.code(415).send({ error: 'unsupported_image' });
      const uploadDir = getDefaultUploadDir(process.env.UPLOAD_DIR);
      await mkdir(uploadDir, { recursive: true });
      const name = `work-cover-${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`;
      await writeFile(join(uploadDir, name), buffer, { flag: 'wx' });
      return { url: `/uploads/${name}` };
    });
  });
}
