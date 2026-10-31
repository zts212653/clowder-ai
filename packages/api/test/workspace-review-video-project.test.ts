import assert from 'node:assert/strict';
import { test } from 'node:test';
import { projectReviewAnchor } from '../src/domains/collaborative-content/workspace-review/video-project-review-anchors.js';
import { cat, contentRef, fixture, principal } from './workspace-review-video-project.fixture.js';

test('F326 persists project discussions in the canonical artifact ledger through creation, locate, address and reopen', async () => {
  const f = await fixture();
  try {
    const reviews = f.service();
    const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
    assert.equal(opened.review.source.kind, 'video-project');
    assert.equal(f.store.ledgers.getByContent('operator', contentRef)?.reviewId, opened.review.reviewId);
    assert.equal(opened.review.contentRef, contentRef, 'head revision does not create a second discussion');
    let saved = await reviews.annotate({
      principal,
      reviewId: opened.review.reviewId,
      expectedRevision: 1,
      operationId: 'whole-film',
      body: 'Please clarify the middle.',
      target: { kind: 'project' },
    });
    const annotation = saved.review.annotations[0]!;
    const original = structuredClone(annotation.anchor);
    const snapshot = await f.projects.load({ principal, contentRef });
    const targets = ['shot-1', 'shot-2'].map((segmentId) =>
      projectReviewAnchor(snapshot, { kind: 'segment', segmentId }),
    );
    saved = await reviews.act({
      principal: cat,
      reviewId: opened.review.reviewId,
      expectedRevision: (await reviews.read({ principal: cat, reviewId: opened.review.reviewId })).review.revision,
      operationId: 'locate',
      action: { kind: 'located', annotationId: annotation.id, targets, reason: 'Both shots show this.' },
    });
    assert.deepEqual(
      saved.review.annotations[0]?.anchor,
      original,
      'locating never replaces the original comment target',
    );
    assert.deepEqual(saved.review.annotations[0]?.projectHistory?.at(-1)?.targets, targets);
    const located = await reviews.read({ principal, reviewId: opened.review.reviewId });
    assert.deepEqual(
      located.annotationResolutions[0]?.projectTargets?.map((item) => item.anchor),
      [original, ...targets],
    );
    assert.deepEqual(
      located.annotationResolutions[0]?.projectTargets?.map((item) => item.status),
      ['attached', 'attached', 'attached'],
    );
    const changed = structuredClone(snapshot.document);
    changed.timeline.events.push({
      id: 'clarifying-subtitle',
      kind: 'subtitle',
      startTick: 50,
      durationTicks: 100,
      text: 'A clearer middle.',
    });
    const result = await f.projects.save(changed, 'save-subtitle');
    saved = await reviews.act({
      principal: cat,
      reviewId: opened.review.reviewId,
      expectedRevision: (await reviews.read({ principal: cat, reviewId: opened.review.reviewId })).review.revision,
      operationId: 'address',
      action: { kind: 'addressed', annotationId: annotation.id, result },
    });
    assert.equal(saved.review.annotations[0]?.state, 'open', 'a modification receipt is not Human approval');
    saved = await reviews.act({
      principal,
      reviewId: opened.review.reviewId,
      expectedRevision: (await reviews.read({ principal: principal, reviewId: opened.review.reviewId })).review
        .revision,
      operationId: 'resolve',
      action: { kind: 'resolved', annotationId: annotation.id },
    });
    saved = await reviews.act({
      principal,
      reviewId: opened.review.reviewId,
      expectedRevision: (await reviews.read({ principal: principal, reviewId: opened.review.reviewId })).review
        .revision,
      operationId: 'reopen',
      action: { kind: 'reopened', annotationId: annotation.id, reason: 'Still wrong.' },
    });
    saved = await reviews.act({
      principal: cat,
      reviewId: opened.review.reviewId,
      expectedRevision: (await reviews.read({ principal: cat, reviewId: opened.review.reviewId })).review.revision,
      operationId: 'reply',
      action: { kind: 'replied', annotationId: annotation.id, replyId: 'reply-1', body: 'I will recheck.' },
    });
    assert.deepEqual(
      saved.review.annotations[0]?.projectHistory?.map((event) => event.kind),
      ['created', 'located', 'addressed', 'resolved', 'reopened', 'replied'],
    );
    assert.equal(
      saved.review.sourceHistory?.some((source) => source.kind === 'video-project' && source.ownerRevision === 2),
      true,
      'addressed content keeps its immutable owner metadata without changing the original source',
    );
    const receipt = await reviews.operationReceipt({
      principal,
      reviewId: opened.review.reviewId,
      operationId: 'reply',
    });
    const canonical = (await reviews.read({ principal, reviewId: opened.review.reviewId })).review;
    const restarted = f.reopen();
    assert.deepEqual((await restarted.read({ principal, reviewId: opened.review.reviewId })).review, canonical);
    assert.deepEqual((await restarted.read({ principal: cat, reviewId: opened.review.reviewId })).review, saved.review);
    assert.deepEqual(
      await restarted.operationReceipt({ principal, reviewId: opened.review.reviewId, operationId: 'reply' }),
      receipt,
    );
  } finally {
    await f.cleanup();
  }
});
