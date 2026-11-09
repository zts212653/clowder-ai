import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { isContentFileBasename } from '@cat-cafe/shared';
import sharp from 'sharp';
import { createApiServer } from '../src/infrastructure/api-server.js';
import { uploadsRoutes } from '../src/routes/uploads.js';
import { disposalGif } from './helpers/disposal-gif.js';

const human = { host: 'localhost', 'x-cat-cafe-user': 'operator' };
const generatedName =
  'codex-00000000-0000-4000-8000-000000000001-exec-00000000-0000-4000-8000-000000000002.png-a1b2c3d4.png';

test('generated uploads remain readable beside the parameterized GIF poster route', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-upload-routing-'));
  const app = createApiServer();
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const png = await sharp({ create: { width: 2, height: 1, channels: 4, background: 'red' } })
    .png()
    .toBuffer();
  const gifName = generatedName.replace(/\.png$/, '.gif');
  const gif = disposalGif(3);
  assert.equal(generatedName.length, 101);
  await writeFile(join(root, generatedName), png);
  await writeFile(join(root, gifName), gif);
  await app.register(uploadsRoutes, { uploadDir: root });

  for (const [name, bytes, type] of [
    [generatedName, png, 'image/png'],
    [gifName, gif, 'image/gif'],
  ] as const) {
    const original = await app.inject({ url: `/uploads/${name}` });
    assert.equal(original.statusCode, 200, original.body);
    assert.equal(original.headers['content-type'], type);
    assert.deepEqual(original.rawPayload, bytes);
    assert.equal((await app.inject({ method: 'HEAD', url: `/uploads/${name}` })).statusCode, 200);
  }
  const posterUrl = `/uploads/${gifName}/gif-poster`;
  assert.equal((await app.inject({ url: posterUrl })).statusCode, 401);
  const poster = await app.inject({ url: posterUrl, headers: human });
  assert.equal(poster.statusCode, 200, poster.body);
  assert.equal(poster.headers['content-type'], 'image/png');
  assert.deepEqual(
    [...(await sharp(poster.rawPayload).ensureAlpha().raw().toBuffer())],
    [255, 0, 0, 255, 255, 0, 0, 255],
  );
  const info = await app.inject({ url: `/api/uploads/${generatedName}/file-info`, headers: human });
  assert.equal(info.statusCode, 200, info.body);
  assert.equal(info.json().filename, generatedName);
  assert.equal(info.json().byteLength, png.length);
  assert.equal((await app.inject({ method: 'POST', url: `/api/uploads/${generatedName}/open` })).statusCode, 401);
});

test('upload route bounds match decoded legal basenames, including encoded Unicode, without admitting path segments', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-upload-bounds-'));
  const app = createApiServer();
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });
  const names = [`${'a'.repeat(251)}.gif`, `${'图'.repeat(40)}${'a'.repeat(120)}.gif`];
  assert.equal(names[0].length, 255);
  assert.ok(encodeURIComponent(names[1]).length > 255);
  const bytes = disposalGif(3);
  for (const name of names) {
    assert.equal(isContentFileBasename(name), true);
    await writeFile(join(root, name), bytes);
  }
  await app.register(uploadsRoutes, { uploadDir: root });
  for (const name of names) {
    const encoded = encodeURIComponent(name);
    const original = await app.inject({ url: `/uploads/${encoded}` });
    assert.equal(original.statusCode, 200, original.body);
    assert.deepEqual(original.rawPayload, bytes);
    const poster = await app.inject({ url: `/uploads/${encoded}/gif-poster`, headers: human });
    assert.equal(poster.statusCode, 200, poster.body);
    const info = await app.inject({ url: `/api/uploads/${encoded}/file-info`, headers: human });
    assert.equal(info.statusCode, 200, info.body);
    assert.equal(info.json().filename, name);
  }
  const tooLong = `${'a'.repeat(252)}.gif`;
  assert.equal(isContentFileBasename(tooLong), false);
  assert.equal((await app.inject({ url: `/uploads/${tooLong}/gif-poster`, headers: human })).statusCode, 404);
  for (const url of ['/uploads/a%2Fb.gif/gif-poster', '/api/uploads/a%2Fb.gif/file-info']) {
    const rejected = await app.inject({ url, headers: human });
    assert.equal(rejected.statusCode, 400, rejected.body);
  }
});

test('an explicit API router parameter budget is retained', async (t) => {
  const app = createApiServer({ maxParamLength: 64 });
  t.after(() => app.close());
  app.get('/probe/:value', () => ({ ok: true }));
  assert.equal((await app.inject({ url: `/probe/${'a'.repeat(64)}` })).statusCode, 200);
  assert.equal((await app.inject({ url: `/probe/${'a'.repeat(65)}` })).statusCode, 404);
});
