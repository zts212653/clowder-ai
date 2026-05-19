// @ts-check
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';
import { refAudioUploadRoutes } from '../dist/routes/ref-audio-upload.js';

function buildMultipartPayload({ buffer, filename, mimetype, fieldName = 'file' }) {
  const boundary = `----RefAudioBoundary${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${mimetype}\r\n\r\n`,
    'utf8',
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  return {
    payload: Buffer.concat([head, buffer, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function buildNoFileMultipartPayload() {
  const boundary = `----RefAudioBoundary${Math.random().toString(16).slice(2)}`;
  return {
    payload: Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="note"\r\n\r\nmissing file\r\n--${boundary}--\r\n`,
      'utf8',
    ),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function makeWavBuffer(size = 32) {
  const buffer = Buffer.alloc(size);
  buffer.write('RIFF', 0, 'ascii');
  buffer.write('WAVE', 8, 'ascii');
  return buffer;
}

function makeMp3Buffer(size = 32) {
  return Buffer.concat([Buffer.from([0xff, 0xfb]), Buffer.alloc(size - 2)]);
}

function makeOggBuffer(size = 32) {
  return Buffer.concat([Buffer.from('OggS', 'ascii'), Buffer.alloc(size - 4)]);
}

function makeWebmBuffer(size = 32) {
  return Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(size - 4)]);
}

describe('POST /api/uploads/ref-audio', () => {
  /** @type {import('fastify').FastifyInstance} */
  let app;
  /** @type {string} */
  let uploadDir;
  /** @type {string | undefined} */
  let prevUploadDir;
  let trackedFileReads = 0;
  let trackedBufferDrains = 0;

  before(async () => {
    uploadDir = await mkdtemp(join(tmpdir(), 'ref-audio-route-'));
    prevUploadDir = process.env.UPLOAD_DIR;
    process.env.UPLOAD_DIR = uploadDir;
    app = Fastify();
    app.addHook('preHandler', async (request) => {
      const sessionUser = request.headers['x-test-session-user'];
      if (typeof sessionUser === 'string') {
        request.sessionUserId = sessionUser;
      }
      if (request.headers['x-track-file-drain'] === '1') {
        const readFile = request.file.bind(request);
        request.file = async (...args) => {
          trackedFileReads += 1;
          const file = await readFile(...args);
          if (!file) return file;
          const drainBuffer = file.toBuffer.bind(file);
          file.toBuffer = async (...bufferArgs) => {
            trackedBufferDrains += 1;
            return drainBuffer(...bufferArgs);
          };
          return file;
        };
      }
    });
    await app.register(refAudioUploadRoutes);
    await app.ready();
  });

  after(async () => {
    await app.close();
    if (prevUploadDir === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = prevUploadDir;
    await rm(uploadDir, { recursive: true, force: true });
  });

  it('rejects trusted Origin fallback without a real session', async () => {
    const { payload, contentType } = buildMultipartPayload({
      buffer: makeWavBuffer(),
      filename: 'voice.wav',
      mimetype: 'audio/wav',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads/ref-audio',
      headers: {
        'Content-Type': contentType,
        Origin: 'http://localhost:3003',
      },
      payload,
    });

    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).code, 'AUTH_REQUIRED');
  });

  it('drains unauthorized multipart uploads before returning auth error', async () => {
    trackedFileReads = 0;
    trackedBufferDrains = 0;
    const filesBefore = await readdir(uploadDir);
    const { payload, contentType } = buildMultipartPayload({
      buffer: makeWavBuffer(),
      filename: 'voice.wav',
      mimetype: 'audio/wav',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads/ref-audio',
      headers: {
        'Content-Type': contentType,
        'x-track-file-drain': '1',
      },
      payload,
    });

    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).code, 'AUTH_REQUIRED');
    assert.equal(trackedFileReads, 1);
    assert.equal(trackedBufferDrains, 1);
    assert.deepEqual(await readdir(uploadDir), filesBefore);
  });

  it('accepts a sniffed WAV reference audio file and persists it under UPLOAD_DIR', async () => {
    const { payload, contentType } = buildMultipartPayload({
      buffer: makeWavBuffer(),
      filename: '../voice.wav',
      mimetype: 'application/octet-stream',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads/ref-audio',
      headers: {
        'Content-Type': contentType,
        'x-test-session-user': 'test-user',
      },
      payload,
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.match(body.url, /^\/uploads\/ref-audio-\d+-[a-f0-9]{8}\.wav$/);
    assert.doesNotMatch(body.url, /\.\.|voice\.wav/);
    const saved = await stat(join(uploadDir, body.url.slice('/uploads/'.length)));
    assert.equal(saved.isFile(), true);
    assert.equal(saved.size, 32);
  });

  it('accepts sniffed MP3, OGG, and WebM reference audio files', async () => {
    const cases = [
      { ext: 'mp3', buffer: makeMp3Buffer(), filename: 'voice.mp3' },
      { ext: 'ogg', buffer: makeOggBuffer(), filename: 'voice.ogg' },
      { ext: 'webm', buffer: makeWebmBuffer(), filename: 'voice.webm' },
    ];

    for (const entry of cases) {
      const { payload, contentType } = buildMultipartPayload({
        buffer: entry.buffer,
        filename: entry.filename,
        mimetype: 'application/octet-stream',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/uploads/ref-audio',
        headers: {
          'Content-Type': contentType,
          'x-test-session-user': 'test-user',
        },
        payload,
      });

      assert.equal(res.statusCode, 200, `${entry.ext} upload should succeed`);
      const body = JSON.parse(res.body);
      assert.match(body.url, new RegExp(`^/uploads/ref-audio-\\d+-[a-f0-9]{8}\\.${entry.ext}$`));
      const saved = await stat(join(uploadDir, body.url.slice('/uploads/'.length)));
      assert.equal(saved.isFile(), true);
      assert.equal(saved.size, entry.buffer.length);
    }
  });

  it('rejects multipart requests without a file part', async () => {
    const filesBefore = await readdir(uploadDir);
    const { payload, contentType } = buildNoFileMultipartPayload();

    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads/ref-audio',
      headers: {
        'Content-Type': contentType,
        'x-test-session-user': 'test-user',
      },
      payload,
    });

    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).code, 'NO_FILE');
    assert.deepEqual(await readdir(uploadDir), filesBefore);
  });

  it('rejects non-audio bytes even when declared as audio', async () => {
    const filesBefore = await readdir(uploadDir);
    const { payload, contentType } = buildMultipartPayload({
      buffer: Buffer.from('not really audio'),
      filename: 'voice.wav',
      mimetype: 'audio/wav',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads/ref-audio',
      headers: {
        'Content-Type': contentType,
        'x-test-session-user': 'test-user',
      },
      payload,
    });

    assert.equal(res.statusCode, 415);
    assert.equal(JSON.parse(res.body).code, 'AUDIO_FORMAT_UNRECOGNIZED');
    assert.deepEqual(await readdir(uploadDir), filesBefore);
  });

  it('rejects files above the refAudio size limit', async () => {
    const filesBefore = await readdir(uploadDir);
    const tooLarge = 10 * 1024 * 1024 + 1;
    const { payload, contentType } = buildMultipartPayload({
      buffer: makeMp3Buffer(tooLarge),
      filename: 'huge.mp3',
      mimetype: 'audio/mpeg',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads/ref-audio',
      headers: {
        'Content-Type': contentType,
        'x-test-session-user': 'test-user',
      },
      payload,
    });

    assert.equal(res.statusCode, 413);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(body.maxBytes, 10 * 1024 * 1024);
    assert.deepEqual(await readdir(uploadDir), filesBefore);
  });
});
