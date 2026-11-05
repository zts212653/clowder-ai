import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectiveContentScopeRef } from '../src/domains/video-studio/content-owner/collective-scope.js';
import { baseConstraint, digest, fixture, scope } from './collective-markdown.fixture.js';

test('a freshly admitted historical reader can reply to that exact original annotation but cannot resolve or create an annotation on stale bytes', async (t) => {
  const f = await fixture(t);
  const seed = await f.execute(
    { ...baseConstraint, action: 'annotate' },
    {
      kind: 'annotate',
      messageEventId: 'original-comment',
      body: 'Original comment',
      quote: 'A unique shared quote.',
      location: { channelId: 'general', rootEventId: scope.sourceEventId },
      expectedReviewRevision: 1,
    },
    'historical-seed',
  );
  assert.equal(seed.status, 'ok');
  const review = f.reviews.getByContent('real-local-owner', scope.contentRef, collectiveContentScopeRef(scope));
  assert.ok(review);
  const annotation = review.annotations[0];
  assert.ok(annotation);
  const receipt = await f.owner.settle({
    contentRef: scope.contentRef,
    expectedOwnerRevision: 1,
    bytes: Buffer.from('# New guide\n\nDifferent current bytes.'),
    actor: { kind: 'human', actorId: 'human-alice' },
    operationId: 'fixture-newer-version',
    authorizeEffect: async () => {},
    operationContext: {
      kind: 'collective-artifact:apply',
      actorHumanId: 'human-alice',
      scopeRef: collectiveContentScopeRef(scope),
      custodyRevision: 1,
      dispositionId: 'fixture-newer-version',
      requestDigest: digest,
    },
  });
  await f.execute(
    { ...baseConstraint, ownerRevision: 2, catalogueOwnerRevision: 2, blobDigest: receipt.blobDigest },
    {},
    'read-new-source',
  );
  const historical = { ...baseConstraint, catalogueOwnerRevision: 2, action: 'annotate' as const };
  const state = f.reviews.get(review.reviewId);
  assert.ok(state);
  const reply = await f.execute(
    { ...historical, reviewReply: { annotationId: annotation.id, messageEventId: 'historical-public-reply' } },
    {
      kind: 'review-action',
      expectedReviewRevision: state.revision,
      action: {
        kind: 'reply',
        annotationId: annotation.id,
        messageEventId: 'historical-public-reply',
        body: 'Continuing the original discussion.',
        replyToEventId: 'original-comment',
        location: { channelId: 'general', rootEventId: scope.sourceEventId },
      },
    },
    'historical-reply',
  );
  assert.equal(reply.status, 'ok', JSON.stringify(reply));
  const resolved = await f.execute(
    historical,
    {
      kind: 'review-action',
      expectedReviewRevision: state.revision + 1,
      action: { kind: 'set_annotation_state', annotationId: annotation.id, state: 'resolved' },
    },
    'historical-cannot-resolve',
  );
  assert.deepEqual(resolved, { status: 'error', error: { code: 'conflict' } });
  const forgedSubject = await f.execute(
    { ...historical, reviewReply: { annotationId: annotation.id, messageEventId: 'historical-public-reply' } },
    {
      kind: 'review-action',
      expectedReviewRevision: state.revision + 1,
      action: { kind: 'set_annotation_state', annotationId: annotation.id, state: 'resolved' },
    },
    'reply-capability-cannot-resolve',
  );
  assert.deepEqual(forgedSubject, { status: 'error', error: { code: 'access_denied' } });
  const staleAnnotation = await f.execute(
    historical,
    {
      kind: 'annotate',
      messageEventId: 'stale-new-comment',
      body: 'Cannot annotate old bytes.',
      quote: 'A unique shared quote.',
      location: { channelId: 'general', rootEventId: scope.sourceEventId },
      expectedReviewRevision: state.revision + 1,
    },
    'stale-new-annotation',
  );
  assert.equal(staleAnnotation.status, 'error');
  assert.equal(f.reviews.get(review.reviewId)?.annotations[0]?.replies?.length, 1);
});
