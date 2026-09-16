import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  ArtifactReview,
  ArtifactReviewAction,
  ArtifactReviewActor,
  ReviewedMediaAsset,
} from '../../shared/src/types/artifact-review.js';
import {
  appendRespondedVersion,
  applyArtifactReviewAction,
} from '../src/domains/collaborative-content/artifact-review/reducer.js';

const human: ArtifactReviewActor = { kind: 'human', actorId: 'operator' };
const cat: ArtifactReviewActor = { kind: 'cat', actorId: 'codex-astra' };
const now = '2026-09-07T12:00:00.000Z';
const asset: ReviewedMediaAsset = {
  contentRef: 'prepared-media:cover',
  ownerRevision: 1,
  blobDigest: `sha256:${'a'.repeat(64)}`,
  mediaType: 'image/png',
  media: { kind: 'image', width: 800, height: 600 },
  sourcePublication: { artifactRef: '/uploads/cover.png', sourceRef: 'message:thread:message-1', revision: '1' },
  ownerReceiptRef: 'content-receipt-1',
};
function initial(): ArtifactReview {
  return {
    version: 1,
    reviewId: 'review-cover',
    revision: 1,
    title: '猫咖活动封面',
    task: { taskId: 'task-cover', threadId: 'thread', ownerUserId: 'operator', observedRevision: 3 },
    contentRef: asset.contentRef,
    rounds: [{ number: 1, asset, openedAt: now, state: 'draft', annotations: [], responses: [] }],
    createdAt: now,
    updatedAt: now,
  };
}
function act(review: ArtifactReview, action: ArtifactReviewAction, actor = human, round = 1) {
  return applyArtifactReviewAction(review, {
    action,
    actor,
    round,
    ownerCatId: cat.actorId,
    now,
    receiptRef: `review-receipt-${review.revision + 1}`,
  });
}
function annotated() {
  return act(initial(), {
    kind: 'annotate',
    annotationId: 'title',
    anchor: { kind: 'image-region', x: 100, y: 40, width: 300, height: 80 },
    body: '标题往下一些',
  });
}

test('full review keeps author identities, replies, resolution and explicit human decision separate', () => {
  const first = annotated();
  assert.equal(initial().rounds[0]?.annotations.length, 0, 'transitions cannot mutate the stored predecessor');
  const reply = act(
    first,
    { kind: 'reply', annotationId: 'title', replyId: 'reply-1', body: '我会保留字距，调整标题位置。' },
    cat,
  );
  assert.deepEqual(reply.rounds[0]?.annotations[0]?.replies[0]?.author, cat);
  const resolved = act(reply, { kind: 'set_annotation_state', annotationId: 'title', state: 'resolved' }, cat);
  assert.equal(resolved.rounds[0]?.state, 'draft', 'resolving an annotation is not approval of the artifact');
  const waiting = act(
    resolved,
    { kind: 'request_judgment', summary: '封面已调整', judgmentNeeded: '请确认最终版式是否适合发布。' },
    cat,
  );
  assert.equal(waiting.rounds[0]?.state, 'awaiting_human');
  assert.throws(
    () => act(waiting, { kind: 'decide', outcome: 'approved', explanation: '冒充人的确认' }, cat),
    /human_required/,
  );
  const approved = act(waiting, { kind: 'decide', outcome: 'approved', explanation: '可以发布这版。' });
  assert.equal(approved.rounds[0]?.decision?.receiptRef, 'review-receipt-6');
  assert.deepEqual(approved.rounds[0]?.decision?.actor, human);
  const reopened = act(approved, { kind: 'reopen', explanation: '活动时间需要重新确认。' });
  assert.equal(reopened.rounds[0]?.state, 'draft');
  assert.equal(reopened.rounds[0]?.decision, undefined);
});

test('new versions require per-annotation responses and preserve every old anchor without guessing a remap', () => {
  const review = annotated();
  const next = {
    ...asset,
    ownerRevision: 2,
    blobDigest: `sha256:${'b'.repeat(64)}` as const,
    ownerReceiptRef: 'content-receipt-2',
  };
  assert.throws(
    () => appendRespondedVersion(review, { asset: next, responses: [], actor: cat, now }),
    /invalid_action/,
  );
  const changed = appendRespondedVersion(review, {
    asset: next,
    responses: [{ annotationId: 'title', disposition: 'addressed', explanation: '标题已向下移动 20 像素。' }],
    actor: cat,
    now,
  });
  assert.deepEqual(changed.rounds[0]?.annotations, review.rounds[0]?.annotations);
  assert.equal(changed.rounds[1]?.annotations.length, 0);
  assert.equal(changed.rounds[1]?.responses[0]?.annotationId, 'title');
  assert.equal(changed.rounds[0]?.state, 'superseded');
  assert.throws(
    () => act(changed, { kind: 'decide', outcome: 'approved', explanation: '不能确认旧版' }),
    /asset_changed/,
  );
});

test('bounds, stale rounds, duplicate ids, forged edit authors and foreign reanchors are rejected', () => {
  const review = annotated();
  assert.throws(
    () =>
      act(initial(), {
        kind: 'annotate',
        annotationId: 'outside',
        anchor: { kind: 'image-region', x: 790, y: 0, width: 30, height: 10 },
        body: '越界',
      }),
    /invalid_anchor/,
  );
  assert.throws(
    () =>
      act(review, {
        kind: 'annotate',
        annotationId: 'title',
        anchor: { kind: 'image-region', x: 0, y: 0, width: 10, height: 10 },
        body: '重复',
      }),
    /invalid_action/,
  );
  assert.throws(() => act(review, { kind: 'edit', annotationId: 'title', body: '改写人的意见' }, cat), /access_denied/);
  assert.throws(
    () =>
      act(review, {
        kind: 'annotate',
        annotationId: 'new',
        anchor: { kind: 'image-region', x: 0, y: 0, width: 10, height: 10 },
        body: '假出处',
        reanchoredFrom: { round: 8, annotationId: 'missing' },
      }),
    /invalid_action/,
  );
  assert.throws(
    () =>
      act(
        review,
        { kind: 'request_judgment', summary: 'review', judgmentNeeded: 'need person' },
        { kind: 'cat', actorId: 'unassigned-cat' },
      ),
    /owner_required/,
  );
});
