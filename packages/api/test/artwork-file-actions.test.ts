import assert from 'node:assert/strict';
import { mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MediaOwnerError } from '../src/domains/video-studio/content-owner/media-errors.js';
import type { PublishedMediaService } from '../src/domains/video-studio/content-owner/published-media-service.js';
import { registerPublishedContentRoutes } from '../src/routes/published-content-routes.js';

for (const mime of ['image/png', 'image/jpeg', 'video/mp4']) {
  test(`opened ${mime} exposes only its authorized local file`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'artwork-file-'));
    const path = join(root, 'work.file');
    await writeFile(path, 'authorized bytes');
    let reads = 0;
    const media = {
      async read(ref: string, revision: number, principal: { userId: string }) {
        assert.equal(ref, 'content:original');
        assert.equal(revision, 2);
        if (principal.userId !== 'operator') throw new MediaOwnerError('access_denied');
        reads++;
        return { contentRef: ref, ownerRevision: revision };
      },
      async openAsset() {
        return {
          handle: await open(path),
          path,
          mediaType: mime,
          byteLength: 16,
          committedBy: { actorId: 'maker' },
          committedAt: '2026-10-17T00:00:00Z',
          fileAuthor: 'maker',
          fileCreatedAt: '2026-10-17T00:00:00Z',
        };
      },
    } as unknown as PublishedMediaService;
    const app = Fastify();
    registerPublishedContentRoutes(app, { media });
    t.after(async () => {
      await app.close();
      await rm(root, { recursive: true, force: true });
    });
    const endpoint = '/api/content-publications/content%3Aoriginal/media/2/file-info';
    const response = await app.inject({
      method: 'GET',
      url: endpoint,
      headers: { host: 'localhost', 'x-cat-cafe-user': 'operator' },
    });
    assert.equal(response.statusCode, 200, response.body);
    const info = response.json();
    assert.equal(info.local, true);
    assert.equal(info.path, path);
    assert.equal(info.mime, mime);
    assert.equal(info.author, 'maker');
    assert.equal(info.createdAt, '2026-10-17T00:00:00Z');
    assert.equal(reads, 1, 'file resolution must consume the original owner authorization');
    const alien = await app.inject({
      method: 'GET',
      url: endpoint,
      headers: { host: 'localhost', 'x-cat-cafe-user': 'alien' },
    });
    assert.equal(alien.statusCode, 403);
    assert.ok(!alien.body.includes(path));
  });
}

test('remote/proxied viewers get no host path or host-side actions', async (t) => {
  const app = Fastify();
  registerPublishedContentRoutes(app, { media: {} as PublishedMediaService });
  t.after(() => app.close());
  const base = '/api/content-publications/content%3Aoriginal/media/2';
  const headers = { host: 'localhost', 'x-cat-cafe-user': 'operator', 'x-forwarded-for': '192.0.2.2' };
  const info = await app.inject({ method: 'GET', url: `${base}/file-info`, headers });
  assert.equal(info.statusCode, 200);
  assert.deepEqual(info.json(), { local: false });
  for (const action of ['reveal', 'open']) {
    const response = await app.inject({ method: 'POST', url: `${base}/${action}`, headers, payload: {} });
    assert.equal(response.statusCode, 403);
  }
});

test('forged filesystem payloads and agent/proxy credentials cannot launch a desktop action', async (t) => {
  const app = Fastify();
  registerPublishedContentRoutes(app, { media: {} as PublishedMediaService });
  t.after(() => app.close());
  const url = '/api/content-publications/content%3Aoriginal/media/2/open';
  const human = { host: 'localhost', 'x-cat-cafe-user': 'operator' };
  const forged = await app.inject({ method: 'POST', url, headers: human, payload: { path: '/etc/passwd' } });
  assert.equal(forged.statusCode, 400);
  for (const headers of [
    { ...human, 'x-agent-key-secret': 'agent' },
    { ...human, origin: 'https://remote.example' },
    { ...human, forwarded: 'for=127.0.0.1' },
  ]) {
    const response = await app.inject({ method: 'POST', url, headers, payload: {} });
    assert.equal(response.statusCode, 403);
  }
});
test('desktop actions reauthorize after the menu read and retain revoke boundaries', async (t) => {
  let reads = 0;
  const media = {
    async read() {
      reads++;
      throw new MediaOwnerError('access_denied');
    },
  } as unknown as PublishedMediaService;
  const app = Fastify();
  registerPublishedContentRoutes(app, { media });
  t.after(() => app.close());
  for (const action of ['reveal', 'open']) {
    const response = await app.inject({
      method: 'POST',
      url: `/api/content-publications/content%3Aoriginal/media/2/${action}`,
      headers: { host: 'localhost', 'x-cat-cafe-user': 'operator' },
      payload: {},
    });
    assert.equal(response.statusCode, 403);
  }
  assert.equal(reads, 2);
});
