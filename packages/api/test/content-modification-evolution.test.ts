import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ContentModificationRequest, EvolutionMediaLocator } from '@cat-cafe/shared';
import Fastify from 'fastify';
import sharp from 'sharp';
import { InvocationRegistry } from '../src/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { createContentModificationIntegration } from '../src/domains/collaborative-content/modification/composition.js';
import { WorkspaceContentReviewError } from '../src/domains/collaborative-content/workspace-review/errors.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { registerCallbackArtifactReviewRoutes } from '../src/routes/callback-artifact-review-routes.js';
import { registerContentModificationRoutes } from '../src/routes/content-modification-routes.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

test('an original F311 image gets a separate requested publication, real Task/outbox return and no original-file write capability', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-evolution-request-'));
  const original = await sharp({ create: { width: 160, height: 100, channels: 3, background: 'blue' } })
    .jpeg()
    .toBuffer();
  const unchanged = Buffer.from(original),
    digest = createHash('sha256').update(original).digest('hex');
  const ref = (name: string, version = 'v1') => ({
    ownerFeatureId: 'microduck-owner',
    ownerStateRef: 'evidence:' + name,
    version,
  });
  const locator: EvolutionMediaLocator = {
    programId: 'evolution-program:' + 'a'.repeat(32),
    experimentRef: ref('left'),
    recordRef: ref('case'),
    mediaRef: ref('frame', digest),
  };
  let allowed = true;
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => {
      throw new Error('F311 must not acquire file write authority');
    },
  });
  const f = await createLiveReviewFixture(root, 'image/png', undefined, source, {
    read: async (target, principal) => {
      assert.equal(principal.userId, 'operator');
      assert.deepEqual(target, locator);
      if (!allowed) throw new WorkspaceContentReviewError('access_denied');
      return {
        bytes: original,
        mime: 'image/jpeg',
        media: { kind: 'image', width: 160, height: 100 },
        label: '左侧实验截图',
      };
    },
  });
  assert.ok(f.ledgers);
  const savedSources: { ownerUserId: string; threadId: string; messageId: string }[] = [];
  const integration = createContentModificationIntegration({
    dataDir: root,
    source,
    files: f.ledgers,
    artifacts: f,
    tasks: f.tasks,
    messages: f.messages,
    changed: () => {},
    sourceChanged: (ownerUserId, threadId, messageId) => {
      const persisted = f.messages.getById(messageId);
      assert.equal(persisted?.catId, null);
      assert.equal(persisted?.source, undefined);
      assert.ok(persisted?.extra?.contentModificationRequestV1);
      assert.equal(f.tasks.listByThread(f.thread.id).length, tasksBefore, 'source visibility precedes Task admission');
      savedSources.push({ ownerUserId, threadId, messageId });
    },
    onError: () => {},
  });
  t.after(async () => {
    integration.writer.close();
    await f.dispatch.close();
    f.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const tasksBefore = f.tasks.listByThread(f.thread.id).length;
  const view = await f.ledgers.prepare({ principal: f.human, evolution: locator, operationId: 'open-original' });
  await f.ledgers.annotate({
    principal: f.human,
    reviewId: view.review.reviewId,
    expectedRevision: 1,
    operationId: 'original-comment',
    body: '实验讨论应留在原件',
    target: { kind: 'media_anchor', anchor: { kind: 'image-point', x: 10, y: 20 } },
  });
  assert.equal(f.tasks.listByThread(f.thread.id).length, tasksBefore);
  const payload: ContentModificationRequest = {
    operationId: randomUUID(),
    source: {
      kind: 'evolution',
      locator,
      reviewId: view.review.reviewId,
      expectedReviewRevision: 2,
      expectedSourceRevision: 'sha256:' + digest,
    },
    targetCatId: 'codex-astra',
    threadId: f.thread.id,
    intent: { body: '作为新作品把背景改为绿色', selection: { kind: 'image-point', x: 10, y: 20 } },
  };
  const pending = await integration.requests.submit(payload, f.human);
  assert.equal(pending.stage, 'queued', JSON.stringify(pending.record.issue));
  const record = pending.record;
  const app = Fastify();
  registerContentModificationRoutes(app, integration);
  const registry = new InvocationRegistry();
  const actor = await registry.create('operator', 'codex-astra', f.thread.id);
  await registerCallbackArtifactReviewRoutes(app, {
    ...f,
    threads: f.threads,
    registry,
    changed: async () => {},
    sourceDiscussions: integration.sourceDiscussions,
  });
  t.after(() => app.close());
  const detail = await app.inject({
    url: `/api/content-modifications/${record.requestId}`,
    headers: { 'x-cat-cafe-user': 'operator' },
  });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(
    detail.json().sourceDiscussions?.[0]?.review.annotations[0]?.body,
    '实验讨论应留在原件',
    'the derived work must expose its retained original discussion without copying it into the new ledger',
  );
  assert.equal(
    (await integration.sourceDiscussions.forRequest(record.requestId, f.cat))[0]?.review.annotations[0]?.body,
    '实验讨论应留在原件',
  );
  const overview = await app.inject({
    method: 'POST',
    url: '/api/callbacks/artifact-review/read',
    headers: { 'x-invocation-id': actor.invocationId, 'x-callback-token': actor.callbackToken },
    payload: { reviewId: record.progress.review?.reviewId },
  });
  assert.equal(overview.statusCode, 200, overview.body);
  assert.ok(
    overview
      .json()
      .records.some(
        (item: { path: string; value: unknown }) =>
          item.path === '/sourceDiscussions/0/review/annotations/0/body' && item.value === '实验讨论应留在原件',
      ),
    'the actual cat callback must include retained original comments',
  );
  await assert.rejects(
    integration.sourceDiscussions.forRequest(record.requestId, { ...f.cat, actor: { kind: 'cat', actorId: 'opus5' } }),
    /access_denied/,
  );
  await assert.rejects(
    f.ledgers.retainedRevision({ principal: f.cat, reviewId: view.review.reviewId, revision: 2 }),
    /access_denied/,
    'a cat has no general human-only file review read capability',
  );
  assert.deepEqual(savedSources, [
    { ownerUserId: 'operator', threadId: f.thread.id, messageId: record.progress.sourceMessageId },
  ]);
  assert.ok(record.progress.review && record.progress.task && record.progress.prepared?.kind === 'media');
  const contentRef = record.progress.prepared.contentRef;
  assert.notEqual(
    record.progress.prepared.ledgerRef,
    view.review.reviewId,
    'explicit snapshot creates a different discussion object',
  );
  const originalLedger = await f.ledgers.read({ principal: f.human, reviewId: view.review.reviewId });
  assert.equal(originalLedger.review.annotations.length, 1);
  const origin = await f.media.origin(contentRef, f.human);
  assert.ok('kind' in origin.scope && origin.scope.kind === 'evolution-snapshot');
  assert.deepEqual(origin.scope.source.locator, locator);
  assert.equal(f.tasks.listByThread(f.thread.id).length, tasksBefore + 1);
  const replay = await integration.requests.submit(payload, f.human);
  assert.equal(replay.record.requestId, record.requestId);
  assert.equal(savedSources.length, 1);
  assert.equal(f.tasks.listByThread(f.thread.id).length, tasksBefore + 1);
  await assert.rejects(
    f.media.read(contentRef, 1, f.cat),
    /access_denied/,
    'being in the execution thread alone does not grant the original',
  );
  await f.media.read(contentRef, 1, { ...f.cat, contentTaskId: record.progress.task.taskId });
  const review = await f.reviews.readCurrent(record.progress.review.reviewId, f.human),
    round = review.review.rounds.at(-1)!;
  assert.equal(round.annotations.length, 1, 'old original discussion must not become a copied writable ledger');
  await writeFile(
    join(root, 'new-work.png'),
    await sharp({ create: { width: 160, height: 100, channels: 3, background: 'green' } })
      .png()
      .toBuffer(),
  );
  const published = f.publish('new-work.png');
  const response = await f.reviews.respond(
    {
      requestId: record.requestId,
      reviewId: review.review.reviewId,
      expectedRevision: review.review.revision,
      expectedLedgerRevision: round.ledgerRevision,
      expectedTaskRevision: record.progress.task.revision,
      expectedOwnerRevision: 1,
      operationId: randomUUID(),
      artifactRef: '/uploads/new-work.png',
      expectedArtifactRevision: String(published.timestamp),
      responses: round.annotations.map((item) => ({
        annotationId: item.id,
        disposition: 'addressed',
        explanation: '派生作品背景已更换',
      })),
    },
    f.cat,
  );
  assert.equal(response.view.review.rounds.at(-1)?.asset.ownerRevision, 2);
  assert.equal(await integration.results.writeback(record, f.human), undefined);
  assert.equal((await integration.results.candidates(record, f.human)).length, 1);
  assert.deepEqual(original, unchanged);
  const fresh = await f.ledgers.read({ principal: f.human, reviewId: view.review.reviewId });
  assert.equal(fresh.review.revision, 2);
  allowed = false;
  await assert.rejects(integration.sourceDiscussions.forRequest(record.requestId, f.cat), /access_denied/);
  await assert.rejects(f.media.read(contentRef, 2, f.human), /access_denied/);
  await assert.rejects(
    f.media.read(contentRef, 2, { ...f.cat, contentTaskId: record.progress.task.taskId }),
    /access_denied/,
  );
});
