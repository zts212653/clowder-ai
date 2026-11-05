import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AVATAR_RAW_FILE_LIMIT_BYTES } from '@cat-cafe/shared';
import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import { detectImageMime } from '../utils/image-mime.js';
import { getDefaultUploadDir } from '../utils/upload-paths.js';

const ACCEPTED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;
type AcceptedMime = (typeof ACCEPTED_IMAGE_MIME)[number];

function isAcceptedMime(mime: string): mime is AcceptedMime {
  return (ACCEPTED_IMAGE_MIME as readonly string[]).includes(mime);
}

function extForMime(mime: AcceptedMime): string {
  if (mime === 'image/jpeg') return 'jpg';
  return mime.split('/')[1] ?? 'bin';
}

export const avatarsRoutes: FastifyPluginAsync = async (app) => {
  await app.register(multipart, {
    limits: {
      fileSize: AVATAR_RAW_FILE_LIMIT_BYTES,
      files: 1,
    },
  });

  // Plugin-scope error handler. Encapsulated to this plugin so it does not
  // affect other routes (e.g. preview screenshot keeps its own default behavior).
  app.setErrorHandler((error, _request, reply) => {
    if (error.code === 'FST_REQ_FILE_TOO_LARGE' || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send({
        error: '头像文件过大',
        code: 'PAYLOAD_TOO_LARGE',
        maxBytes: AVATAR_RAW_FILE_LIMIT_BYTES,
      });
    }
    return reply.send(error);
  });

  app.post('/api/uploads/avatar', async (req, reply) => {
    const file = await req.file();
    if (!file) {
      return reply.status(400).send({
        error: 'No file uploaded',
        code: 'NO_FILE',
      });
    }

    // Always drain the multipart stream first, regardless of whether the request
    // ultimately succeeds. With @fastify/multipart, returning before consuming
    // file.file leaves the stream attached and ties up connection resources.
    // toBuffer() handles the drain and gives us the bytes for sniffing below.
    const buffer = await file.toBuffer();

    // Defensive size check after buffering — multipart's limits.fileSize already
    // throws FST_REQ_FILE_TOO_LARGE during streaming, but we double-check here
    // in case the streaming truncation behavior changes.
    if (buffer.length > AVATAR_RAW_FILE_LIMIT_BYTES) {
      return reply.status(413).send({
        error: '头像文件过大',
        code: 'PAYLOAD_TOO_LARGE',
        maxBytes: AVATAR_RAW_FILE_LIMIT_BYTES,
      });
    }

    if (!isAcceptedMime(file.mimetype)) {
      return reply.status(415).send({
        error: 'Unsupported image type. Allowed: png, jpeg, webp',
        code: 'UNSUPPORTED_MEDIA_TYPE',
        accepted: ACCEPTED_IMAGE_MIME,
      });
    }

    // Server-side magic byte sniffing — mimetype on the multipart part is
    // client-supplied and cannot be trusted. Reject if bytes do not match a
    // supported image signature, or if the detected type disagrees with the
    // declared one.
    const sniffed = detectImageMime(buffer);
    // Preserve the avatar contract: GIF signatures remain unsupported here.
    const detected = sniffed !== null && isAcceptedMime(sniffed) ? sniffed : null;
    if (detected === null || detected !== file.mimetype) {
      return reply.status(415).send({
        error: 'File contents do not match the declared image type',
        code: 'IMAGE_FORMAT_MISMATCH',
        declared: file.mimetype,
        detected,
      });
    }

    const ext = extForMime(file.mimetype);
    const uploadDir = getDefaultUploadDir(process.env.UPLOAD_DIR);
    await mkdir(uploadDir, { recursive: true });
    const filename = `avatar-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
    await writeFile(join(uploadDir, filename), buffer);
    return { url: `/uploads/${filename}` };
  });
};
