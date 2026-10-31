import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WorkspaceContentReviewService } from '../src/domains/collaborative-content/workspace-review/service.js';
import { WorkspaceContentSourceService } from '../src/domains/workspace/workspace-content-source.js';
import { cat, contentRef, fixture, principal } from './workspace-review-video-project.fixture.js';

test('F326 shares Human reads but rejects old media/text mutation and Cat/Human impersonation', async () => {
  const f = await fixture();
  try {
    const reviews = f.service();
    const opened = await reviews.prepare({ principal: cat, contentRef, operationId: 'cat-prepare' });
    const source = new WorkspaceContentSourceService({
      ownerUserId: 'operator',
      resolveWorktreeRoot: async () => {
        throw new Error('must not read workspace');
      },
    });
    const human = new WorkspaceContentReviewService({ store: f.store.ledgers, source, projects: f.projects });
    assert.deepEqual((await human.read({ principal, reviewId: opened.review.reviewId })).review, opened.review);
    for (const forged of [
      { userId: 'operator', actor: { kind: 'human' as const, actorId: 'other' } },
      { userId: 'other', actor: { kind: 'human' as const, actorId: 'other' } },
      { userId: 'operator', actor: { kind: 'cat' as const, actorId: 'sol' } },
      { ...cat, invocationId: 'forged' },
      { ...cat, actor: { kind: 'cat' as const, actorId: 'fake-cat' } },
    ]) {
      await assert.rejects(reviews.read({ principal: forged, reviewId: opened.review.reviewId }), {
        code: 'access_denied',
      });
    }
    await assert.rejects(human.read({ principal: cat, reviewId: opened.review.reviewId }), { code: 'access_denied' });
    await assert.rejects(
      human.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: 1,
        operationId: 'legacy-annotate',
        body: 'wrong entrance',
        target: { kind: 'media_anchor', anchor: { kind: 'image-point', x: 10, y: 10 } },
      }),
      { code: 'unsupported_content' },
    );
    await assert.rejects(
      human.act({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: 1,
        operationId: 'legacy-action',
        action: { kind: 'reply', annotationId: 'fake', replyId: 'fake', body: 'wrong entrance' },
      }),
      { code: 'unsupported_content' },
    );
  } finally {
    await f.cleanup();
  }
});

test('F326 ledger writes are CAS, durable receipt replay and payload/actor fenced', async () => {
  const f = await fixture();
  try {
    const reviews = f.service();
    const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
    const input = {
      principal,
      reviewId: opened.review.reviewId,
      expectedRevision: 1,
      operationId: 'first',
      body: 'Check',
      target: { kind: 'project' as const },
    };
    const results = await Promise.allSettled([
      reviews.annotate(input),
      reviews.annotate({ ...input, operationId: 'second' }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = results.find((r) => r.status === 'rejected');
    assert.equal(rejected?.status === 'rejected' ? rejected.reason.code : undefined, 'revision_conflict');
    const first = await reviews.annotate(input);
    assert.equal(first.replayed, true);
    assert.equal(first.review.annotations.length, 1);
    assert.equal(first.receipt.revision, 2);
    await assert.rejects(reviews.annotate({ ...input, body: 'Different' }), { code: 'operation_reused' });
    await assert.rejects(reviews.annotate({ ...input, principal: cat }), { code: 'operation_reused' });
    assert.equal(await reviews.operationReceipt({ principal, reviewId: input.reviewId, operationId: 'second' }), null);
  } finally {
    await f.cleanup();
  }
});

test('F326 read authorization never projects write or reply capability for a read-only Cat', async () => {
  const f = await fixture();
  try {
    const authorize = f.projects.authorize.bind(f.projects);
    f.projects.authorize = async (input) => {
      await authorize(input);
      if (input.principal.actor.kind === 'cat' && input.permission === 'write') throw new Error('Read-only Cat');
    };
    const reviews = f.service();
    const opened = await reviews.prepare({ principal, contentRef, operationId: 'human-prepare' });
    const catView = await reviews.read({ principal: cat, reviewId: opened.review.reviewId });
    assert.equal(catView.sourceState, 'current');
    assert.equal(catView.canWrite, false);
    assert.equal(catView.canReply, false);
    const humanView = await reviews.read({ principal, reviewId: opened.review.reviewId });
    assert.equal(humanView.canWrite, true);
    await assert.rejects(
      reviews.annotate({
        principal: cat,
        reviewId: opened.review.reviewId,
        expectedRevision: 1,
        operationId: 'cat-write',
        body: 'Forbidden',
        target: { kind: 'project' },
      }),
      /Read-only Cat/,
    );
    assert.deepEqual(f.store.ledgers.get(opened.review.reviewId), opened.review);
  } finally {
    await f.cleanup();
  }
});
