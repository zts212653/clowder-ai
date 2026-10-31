import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import sharp from 'sharp';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { WorkspaceContentReviewService } from '../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { registerPublishedContentRoutes } from '../src/routes/published-content-routes.js';
import { registerWorkspaceContentReviewRoutes } from '../src/routes/workspace-content-review-routes.js';
import { createReviewFixture } from './helpers/artifact-review-fixture.js';

test('publication routes admit exact visible messages with no Task and serve authorized pinned bytes and one ledger', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-published-routes-'));
  const uploads = join(root, 'uploads');
  await mkdir(uploads);
  const bytes = await sharp({ create: { width: 160, height: 100, channels: 3, background: '#abc123' } })
    .png()
    .toBuffer();
  await writeFile(join(uploads, 'cover.png'), bytes);
  const f = createReviewFixture(root, uploads);
  f.task.current = null;
  const store = new ArtifactReviewStore(join(root, 'reviews.sqlite'));
  const app = Fastify();
  t.after(async () => {
    await app.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const ledgers = new WorkspaceContentReviewService({
    store: store.ledgers,
    publications: f.media,
    source: new WorkspaceContentSourceService({
      ownerUserId: 'operator',
      resolveWorktreeRoot: async () => {
        throw new Error('must not invent a file');
      },
    }),
  });
  registerPublishedContentRoutes(app, { media: f.media });
  registerWorkspaceContentReviewRoutes(app, { reviews: ledgers, namespace: 'publication' });
  const headers = { 'x-cat-cafe-user': 'operator' };
  const payload = {
    source: {
      kind: 'message',
      threadId: 'thread-cover',
      messageId: f.publication.id,
      messageRevision: String(f.publication.timestamp),
      expectedUrl: '/uploads/cover.png',
      item: { kind: 'media-gallery', blockId: 'image', itemIndex: 0 },
    },
    operationId: 'open-chat',
  };
  for (const deniedHeaders of [
    {},
    { ...headers, 'x-invocation-id': 'cat-invocation' },
    { ...headers, origin: 'http://localhost:3101' },
  ]) {
    assert.equal(
      (await app.inject({ method: 'POST', url: '/api/content-publications/prepare', headers: deniedHeaders, payload }))
        .statusCode,
      401,
    );
  }
  const opened = await app.inject({ method: 'POST', url: '/api/content-publications/prepare', headers, payload });
  assert.equal(opened.statusCode, 200, opened.body);
  const asset = opened.json();
  assert.equal(f.task.current, null);
  const descriptionUrl = `/api/content-publications/${asset.contentRef}?ownerRevision=1`;
  const description = await app.inject({ url: descriptionUrl, headers });
  assert.equal(description.statusCode, 200, description.body);
  assert.deepEqual(description.json().asset, asset);
  assert.equal(description.json().origin.publisherCatId, f.publication.catId);
  assert.equal(description.json().currentOwnerRevision, 1);
  assert.equal((await app.inject({ url: descriptionUrl })).statusCode, 401);
  assert.equal((await app.inject({ url: descriptionUrl, headers: { 'x-cat-cafe-user': 'other' } })).statusCode, 403);
  const body = {
    publication: { contentRef: asset.contentRef, ownerRevision: asset.ownerRevision },
    operationId: 'open-ledger',
  };
  const prepared = await app.inject({ method: 'POST', url: '/api/content-reviews/prepare', headers, payload: body });
  assert.equal(prepared.statusCode, 200, prepared.body);
  const view = prepared.json();
  assert.equal(view.review.source.kind, 'publication');
  const annotated = await app.inject({
    method: 'POST',
    url: `/api/content-reviews/${view.review.reviewId}/annotations`,
    headers,
    payload: {
      expectedRevision: 1,
      operationId: 'comment',
      body: '保留暖光',
      target: { kind: 'media_anchor', anchor: { kind: 'image-point', x: 10, y: 20 } },
    },
  });
  assert.equal(annotated.statusCode, 200, annotated.body);
  const reopen = await app.inject({
    method: 'POST',
    url: '/api/content-reviews/prepare',
    headers,
    payload: { ...body, operationId: 'open-artifacts' },
  });
  assert.equal(reopen.json().review.annotations[0].body, '保留暖光');
  const url = `/api/content-publications/${asset.contentRef}/media/1`;
  const range = await app.inject({ url, headers: { ...headers, range: 'bytes=0-15' } });
  assert.equal(range.statusCode, 206, range.body);
  assert.deepEqual(range.rawPayload, bytes.subarray(0, 16));
  assert.equal(range.headers['cache-control'], 'private, no-store');
  assert.equal((await app.inject({ url, headers: { ...headers, range: 'bytes=999999-' } })).statusCode, 416);
  assert.equal((await app.inject({ url, headers: { 'x-cat-cafe-user': 'other' } })).statusCode, 403);
  f.publication.recall = { recalledBy: 'operator', recalledAt: 2000 };
  assert.equal((await app.inject({ url: descriptionUrl, headers })).statusCode, 403);
  assert.equal((await app.inject({ url, headers })).statusCode, 403);
  assert.equal((await app.inject({ url: `/api/content-reviews/${view.review.reviewId}`, headers })).statusCode, 403);
});
