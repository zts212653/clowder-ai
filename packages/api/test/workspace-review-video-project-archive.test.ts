import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentRef, fixture, principal } from './workspace-review-video-project.fixture.js';

test('F326 archived head remains readable but refuses new discussion, history and source mutations', async () => {
  const f = await fixture();
  try {
    const reviews = f.service();
    let review = (await reviews.prepare({ principal, contentRef, operationId: 'prepare' })).review;
    review = (
      await reviews.annotate({
        principal,
        reviewId: review.reviewId,
        expectedRevision: 1,
        operationId: 'comment',
        body: 'Check opening',
        target: { kind: 'project' },
      })
    ).review;
    const annotation = review.annotations[0];
    assert.ok(annotation);
    const snapshot = await f.projects.load({ principal, contentRef });
    snapshot.document.archivedAt = '2026-10-08T04:00:00.000Z';
    await f.projects.save(snapshot.document, 'archive');
    const input = { principal, reviewId: review.reviewId, expectedRevision: review.revision };
    await assert.rejects(
      reviews.act({
        ...input,
        operationId: 'new-reply',
        action: {
          kind: 'replied',
          annotationId: annotation.id,
          replyId: 'after-archive',
          body: 'This must stay read-only.',
        },
      }),
      { code: 'source_changed' },
    );
    await assert.rejects(
      reviews.act({
        ...input,
        operationId: 'new-address',
        action: {
          kind: 'addressed',
          annotationId: annotation.id,
          result: { kind: 'not-changed', reason: 'No edit.' },
        },
      }),
      { code: 'source_changed' },
    );
    await assert.rejects(reviews.refresh({ ...input, operationId: 'new-refresh', expectedOwnerRevision: 2 }), {
      code: 'source_changed',
    });
    await assert.rejects(
      reviews.annotate({ ...input, operationId: 'new-comment', body: 'New', target: { kind: 'project' } }),
      { code: 'source_changed' },
    );
    const archivedView = await reviews.read({ principal, reviewId: review.reviewId });
    assert.deepEqual(archivedView.review, review);
    assert.equal(archivedView.canReply, false);
    assert.equal(archivedView.historyReadOnly, true);
    assert.equal(
      (await reviews.operationReceipt({ principal, reviewId: review.reviewId, operationId: 'comment' }))?.revision,
      2,
    );
    assert.equal(
      await reviews.operationReceipt({ principal, reviewId: review.reviewId, operationId: 'new-reply' }),
      null,
    );
  } finally {
    await f.cleanup();
  }
});
