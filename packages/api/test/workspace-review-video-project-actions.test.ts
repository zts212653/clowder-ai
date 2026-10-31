import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentRef, fixture, principal, region } from './workspace-review-video-project.fixture.js';

test('F326 addressed needs changed content or an explicit reason; new frozen assets and known display rotation are accepted', async () => {
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
        body: 'Recheck',
        target: { kind: 'project' },
      })
    ).review;
    const current = (await f.projects.load({ principal, contentRef })).document;
    const sameBytes = await f.projects.save(current, 'save-identical');
    await assert.rejects(
      reviews.act({
        principal,
        reviewId: review.reviewId,
        expectedRevision: review.revision,
        operationId: 'claim-identical-change',
        action: { kind: 'addressed', annotationId: review.annotations[0]!.id, result: sameBytes },
      }),
      { code: 'invalid_action' },
    );
    const v1 = current.assets[0]!.versions[0]!;
    current.assets[0]!.versions.push({ ...v1, id: 'rotated-v2', rotation: 90, sha256: `sha256:${'b'.repeat(64)}` });
    current.timeline.segments[0]!.visuals[0]!.assetVersionRef = 'rotated-v2';
    await f.projects.save(current, 'new-asset');
    review = (
      await reviews.act({
        principal,
        reviewId: review.reviewId,
        expectedRevision: review.revision,
        operationId: 'address-with-version',
        action: {
          kind: 'addressed',
          annotationId: review.annotations[0]!.id,
          result: { assetVersionRef: 'rotated-v2', ownerRevision: 3 },
        },
      })
    ).review;
    const refreshed = await reviews.refresh({
      principal,
      reviewId: review.reviewId,
      expectedRevision: review.revision,
      operationId: 'refresh-three',
      expectedOwnerRevision: 3,
    });
    const rotated = await reviews.annotate({
      principal,
      reviewId: review.reviewId,
      expectedRevision: refreshed.review.revision,
      operationId: 'rotated-anchor',
      body: 'Display pixels',
      target: {
        kind: 'artwork',
        assetVersionRef: 'rotated-v2',
        region: { ...region, rotation: 90, width: 480, height: 640 },
      },
    });
    assert.equal(rotated.review.annotations.length, 2);
    assert.equal(
      rotated.review.sourceHistory?.length,
      2,
      'same digest owner receipts do not masquerade as changed source bytes',
    );
  } finally {
    await f.cleanup();
  }
});

test('F326 addressed rejects invented receipts and stale assets; explicit no-change keeps its reason', async () => {
  const f = await fixture();
  try {
    const reviews = f.service();
    const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
    const saved = await reviews.annotate({
      principal,
      reviewId: opened.review.reviewId,
      expectedRevision: 1,
      operationId: 'comment',
      body: 'Change image',
      target: { kind: 'artwork', assetVersionRef: 'image-v1' },
    });
    const changed = (await f.projects.load({ principal, contentRef })).document;
    changed.title = 'New';
    const real = await f.projects.save(changed, 'save-real');
    const base = { principal, reviewId: opened.review.reviewId, expectedRevision: saved.review.revision };
    for (const [index, result] of [
      { ...real, operationId: 'invented' },
      { ...real, blobDigest: `sha256:${'b'.repeat(64)}` },
      { ...real, contentRef: 'video-project:other' },
      { assetVersionRef: 'image-v1', ownerRevision: 2 },
      { assetVersionRef: 'missing', ownerRevision: 2 },
      { kind: 'not-changed' as const, reason: '  ' },
    ].entries())
      await assert.rejects(
        reviews.act({
          ...base,
          operationId: `fake:${index}`,
          action: { kind: 'addressed', annotationId: saved.review.annotations[0]!.id, result },
        }),
        { code: 'invalid_action' },
      );
    const addressed = await reviews.act({
      ...base,
      operationId: 'explicit-not-changed',
      action: {
        kind: 'addressed',
        annotationId: saved.review.annotations[0]!.id,
        result: { kind: 'not-changed', reason: 'Source image is correct.' },
      },
    });
    assert.deepEqual(addressed.review.annotations[0]?.projectHistory?.at(-1)?.result, {
      kind: 'not-changed',
      reason: 'Source image is correct.',
    });
    assert.equal(addressed.review.annotations[0]?.state, 'open');
  } finally {
    await f.cleanup();
  }
});
