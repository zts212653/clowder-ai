import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { createWorkSourceBindingVerifier } from '../src/domains/collaborative-content/works/source-binding.js';
import { VideoProjectReviewService } from '../src/domains/collaborative-content/workspace-review/video-project-review-service.js';
import { screeningFixture } from './helpers/video-project-screening.js';

test('work binding verifies the original project, rendered bytes and audience-owned ledger without copying it', async (t) => {
  const f = await screeningFixture();
  t.after(f.cleanup);
  const store = new ArtifactReviewStore(`${f.root}/reviews.sqlite`);
  t.after(() => store.close());
  const screenings = f.make(),
    projects = f.projects;
  const { screening } = await screenings.register(f.request);
  const reviews = new VideoProjectReviewService({ store: store.ledgers, projects });
  const prepared = await reviews.prepare({
    principal: f.principal,
    contentRef: f.request.contentRef,
    operationId: 'existing-b-ledger',
  });
  await reviews.annotate({
    principal: f.principal,
    reviewId: prepared.review.reviewId,
    expectedRevision: prepared.review.revision,
    operationId: 'original-project-opinion',
    body: '原 B 意见必须仍在原账本',
    target: { kind: 'project' },
  });
  const before = await reviews.read({ principal: f.principal, reviewId: prepared.review.reviewId });
  assert.equal(before.review.annotations.length, 1);
  const reference = { contentRef: `work:${'a'.repeat(64)}`, ownerRevision: 1 };
  const principal = { ...f.principal, threadId: 'work-thread' };
  const binding = {
    sourceProjectContentRef: f.request.contentRef,
    sourceOwnerRevision: 1,
    sourceDigest: f.request.input.blobDigest,
    screeningId: screening.id,
    reviewId: before.review.reviewId,
  };
  let digest = screening.media.blobDigest;
  const verify = createWorkSourceBindingVerifier({ projects, screenings, reviews, workDigest: async () => digest });
  await verify(reference, binding, principal);
  assert.deepEqual(await reviews.read({ principal: f.principal, reviewId: before.review.reviewId }), before);
  await assert.rejects(
    verify(reference, { ...binding, sourceDigest: `sha256:${'b'.repeat(64)}` }, principal),
    /publication_changed/,
  );
  await assert.rejects(verify(reference, { ...binding, sourceOwnerRevision: 2 }, principal), /publication_changed/);
  await assert.rejects(
    verify(reference, { ...binding, screeningId: 'not-the-film' }, principal),
    /screening_not_found/,
  );
  await assert.rejects(verify(reference, { ...binding, reviewId: 'not-the-ledger' }, principal), /not_found/);
  digest = `sha256:${'c'.repeat(64)}`;
  await assert.rejects(verify(reference, binding, principal), /publication_changed/);
  await assert.rejects(
    verify(reference, binding, {
      ...principal,
      actor: { kind: 'cat', actorId: 'director' },
      invocationId: 'ungranted-caller',
    }),
    /access denied/i,
  );
});
