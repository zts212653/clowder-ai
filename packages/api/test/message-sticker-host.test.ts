import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MESSAGE_STICKER_CATALOG } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { saveUploadedImages } from '../src/routes/image-upload.js';
import { registerMessageStickerRoutes } from '../src/routes/message-stickers.js';

const directories = {
  memory: fileURLToPath(new URL('../../web/public/f321/stickers/', import.meta.url)),
  collaboration: fileURLToPath(
    new URL('../../../docs/videos/shared-assets/cat-stickers/2026-10-11-collaboration/', import.meta.url),
  ),
};

test('both original artwork sources are available through an authenticated Home picker without publishing new copies', async () => {
  const app = Fastify();
  app.addHook('onRequest', async (request) => {
    // Explicit local session fixture, never a production identity fallback.
    if (request.headers['x-test-session'] === 'present') Object.assign(request, { sessionUserId: 'human_local' });
  });
  registerMessageStickerRoutes(app, directories);
  try {
    assert.equal((await app.inject('/api/message-stickers/momo-cheer')).statusCode, 401);
    for (const entry of MESSAGE_STICKER_CATALOG) {
      const response = await app.inject({
        url: `/api/message-stickers/${entry.id}`,
        headers: { 'x-test-session': 'present' },
      });
      assert.equal(response.statusCode, 200, entry.id);
      assert.equal(response.rawPayload.length, entry.byteLength);
      assert.equal(`sha256:${createHash('sha256').update(response.rawPayload).digest('hex')}`, entry.blobDigest);
    }
    assert.equal(
      (await app.inject({ url: '/api/message-stickers/not-in-catalogue', headers: { 'x-test-session': 'present' } }))
        .statusCode,
      404,
    );
  } finally {
    await app.close();
  }
});

test('Home uploads retain catalogue identity only when the original PNG bytes match', async () => {
  const uploadDir = await mkdtemp(join(tmpdir(), 'f290-home-sticker-'));
  try {
    const entry = MESSAGE_STICKER_CATALOG.find((entry) => entry.id === 'momo-cheer')!;
    const bytes = await readFile(join(directories[entry.source], entry.assetFile));
    const [saved] = await saveUploadedImages(
      [{ filename: 'any-name.png', mimetype: 'image/png', toBuffer: async () => bytes }],
      uploadDir,
    );
    assert.equal(saved.content.sticker?.stickerId, entry.id);
    const other = await import('sharp').then(({ default: sharp }) =>
      sharp({ create: { width: 2, height: 2, channels: 3, background: '#f00' } })
        .png()
        .toBuffer(),
    );
    const [ordinary] = await saveUploadedImages(
      [{ filename: entry.assetFile, mimetype: 'image/png', toBuffer: async () => other }],
      uploadDir,
    );
    assert.equal(ordinary.content.sticker, undefined, 'A catalogue-like file name does not attest image identity');
  } finally {
    await rm(uploadDir, { recursive: true, force: true });
  }
});
