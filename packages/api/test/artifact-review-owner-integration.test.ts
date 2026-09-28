import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ArtifactReviewAction, ArtifactReviewView } from '@cat-cafe/shared';
import sharp from 'sharp';
import { ArtifactReviewService } from '../src/domains/collaborative-content/artifact-review/service.js';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { F309ContentReviewProducerAdapter } from '../src/domains/growing/F309ContentReviewProducerAdapter.js';
import { MediaOwnerError } from '../src/domains/video-studio/content-owner/media-errors.js';
import { createReviewFixture, reviewCat, reviewHuman } from './helpers/artifact-review-fixture.js';

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
  const root = await mkdtemp(join(tmpdir(), 'f309-owner-integration-'));
  await writeFile(
    join(root, 'cover.png'),
    await sharp({ create: { width: 160, height: 100, channels: 3, background: '#eee4d5' } })
      .png()
      .toBuffer(),
  );
  const f = createReviewFixture(root, root);
  const store = new ArtifactReviewStore(join(root, 'review.sqlite'));
  const reviews = new ArtifactReviewService({ store, media: f.media });
  const producer = new F309ContentReviewProducerAdapter({ store, reviews, onChanged: () => {} });
  const { principal: _principal, ...prepare } = f.prepare;
  t.after(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const view = await reviews.prepare(prepare, reviewHuman);
  return { ...f, root, store, reviews, producer, view };
}

function command(view: ArtifactReviewView, action: ArtifactReviewAction) {
  return {
    reviewId: view.review.reviewId,
    expectedRevision: view.review.revision,
    expectedTaskRevision: view.authority.taskRevision,
    round: view.review.rounds.at(-1)?.number ?? 1,
    operationId: randomUUID(),
    action,
  };
}

test('only the current owner judgment round enters Needs Me; a human decision retires it without closing the Task', async (t) => {
  const f = await setup(t);
  let view = (
    await f.reviews.act(
      command(f.view, {
        kind: 'annotate',
        annotationId: 'one',
        anchor: { kind: 'image-region', x: 1, y: 1, width: 10, height: 10 },
        body: '标题位置',
      }),
      reviewHuman,
    )
  ).view;
  assert.deepEqual(await f.producer.listCurrentReceipts('operator'), []);
  view = (
    await f.reviews.act(
      command(view, { kind: 'request_judgment', summary: '封面就绪', judgmentNeeded: '可以发布这版吗？' }),
      reviewCat,
    )
  ).view;
  const receipts = await f.producer.listCurrentReceipts('operator');
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0]?.producer.producerId, 'f309.content_review');
  assert.equal(receipts[0]?.taskRef.subjectRef, 'task:work:task-cover');
  await f.reviews.act(command(view, { kind: 'decide', outcome: 'approved', explanation: '可以发布。' }), reviewHuman);
  assert.deepEqual(await f.producer.listCurrentReceipts('operator'), []);
  assert.equal(f.task.current?.status, 'doing');
  assert.equal(f.store.returns.pending().length, 1);
});

test('Task drift and revoked sources withdraw attention with an honest owner audit, never a forged human decision', async (t) => {
  const f = await setup(t);
  let view = (
    await f.reviews.act(
      command(f.view, { kind: 'request_judgment', summary: '封面就绪', judgmentNeeded: '请确认' }),
      reviewCat,
    )
  ).view;
  const task = f.task.current;
  assert.ok(task?.entrustedWork);
  f.task.current = { ...task, entrustedWork: { ...task.entrustedWork, revision: 2 } };
  assert.deepEqual(await f.producer.listCurrentReceipts('operator'), []);
  assert.equal(f.store.get(view.review.reviewId)?.revision, view.review.revision, 'enumeration is read-only');
  const reevaluate = (current: ArtifactReviewView, expectedProducerRevision = current.review.revision) =>
    f.producer.reEvaluate({
      ownerUserId: 'operator',
      producerSubjectRef: current.review.reviewId,
      expectedProducerRevision,
      taskRef: { subjectRef: 'task:work:task-cover', observedRevision: current.review.task.observedRevision },
      reEvaluateActionRef: `content-review:${current.review.reviewId}#reevaluate`,
    });
  assert.equal((await reevaluate(view, view.review.revision - 1)).state, 'stale');
  assert.equal(f.store.get(view.review.reviewId)?.revision, view.review.revision, 'a stale action is also inert');
  assert.equal((await reevaluate(view)).state, 'retired');
  let review = f.store.get(view.review.reviewId);
  assert.equal(review?.rounds[0]?.attentionRetiredReason, 'task_changed');
  assert.equal(review?.rounds[0]?.decision, undefined);
  assert.deepEqual(f.store.history(view.review.reviewId).at(-1)?.receipt.actor, {
    kind: 'owner',
    actorId: 'content-review',
  });
  view = await f.reviews.read(view.review.reviewId, reviewCat);
  view = (
    await f.reviews.act(
      command(view, { kind: 'request_judgment', summary: '新版任务已核对', judgmentNeeded: '请确认' }),
      reviewCat,
    )
  ).view;
  assert.equal((await f.producer.listCurrentReceipts('operator')).length, 1);
  f.messages.clear();
  assert.deepEqual(await f.producer.listCurrentReceipts('operator'), []);
  assert.equal(f.store.get(view.review.reviewId)?.revision, view.review.revision);
  assert.equal((await reevaluate(view)).state, 'retired');
  review = f.store.get(view.review.reviewId);
  assert.equal(review?.rounds[0]?.attentionRetiredReason, 'access_revoked');
  assert.equal(f.store.returns.pending().length, 0);
});

test('a temporary owner read outage never becomes permanent access revocation', async (t) => {
  const f = await setup(t);
  const view = (
    await f.reviews.act(
      command(f.view, { kind: 'request_judgment', summary: '待确认', judgmentNeeded: '请确认' }),
      reviewCat,
    )
  ).view;
  const originalRead = f.reviews.readCurrent.bind(f.reviews);
  f.reviews.readCurrent = async () => {
    throw new MediaOwnerError('media_unavailable');
  };
  await assert.rejects(f.producer.listCurrentReceipts('operator'), /media_unavailable/);
  assert.equal(f.store.get(view.review.reviewId)?.rounds[0]?.attentionRetiredReason, undefined);
  f.reviews.readCurrent = originalRead;
  assert.equal((await f.producer.listCurrentReceipts('operator')).length, 1);
});
