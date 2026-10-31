import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentRef, fixture, principal, region } from './workspace-review-video-project.fixture.js';

test('F326 stable segments move while replaced artwork/moment pixels remain orphaned without proportional drift', async () => {
  const f = await fixture();
  try {
    const reviews = f.service();
    let review = (await reviews.prepare({ principal, contentRef, operationId: 'prepare' })).review;
    for (const [index, target] of [
      { kind: 'segment' as const, segmentId: 'shot-1' },
      {
        kind: 'moment' as const,
        tick: 50,
        timebase: { numerator: 1, denominator: 30 },
        visualUseId: 'visual-1',
        region,
      },
      {
        kind: 'artwork' as const,
        assetVersionRef: 'image-v1',
        visualUseId: 'visual-1',
        region: { ...region, width: 640, height: 480 },
      },
    ].entries())
      review = (
        await reviews.annotate({
          principal,
          reviewId: review.reviewId,
          expectedRevision: review.revision,
          operationId: `anchor:${index}`,
          body: 'Check here',
          target,
        })
      ).review;
    const changed = (await f.projects.load({ principal, contentRef })).document;
    const oldVersion = changed.assets[0]!.versions[0]!;
    changed.assets[0]!.versions.push({
      ...oldVersion,
      id: 'image-v2',
      sha256: `sha256:${'b'.repeat(64)}`,
      width: 1280,
      height: 960,
    });
    changed.timeline.segments[0]!.visuals[0]!.assetVersionRef = 'image-v2';
    await f.projects.save(changed, 'replace-image');
    const view = await reviews.read({ principal, reviewId: review.reviewId });
    assert.equal(view.sourceState, 'changed');
    assert.deepEqual(
      view.annotationResolutions.map((r) => r.status),
      ['moved', 'orphaned', 'orphaned'],
    );
    assert.deepEqual(
      view.review.annotations,
      review.annotations,
      'remapping only projects evidence and never rewrites old targets',
    );
    await assert.rejects(
      reviews.refresh({
        principal,
        reviewId: review.reviewId,
        expectedRevision: review.revision,
        operationId: 'refresh-to-wrong',
        expectedOwnerRevision: 1,
      }),
      { code: 'source_changed' },
    );
    const fresh = await reviews.refresh({
      principal,
      reviewId: review.reviewId,
      expectedRevision: review.revision,
      operationId: 'refresh-real',
      expectedOwnerRevision: 2,
    });
    assert.equal(fresh.sourceState, 'current');
    assert.equal(fresh.review.sourceHistory?.length, 2);
    assert.deepEqual(
      fresh.annotationResolutions.map((r) => r.status),
      ['moved', 'orphaned', 'orphaned'],
    );
  } finally {
    await f.cleanup();
  }
});
