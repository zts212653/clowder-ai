import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import { getDefaultUploadDir } from '../utils/upload-paths.js';

const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MiB
const ACCEPTED_AUDIO_MIME = ['audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/webm', 'audio/ogg'] as const;

function extForAudioMime(mime: string): string {
  if (mime.includes('wav')) return 'wav';
  if (mime.includes('mpeg') || mime.includes('mp3')) return 'mp3';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('ogg')) return 'ogg';
  return 'wav';
}

export const refAudioUploadRoutes: FastifyPluginAsync = async (app) => {
  await app.register(multipart, {
    limits: { fileSize: MAX_AUDIO_BYTES, files: 1 },
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error.code === 'FST_REQ_FILE_TOO_LARGE' || error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply.status(413).send({
        error: '音频文件过大',
        code: 'PAYLOAD_TOO_LARGE',
        maxBytes: MAX_AUDIO_BYTES,
      });
    }
    return reply.send(error);
  });

  app.post('/api/uploads/ref-audio', async (req, reply) => {
    const file = await req.file();
    if (!file) {
      return reply.status(400).send({ error: 'No file uploaded', code: 'NO_FILE' });
    }

    const buffer = await file.toBuffer();
    if (buffer.length > MAX_AUDIO_BYTES) {
      return reply.status(413).send({
        error: '音频文件过大',
        code: 'PAYLOAD_TOO_LARGE',
        maxBytes: MAX_AUDIO_BYTES,
      });
    }

    if (!(ACCEPTED_AUDIO_MIME as readonly string[]).includes(file.mimetype)) {
      return reply.status(415).send({
        error: 'Unsupported audio type. Allowed: wav, mp3, webm, ogg',
        code: 'UNSUPPORTED_MEDIA_TYPE',
      });
    }

    const ext = extForAudioMime(file.mimetype);
    const uploadDir = getDefaultUploadDir(process.env.UPLOAD_DIR);
    await mkdir(uploadDir, { recursive: true });
    const filename = `ref-audio-${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`;
    const absPath = join(uploadDir, filename);
    await writeFile(absPath, buffer);

    return { url: `/uploads/${filename}`, path: absPath };
  });
};
