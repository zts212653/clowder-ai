import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { contentModificationRequestSchema } from '@cat-cafe/shared';
import Fastify from 'fastify';
import sharp from 'sharp';
import { inspectArtifactReview } from '../src/domains/collaborative-content/artifact-review/inspection.js';
import { createContentModificationIntegration } from '../src/domains/collaborative-content/modification/composition.js';
import { inspectContentModification } from '../src/domains/collaborative-content/modification/inspection.js';
import { WorkspaceContentReviewService } from '../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentReviewStore } from '../src/domains/collaborative-content/workspace-review/store.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { registerWorkspaceContentReviewRoutes } from '../src/routes/workspace-content-review-routes.js';
import { createLiveReviewFixture } from './helpers/artifact-review-live-fixture.js';

test('legacy modification uses the existing inline round and Task through the durable request producer', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'f309-legacy-request-'));
  const image = await sharp({ create: { width: 40, height: 30, channels: 3, background: '#abcdef' } })
    .png()
    .toBuffer();
  await writeFile(join(root, 'review-input.png'), image);
  await writeFile(join(root, 'returned.png'), image);
  const source = new WorkspaceContentSourceService({
    ownerUserId: 'operator',
    resolveWorktreeRoot: async () => ({ root, canonicalWorktreeId: 'work' }),
  });
  const f = await createLiveReviewFixture(root, 'image/png', undefined, source);
  const filesStore = new WorkspaceContentReviewStore(join(root, 'files.sqlite'));
  const files = new WorkspaceContentReviewService({ store: filesStore, source });
  const integration = createContentModificationIntegration({
    dataDir: root,
    source,
    files,
    artifacts: f,
    tasks: f.tasks,
    messages: f.messages,
    changed: () => {},
    onError: (error) => {
      throw error;
    },
  });
  t.after(async () => {
    integration.writer.close();
    await f.dispatch.close();
    filesStore.close();
    f.store.close();
    await rm(root, { recursive: true, force: true });
  });
  const opened = await f.reviews.prepare(f.prepare, f.human);
  const before = await f.reviews.act(
    {
      reviewId: opened.review.reviewId,
      round: 1,
      expectedRevision: 1,
      expectedTaskRevision: 1,
      operationId: 'original-annotation',
      action: {
        kind: 'annotate',
        annotationId: 'original-mark',
        body: '原来的讨论',
        anchor: { kind: 'image-point', x: 4, y: 5 },
      },
    },
    f.human,
  );
  assert.equal(before.view.review.rounds[0]?.ledgerRef, undefined);
  assert.ok(f.ledgers);
  await assert.rejects(
    f.ledgers.prepare({
      principal: f.human,
      publication: before.view.review.rounds[0]!.asset,
      operationId: 'open-old-from-publication',
    }),
    /existing_contexts/,
    'publication admission cannot create an empty second discussion over the original inline round',
  );
  const contexts = await f.ledgers.resolvePublication(before.view.review.rounds[0]!.asset, f.human);
  assert.deepEqual(
    contexts.map((context) => [context.reviewId, context.round, context.taskId]),
    [[opened.review.reviewId, 1, f.taskId]],
  );
  assert.equal(contexts[0]?.targetName, '小星星·砚砚');
  assert.equal(
    (await f.reviews.read(contexts[0]!.reviewId, f.human)).review.rounds[0]?.annotations[0]?.body,
    '原来的讨论',
  );
  const app = Fastify();
  registerWorkspaceContentReviewRoutes(app, { reviews: f.ledgers, namespace: 'publication' });
  t.after(() => app.close());
  const headers = { 'x-cat-cafe-user': 'operator' },
    publicationTarget = { contentRef: before.view.review.contentRef, ownerRevision: 1 };
  const resolution = await app.inject({
    method: 'POST',
    url: '/api/content-reviews/resolve',
    headers,
    payload: publicationTarget,
  });
  assert.equal(resolution.statusCode, 200);
  assert.equal(resolution.headers['cache-control'], 'private, no-store');
  assert.equal(resolution.json().ownerUserId, 'operator');
  assert.deepEqual(resolution.json().contexts, contexts);
  const blockedOpen = await app.inject({
    method: 'POST',
    url: '/api/content-reviews/prepare',
    headers,
    payload: { publication: publicationTarget, operationId: 'same-context-entry' },
  });
  assert.equal(blockedOpen.statusCode, 409);
  assert.equal(blockedOpen.json().error.contexts[0].reviewId, opened.review.reviewId);
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/content-reviews/resolve',
        headers: { ...headers, 'x-invocation-id': 'not-human' },
        payload: publicationTarget,
      })
    ).statusCode,
    401,
  );
  assert.equal(
    (
      await app.inject({
        method: 'POST',
        url: '/api/content-reviews/resolve',
        headers: { 'x-cat-cafe-user': 'other' },
        payload: publicationTarget,
      })
    ).statusCode,
    403,
  );
  const taskBefore = structuredClone(await f.tasks.get(f.taskId));
  const raw = {
    operationId: randomUUID(),
    targetCatId: 'codex-astra',
    threadId: f.thread.id,
    source: {
      kind: 'artifact-review',
      reviewId: opened.review.reviewId,
      round: 1,
      expectedReviewRevision: before.view.review.revision,
    },
    taskContext: {
      taskId: f.taskId,
      expectedTaskRevision: 1,
      reviewId: opened.review.reviewId,
      expectedReviewRevision: before.view.review.revision,
      round: 1,
    },
    intent: { body: '保留原讨论，修改选中的区域', selection: { kind: 'image-point', x: 4, y: 5 } },
  };
  const payload = contentModificationRequestSchema.parse(raw);
  const sent = await integration.requests.submit(payload, f.human);
  assert.equal(sent.stage, 'queued', JSON.stringify(sent.record.issue));
  assert.equal(sent.record.progress.task?.taskId, f.taskId);
  assert.deepEqual(await f.tasks.get(f.taskId), taskBefore, 'existing Task goal/closure/revision are unchanged');
  assert.equal(sent.record.progress.review?.reviewId, opened.review.reviewId);
  const intent = f.store.returns.get(sent.record.progress.review!.receiptRef);
  assert.equal(intent?.requestId, sent.record.requestId);
  assert.ok(f.messages.getById(sent.delivery!.messageId!)?.content.includes('view="control"'));
  const control = await inspectContentModification(
    integration.text,
    { requestId: sent.record.requestId, reviewId: opened.review.reviewId, view: 'control' },
    f.cat,
    undefined,
    integration.requests,
  );
  const facts = JSON.parse(control.json);
  assert.equal(facts.stage, 'active');
  assert.equal(facts.reviewId, opened.review.reviewId);
  assert.equal('intent' in facts, false);
  const current = await f.reviews.read(opened.review.reviewId, f.cat);
  assert.equal(current.review.rounds[0]?.ledgerRef, undefined, 'no copied ledger or migrated round');
  assert.equal(current.review.rounds[0]?.annotations[0]?.id, 'original-mark');
  assert.equal(current.review.rounds[0]?.annotations.length, 2);
  assert.equal(f.store.ledgers.getByContent('operator', `${current.review.contentRef}#version:1`), null);
  const sourceMessage = f.messages.getById(sent.record.progress.sourceMessageId!);
  assert.equal(sourceMessage?.catId, null);
  assert.equal(sourceMessage?.source, undefined);
  const replay = await integration.requests.submit(payload, f.human);
  assert.equal(replay.record.requestId, sent.record.requestId);
  assert.equal(replay.delivery?.receiptRef, sent.delivery?.receiptRef);
  assert.equal(f.store.returns.pending().length, 0, 'same winner already drained');
  const published = f.publish('returned.png');
  const returned = await f.reviews.respond(
    {
      requestId: sent.record.requestId,
      reviewId: current.review.reviewId,
      expectedRevision: current.review.revision,
      expectedTaskRevision: 1,
      expectedOwnerRevision: 1,
      operationId: 'legacy-return',
      artifactRef: '/uploads/returned.png',
      expectedArtifactRevision: String(published.timestamp),
      responses: current.review.rounds[0]!.annotations.map((a) => ({
        annotationId: a.id,
        disposition: 'addressed',
        explanation: '已修改并保留原画面关系',
      })),
    },
    f.cat,
  );
  assert.equal(returned.view.review.rounds.length, 2);
  const returnedAsset = returned.view.review.rounds[1]?.asset;
  assert.ok(returnedAsset);
  await assert.rejects(
    f.ledgers.prepare({ principal: f.human, publication: returnedAsset, operationId: 'old-version-two-entry' }),
    /existing_contexts/,
  );
  assert.equal(returned.view.review.rounds[0]?.annotations[0]?.body, '原来的讨论');
  const currentRound = structuredClone(returned.view.review.rounds[1]);
  const historyReply = await f.reviews.act(
    {
      reviewId: returned.view.review.reviewId,
      expectedRevision: returned.view.review.revision,
      expectedTaskRevision: 1,
      round: 1,
      operationId: 'inline-history-reply',
      action: { kind: 'reply', annotationId: 'original-mark', replyId: 'history-reply', body: '原版本继续讨论' },
    },
    f.human,
  );
  assert.equal(historyReply.view.review.rounds[0]?.annotations[0]?.replies.at(-1)?.body, '原版本继续讨论');
  assert.deepEqual(historyReply.view.review.rounds[1], currentRound);
  assert.equal((await integration.results.candidates(sent.record, f.human)).length, 1);
  const catalogue = await integration.context.read(payload.source, f.human);
  assert.equal(catalogue.contexts[0]?.taskId, f.taskId);
  assert.equal(catalogue.requests[0]?.record.requestId, sent.record.requestId);
  const cancelled = await integration.requests.cancel(sent.record.requestId, f.human);
  assert.equal(cancelled.record.control?.taskResolution, 'preserved');
  const afterCancellation = await f.reviews.read(opened.review.reviewId, f.cat);
  assert.equal(afterCancellation.modificationRequest?.requestId, sent.record.requestId);
  await assert.rejects(
    f.reviews.respond(
      {
        reviewId: opened.review.reviewId,
        requestId: sent.record.requestId,
        expectedRevision: afterCancellation.review.revision,
        expectedTaskRevision: 1,
        expectedOwnerRevision: 2,
        operationId: 'late-result-after-cancel',
        artifactRef: '/uploads/returned.png',
        expectedArtifactRevision: String(published.timestamp),
        responses: [],
      },
      f.cat,
    ),
    /request_cancelled/,
  );
  assert.equal((await f.tasks.get(f.taskId))?.entrustedWork?.closure.state, 'open');
  assert.ok(sourceMessage);
  sourceMessage.recall = { recalledAt: Date.now(), recalledBy: 'operator' };
  assert.equal((await f.reviews.read(opened.review.reviewId, f.cat)).review.reviewId, opened.review.reviewId);
  assert.deepEqual(
    await integration.sourceDiscussions.forReview(opened.review.reviewId, f.cat),
    [],
    'an unrelated revoked modification request must not hide an independently authorized legacy review with no original-file discussion',
  );
  const legacyOverview = await inspectArtifactReview(
    f.reviews,
    { reviewId: opened.review.reviewId },
    f.cat,
    integration.sourceDiscussions,
  );
  assert.equal(
    'sourceSnapshot' in legacyOverview,
    false,
    'legacy reviews without original-source evidence keep their original paging contract',
  );
  await writeFile(join(root, 'second-review.png'), image);
  const secondPublication = f.publish('second-review.png');
  const updatedTask = await f.lifecycle.update({
    taskId: f.taskId,
    expectedRevision: 1,
    artifactRefs: [...taskBefore!.entrustedWork!.artifactRefs, '/uploads/second-review.png'],
  });
  const otherReview = await f.reviews.prepare(
    {
      ...f.prepare,
      expectedTaskRevision: updatedTask.entrustedWork!.revision,
      operationId: randomUUID(),
      artifactRef: '/uploads/second-review.png',
      expectedArtifactRevision: String(secondPublication.timestamp),
    },
    f.human,
  );
  assert.notEqual(otherReview.review.reviewId, opened.review.reviewId);
  assert.equal(otherReview.review.task.taskId, f.taskId);
  await assert.rejects(
    inspectContentModification(
      integration.text,
      { requestId: sent.record.requestId, reviewId: otherReview.review.reviewId, view: 'control' },
      f.cat,
      undefined,
      integration.requests,
    ),
    /not_found/,
  );
});
