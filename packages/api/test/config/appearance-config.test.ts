import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, it, mock } from 'node:test';
import Fastify from 'fastify';
import { configRoutes } from '../../src/routes/config.js';

let app: ReturnType<typeof Fastify>, root: string;
const headers = { 'x-cat-cafe-user': 'appearance-owner' };
const originalOwner = process.env.DEFAULT_OWNER_USER_ID;
beforeEach(async () => {
  process.env.DEFAULT_OWNER_USER_ID = headers['x-cat-cafe-user'];
  root = await mkdtemp(join(tmpdir(), 'pdl-appearance-'));
  app = Fastify();
  await app.register(configRoutes, { projectRoot: root });
  await app.ready();
});
afterEach(async () => {
  mock.restoreAll();
  syncBuiltinESMExports();
  await app.close();
  await rm(root, { recursive: true, force: true });
  if (originalOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
  else process.env.DEFAULT_OWNER_USER_ID = originalOwner;
});
const get = () => app.inject({ method: 'GET', url: '/api/config/chat-background', headers });
const put = (payload: unknown) => app.inject({ method: 'PUT', url: '/api/config/chat-background', headers, payload });
it('returns retained thread backgrounds, never writes on read, and exposes no appearance preference writer', async () => {
  await mkdir(join(root, '.cat-cafe'), { recursive: true });
  const old = {
    chatBackgrounds: { global: { kind: 'none' }, threads: { private: { kind: 'none' } } },
    catOrder: ['sol'],
    appearance: { theme: { mode: 'dark' }, background: { home: 'none', images: [] } },
  };
  const path = join(root, '.cat-cafe/user-preferences.json');
  await writeFile(path, JSON.stringify(old));
  const before = await readFile(path, 'utf8');
  assert.deepEqual((await get()).json(), old.chatBackgrounds);
  assert.equal((await put({ theme: { mode: 'light' } })).statusCode, 400);
  assert.equal(await readFile(path, 'utf8'), before);
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/config/chat-background/images', headers })).json(), {
    images: [],
  });
});
it('keeps uploaded image bytes, catalogue and atomic failures without storing UI selections', async () => {
  const bytes = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/F5sAAAAASUVORK5CYII=',
    'base64',
  );
  const boundary = 'pdl-owner-image';
  const uploadRequest = {
    method: 'POST' as const,
    url: '/api/config/chat-background/images',
    headers: { ...headers, 'content-type': `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="owner.png"\r\nContent-Type: image/png\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
  const upload = await app.inject(uploadRequest);
  assert.equal(upload.statusCode, 200, upload.body);
  const image = upload.json();
  const raw = await app.inject({ method: 'GET', url: image.source, headers });
  assert.deepEqual(raw.rawPayload, bytes);
  assert.equal(raw.headers['content-type'], 'image/png');
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/config/chat-background/images', headers })).json(), {
    images: [image],
  });
  const stored = JSON.parse(await readFile(join(root, '.cat-cafe/user-preferences.json'), 'utf8'));
  assert.deepEqual(stored.appearance, { background: { images: [image] } });
  mock.method(fs, 'renameSync', () => {
    throw new Error('Preference rename failed');
  });
  syncBuiltinESMExports();
  assert.equal((await app.inject({ method: 'DELETE', url: image.source, headers })).statusCode, 500);
  assert.deepEqual((await app.inject({ method: 'GET', url: image.source, headers })).rawPayload, bytes);
  assert.equal((await app.inject(uploadRequest)).statusCode, 500);
  assert.deepEqual(
    await readdir(join(root, '.cat-cafe/appearance-images')),
    [image.id],
    'failed upload leaves no orphan image',
  );
  mock.restoreAll();
  syncBuiltinESMExports();
  const deleted = await app.inject({ method: 'DELETE', url: image.source, headers });
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.deepEqual(deleted.json(), { images: [] });
  assert.deepEqual(await readdir(join(root, '.cat-cafe/appearance-images')), []);
  assert.equal((await app.inject({ method: 'GET', url: image.source, headers })).statusCode, 404);
});
it('requires the real owner and does not overwrite malformed preference files', async () => {
  assert.equal((await app.inject({ method: 'GET', url: '/api/config/chat-background' })).statusCode, 401);
  assert.equal(
    (
      await app.inject({
        method: 'GET',
        url: '/api/config/chat-background/images',
        headers: { 'x-cat-cafe-user': 'other' },
      })
    ).statusCode,
    403,
  );
  await mkdir(join(root, '.cat-cafe'), { recursive: true });
  await writeFile(join(root, '.cat-cafe/user-preferences.json'), '{broken');
  assert.equal((await get()).statusCode, 500);
  assert.equal(await readFile(join(root, '.cat-cafe/user-preferences.json'), 'utf8'), '{broken');
});
