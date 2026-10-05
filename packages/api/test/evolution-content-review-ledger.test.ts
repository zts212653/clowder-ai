import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { EvolutionMediaLocator } from '@cat-cafe/shared';
import Fastify from 'fastify';
import sharp from 'sharp';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { WorkspaceContentReviewError } from '../src/domains/collaborative-content/workspace-review/errors.js';
import {
  type EvolutionMediaReadPort,
  evolutionContentRef,
} from '../src/domains/collaborative-content/workspace-review/evolution-review-source.js';
import { WorkspaceContentReviewService } from '../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { registerWorkspaceContentReviewRoutes } from '../src/routes/workspace-content-review-routes.js';

const ref = (id: string, version = 'r1') => ({ ownerFeatureId: 'F311', ownerStateRef: 'exploration:' + id, version });
test('F311 original discussion is shared by exact original refs, not equal bytes or the currently selected experiment', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-evolution-ledger-'));
  const store = new ArtifactReviewStore(join(root, 'reviews.sqlite'));
  const other = new ArtifactReviewStore(join(root, 'reviews.sqlite'));
  t.after(async () => {
    store.close();
    other.close();
    await rm(root, { recursive: true, force: true });
  });
  const bytes = await sharp({ create: { width: 160, height: 100, channels: 3, background: '#ffaacb' } })
    .png()
    .toBuffer();
  const digest = createHash('sha256').update(bytes).digest('hex');
  const locator: EvolutionMediaLocator = {
    programId: 'evolution-program:' + 'a'.repeat(32),
    experimentRef: ref('left-experiment'),
    recordRef: ref('left-case'),
    mediaRef: ref('left-image', digest),
  };
  let authorized = true;
  const calls: EvolutionMediaLocator[] = [];
  const evolution: EvolutionMediaReadPort = {
    read: async (target, principal) => {
      assert.equal(principal.userId, 'operator');
      if (!authorized) throw new WorkspaceContentReviewError('access_denied');
      calls.push(structuredClone(target));
      return { bytes, mime: 'image/png', label: '左侧原图', media: { kind: 'image', width: 160, height: 100 } };
    },
  };
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => {
      throw new Error('must not invent a file');
    },
  });
  const reviews = new WorkspaceContentReviewService({ store: store.ledgers, source, evolution });
  const independent = new WorkspaceContentReviewService({ store: other.ledgers, source, evolution });
  const principal = { userId: 'operator', actor: { kind: 'human' as const, actorId: 'operator' } };
  const opened = await reviews.prepare({ principal, evolution: locator, operationId: 'open-comparison-left' });
  assert.equal(opened.review.source.kind, 'evolution');
  assert.equal(opened.review.contentRef, evolutionContentRef(locator));
  await reviews.annotate({
    principal,
    reviewId: opened.review.reviewId,
    expectedRevision: 1,
    operationId: 'original-point',
    body: '作为新作品时移除这里',
    target: { kind: 'media_anchor', anchor: { kind: 'image-point', x: 10, y: 20 } },
  });
  const reopened = await independent.prepare({ principal, evolution: locator, operationId: 'open-from-program' });
  assert.equal(reopened.review.reviewId, opened.review.reviewId);
  assert.equal(reopened.review.annotations[0]?.body, '作为新作品时移除这里');
  const right = {
    ...locator,
    experimentRef: ref('right-experiment'),
    recordRef: ref('right-case'),
    mediaRef: ref('right-image', digest),
  };
  const different = await reviews.prepare({ principal, evolution: right, operationId: 'open-comparison-right' });
  assert.notEqual(different.review.reviewId, opened.review.reviewId);
  assert.equal(different.review.annotations.length, 0, 'equal byte hashes cannot merge distinct experiments or media');
  assert.deepEqual(calls[0], locator);
  const app = Fastify();
  registerWorkspaceContentReviewRoutes(app, { reviews, namespace: 'publication' });
  t.after(() => app.close());
  const headers = { 'x-cat-cafe-user': 'operator' };
  const route = await app.inject({
    method: 'POST',
    url: '/api/content-reviews/prepare',
    headers,
    payload: { evolution: locator, operationId: 'open-common-landing' },
  });
  assert.equal(route.statusCode, 200);
  assert.equal(route.json().review.reviewId, opened.review.reviewId);
  const mediaUrl = `/api/content-reviews/${opened.review.reviewId}/media?expectedSourceRevision=${encodeURIComponent(opened.review.source.revision)}`;
  const image = await app.inject({ method: 'GET', url: mediaUrl, headers });
  assert.equal(image.statusCode, 200);
  assert.deepEqual(image.rawPayload, bytes);
  assert.equal(image.headers['content-type'], 'image/png');
  assert.equal(image.headers['cache-control'], 'private, no-store');
  const unauthenticated = await app.inject({
    method: 'GET',
    url: mediaUrl,
    headers: { ...headers, origin: 'http://untrusted.example' },
  });
  assert.equal(unauthenticated.statusCode, 401, 'a browser cannot impersonate a human using a request header');
  const callback = await app.inject({
    method: 'GET',
    url: mediaUrl,
    headers: { ...headers, 'x-callback-token': 'not-human' },
  });
  assert.equal(callback.statusCode, 401);
  await assert.rejects(
    reviews.refresh({
      principal,
      reviewId: opened.review.reviewId,
      expectedRevision: 2,
      operationId: 'no-original-replacement',
    }),
    /invalid_action/,
  );
  await reviews.retainRevision({ principal, reviewId: opened.review.reviewId, expectedRevision: 2 });
  authorized = false;
  await assert.rejects(independent.read({ principal, reviewId: opened.review.reviewId }), /access_denied/);
  await assert.rejects(
    independent.retainedRevision({ principal, reviewId: opened.review.reviewId, revision: 2 }),
    /access_denied/,
  );
  assert.equal((await app.inject({ method: 'GET', url: mediaUrl, headers })).statusCode, 403);
});
