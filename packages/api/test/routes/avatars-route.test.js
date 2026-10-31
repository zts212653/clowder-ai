// @ts-check
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AVATAR_RAW_FILE_LIMIT_BYTES } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { avatarsRoutes } from '../../dist/routes/avatars.js';

/**
 * Build a minimal multipart/form-data payload with one file part.
 */
function buildMultipartPayload({ buffer, filename, mimetype, fieldName = 'file' }) {
  const boundary = `----TestBoundary${Math.random().toString(16).slice(2)}`;
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

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/** Build a PNG-magic-prefixed buffer of exactly `size` bytes. */
function makePngBuffer(size) {
  const padding = Buffer.alloc(size - PNG_MAGIC.length);
  return Buffer.concat([PNG_MAGIC, padding]);
}

describe('POST /api/uploads/avatar', () => {
  /** @type {import('fastify').FastifyInstance} */
  let app;
  /** @type {string} */
  let uploadDir;
  /** @type {string | undefined} */
  let prevUploadDir;

  before(async () => {
    uploadDir = await mkdtemp(join(tmpdir(), 'avatars-route-'));
    prevUploadDir = process.env.UPLOAD_DIR;
    process.env.UPLOAD_DIR = uploadDir;
    app = Fastify();
    await app.register(avatarsRoutes);
    await app.ready();
  });

  after(async () => {
    await app.close();
    if (prevUploadDir === undefined) delete process.env.UPLOAD_DIR;
    else process.env.UPLOAD_DIR = prevUploadDir;
    await rm(uploadDir, { recursive: true, force: true });
  });

  it('accepts a 7 MiB PNG and persists it to UPLOAD_DIR', async () => {
    const rawBytes = 7 * 1024 * 1024;
    const buffer = makePngBuffer(rawBytes);
    const { payload, contentType } = buildMultipartPayload({
      buffer,
      filename: 'big.png',
      mimetype: 'image/png',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads/avatar',
      headers: { 'Content-Type': contentType },
      payload,
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.url, 'should return upload URL');
    assert.ok(body.url.startsWith('/uploads/'), 'URL should start with /uploads/');
    assert.ok(body.url.endsWith('.png'), 'URL should end with .png');
    const filename = body.url.replace('/uploads/', '');
    const saved = await stat(join(uploadDir, filename));
    assert.equal(saved.isFile(), true);
    assert.equal(saved.size, rawBytes, 'saved file size should match the input buffer length');
  });

  it('rejects files larger than AVATAR_RAW_FILE_LIMIT_BYTES with structured 413', async () => {
    const buffer = makePngBuffer(AVATAR_RAW_FILE_LIMIT_BYTES + 1024);
    const { payload, contentType } = buildMultipartPayload({
      buffer,
      filename: 'too-big.png',
      mimetype: 'image/png',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads/avatar',
      headers: { 'Content-Type': contentType },
      payload,
    });
    assert.equal(res.statusCode, 413);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(body.maxBytes, AVATAR_RAW_FILE_LIMIT_BYTES);
  });

  it('rejects unsupported mime types with 415 UNSUPPORTED_MEDIA_TYPE', async () => {
    const buffer = Buffer.from('hello world');
    const { payload, contentType } = buildMultipartPayload({
      buffer,
      filename: 'doc.txt',
      mimetype: 'text/plain',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads/avatar',
      headers: { 'Content-Type': contentType },
      payload,
    });
    assert.equal(res.statusCode, 415);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'UNSUPPORTED_MEDIA_TYPE');
  });

  it('rejects file whose bytes do not match declared mime with 415 IMAGE_FORMAT_MISMATCH', async () => {
    // Declared as PNG but actual bytes are JPEG magic.
    const buffer = Buffer.concat([JPEG_MAGIC, Buffer.alloc(1024)]);
    const { payload, contentType } = buildMultipartPayload({
      buffer,
      filename: 'fake.png',
      mimetype: 'image/png',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads/avatar',
      headers: { 'Content-Type': contentType },
      payload,
    });
    assert.equal(res.statusCode, 415);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'IMAGE_FORMAT_MISMATCH');
    assert.equal(body.declared, 'image/png');
    assert.equal(body.detected, 'image/jpeg');
  });

  it('rejects file with PNG mime and gibberish bytes with 415 IMAGE_FORMAT_MISMATCH', async () => {
    // No supported magic signature in these bytes.
    const buffer = Buffer.from('this is definitely not an image, just plain text masquerading as PNG');
    const { payload, contentType } = buildMultipartPayload({
      buffer,
      filename: 'fake.png',
      mimetype: 'image/png',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads/avatar',
      headers: { 'Content-Type': contentType },
      payload,
    });
    assert.equal(res.statusCode, 415);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'IMAGE_FORMAT_MISMATCH');
    assert.equal(body.declared, 'image/png');
    assert.equal(body.detected, null);
  });

  it('drains the multipart stream on rejection so subsequent requests succeed', async () => {
    // Reject path: unsupported mime. Then immediately send a valid PNG and
    // verify the connection / parser is not stuck.
    const rejectBuffer = Buffer.from('hello world');
    const reject = buildMultipartPayload({
      buffer: rejectBuffer,
      filename: 'doc.txt',
      mimetype: 'text/plain',
    });
    const r1 = await app.inject({
      method: 'POST',
      url: '/api/uploads/avatar',
      headers: { 'Content-Type': reject.contentType },
      payload: reject.payload,
    });
    assert.equal(r1.statusCode, 415);

    const okBuffer = makePngBuffer(1024);
    const ok = buildMultipartPayload({
      buffer: okBuffer,
      filename: 'tiny.png',
      mimetype: 'image/png',
    });
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/uploads/avatar',
      headers: { 'Content-Type': ok.contentType },
      payload: ok.payload,
    });
    assert.equal(r2.statusCode, 200);
  });

  it('rejects request with no file part with 400', async () => {
    const boundary = `----EmptyBoundary${Math.random().toString(16).slice(2)}`;
    const payload = Buffer.from(`--${boundary}--\r\n`, 'utf8');
    const res = await app.inject({
      method: 'POST',
      url: '/api/uploads/avatar',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'NO_FILE');
  });
});
