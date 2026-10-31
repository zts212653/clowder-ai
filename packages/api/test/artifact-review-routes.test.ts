import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import sharp from 'sharp';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { registerArtifactReviewRoutes } from '../src/routes/artifact-review-routes.js';
import { registerCallbackArtifactReviewRoutes } from '../src/routes/callback-artifact-review-routes.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

test('human and independent cat routes preserve named authorship, bound paging, media access, and scoped mutation policy', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-route-'));
  const png = await sharp({ create: { width: 240, height: 160, channels: 3, background: '#efdcad' } })
    .png()
    .toBuffer();
  await writeFile(join(root, 'review-input.png'), png);
  const f = await createLiveReviewFixture(root);
  const registry = new InvocationRegistry();
  const credentials = await registry.create('operator', 'codex-astra', f.thread.id);
  const other = await registry.create('operator', 'codex-astra', 'other-thread');
  const app = Fastify();
  app.decorateRequest('sessionUserId', null);
  app.addHook('onRequest', async (request) => {
    request.sessionUserId =
      typeof request.headers['x-fixture-user'] === 'string' ? request.headers['x-fixture-user'] : null;
  });
  await app.register(async (scope) => registerArtifactReviewRoutes(scope, f));
  await registerCallbackArtifactReviewRoutes(app, { ...f, threads: f.threads, registry });
  t.after(async () => {
    await app.close();
    f.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const human = { 'x-fixture-user': 'operator' };
  const cat = { 'x-invocation-id': credentials.invocationId, 'x-callback-token': credentials.callbackToken };
  const alien = { 'x-invocation-id': other.invocationId, 'x-callback-token': other.callbackToken };
  const prepare = (headers: Record<string, string>, payload: unknown = f.prepare) =>
    app.inject({ method: 'POST', url: '/api/artifact-reviews/prepare', headers, payload });
  assert.equal((await prepare({})).statusCode, 401);
  assert.equal((await prepare({ 'x-fixture-user': 'another-owner' })).statusCode, 403);
  assert.equal(
    (await prepare(human, { ...f.prepare, actor: { kind: 'cat', actorId: 'codex-astra' } })).statusCode,
    400,
  );
  const opened = await prepare(human);
  assert.equal(opened.statusCode, 200, opened.body);
  let view = opened.json();
  const reviewId = view.review.reviewId;
  const act = (body: unknown, headers = human) =>
    app.inject({ method: 'POST', url: `/api/artifact-reviews/${reviewId}/actions`, headers, payload: body });
  const annotated = await act({
    reviewId,
    expectedRevision: 1,
    expectedTaskRevision: 1,
    operationId: 'human-comment',
    round: 1,
    action: {
      kind: 'annotate',
      annotationId: 'annotation',
      anchor: { kind: 'image-region', x: 20, y: 20, width: 60, height: 40 },
      body: '审阅意见：' + '长'.repeat(7500),
    },
  });
  assert.equal(annotated.statusCode, 200, annotated.body);
  view = annotated.json().view;
  assert.deepEqual(view.review.rounds[0].annotations[0].author, f.human.actor);
  const read = (headers: Record<string, string>, payload: unknown = { reviewId, view: 'annotations' }) =>
    app.inject({ method: 'POST', url: '/api/callbacks/artifact-review/read', headers, payload });
  assert.equal((await read({})).statusCode, 401);
  assert.equal((await read({ ...cat, 'x-callback-token': 'wrong' })).statusCode, 401);
  assert.equal((await read(alien)).statusCode, 403);
  assert.equal((await read(cat, { reviewId, actor: 'operator' })).statusCode, 400);
  assert.equal((await read(cat, { reviewId, cursor: 1 })).statusCode, 409);
  const first = await read(cat);
  assert.equal(first.statusCode, 200, first.body);
  assert.ok(first.body.length <= 12000);
  const inspected = first.json();
  assert.equal(
    inspected.records.find((item: { path: string }) => item.path === '/0/author/actorId')?.value,
    'operator',
  );
  const reply = await app.inject({
    method: 'POST',
    url: '/api/callbacks/artifact-review/act',
    headers: cat,
    payload: {
      reviewId,
      expectedRevision: view.review.revision,
      expectedTaskRevision: 1,
      operationId: 'cat-comment',
      round: 1,
      action: {
        kind: 'reply',
        annotationId: 'annotation',
        replyId: 'independent-cat',
        body: '猫从独立入口读到精确批注。',
      },
    },
  });
  assert.equal(reply.statusCode, 200, reply.body);
  const named = await f.reviews.read(reviewId, f.human);
  assert.deepEqual(named.review.rounds[0]?.annotations[0]?.replies[0]?.author, f.cat.actor);
  const forgedDecision = await app.inject({
    method: 'POST',
    url: '/api/callbacks/artifact-review/act',
    headers: cat,
    payload: {
      reviewId,
      expectedRevision: named.review.revision,
      expectedTaskRevision: 1,
      operationId: 'forged-human',
      round: 1,
      action: { kind: 'decide', outcome: 'approved', explanation: 'cat cannot certify this' },
    },
  });
  assert.equal(forgedDecision.statusCode, 403);
  const load = f.owner.load.bind(f.owner);
  let fullAssetLoads = 0;
  f.owner.load = async (...args) => {
    fullAssetLoads += 1;
    return load(...args);
  };
  const media = await app.inject({
    url: `/api/artifact-reviews/${reviewId}/media/1`,
    headers: { ...human, range: 'bytes=4-12' },
  });
  assert.equal(media.statusCode, 206);
  assert.deepEqual(media.rawPayload, png.subarray(4, 13));
  assert.equal(fullAssetLoads, 0, 'a small Range request must not materialize the complete retained asset');
  const suffix = await app.inject({
    url: `/api/artifact-reviews/${reviewId}/media/1`,
    headers: { ...human, range: 'bytes=-7' },
  });
  assert.equal(suffix.statusCode, 206);
  assert.deepEqual(suffix.rawPayload, png.subarray(-7));
  assert.equal(fullAssetLoads, 0, 'subsequent seeks must keep using bounded streams');
  assert.match(String(media.headers['cache-control']), /no-store/);
  assert.equal((await app.inject({ url: `/api/artifact-reviews/${reviewId}/media/1` })).statusCode, 401);
  f.messages.softDelete(f.publication.id, 'operator');
  assert.equal((await read(cat)).statusCode, 403);
  assert.equal(
    (await app.inject({ url: `/api/artifact-reviews/${reviewId}/media/1`, headers: human })).statusCode,
    403,
  );
});
