import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import multipart from '@fastify/multipart';
import type { FastifyPluginAsync } from 'fastify';
import { resolveUserId } from '../utils/request-identity.js';
import { getDefaultUploadDir } from '../utils/upload-paths.js';

const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MiB

type DetectedAudioType = 'wav' | 'mp3' | 'ogg' | 'webm';

function detectAudioType(buffer: Buffer): DetectedAudioType | null {
  if (buffer.length < 12) return null;
  // WAV: "RIFF" .... "WAVE"
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x41 &&
    buffer[10] === 0x56 &&
    buffer[11] === 0x45
  )
    return 'wav';
  // MP3: ID3 tag or MPEG sync word
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return 'mp3';
  if (buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0) return 'mp3';
  // OGG: "OggS"
  if (buffer[0] === 0x4f && buffer[1] === 0x67 && buffer[2] === 0x67 && buffer[3] === 0x53) return 'ogg';
  // WebM: EBML header (0x1A 0x45 0xDF 0xA3)
  if (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return 'webm';
  return null;
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
    if (!resolveUserId(req)) {
      return reply.status(401).send({ error: 'Identity required', code: 'AUTH_REQUIRED' });
    }

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

    const detected = detectAudioType(buffer);
    if (!detected) {
      return reply.status(415).send({
        error: 'Unrecognized audio format. Supported: WAV, MP3, OGG, WebM',
        code: 'AUDIO_FORMAT_UNRECOGNIZED',
      });
    }

    const uploadDir = getDefaultUploadDir(process.env.UPLOAD_DIR);
    await mkdir(uploadDir, { recursive: true });
    const filename = `ref-audio-${Date.now()}-${randomUUID().slice(0, 8)}.${detected}`;
    await writeFile(join(uploadDir, filename), buffer);

    return { url: `/uploads/${filename}` };
  });
};
