import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VideoProjectReviewTarget } from '@cat-cafe/shared';
import { contentRef, fixture, principal, region } from './workspace-review-video-project.fixture.js';

test('F326 validates all four targets, frozen tick/visual evidence and original display-pixel bounds', async () => {
  const f = await fixture();
  try {
    const reviews = f.service();
    let view = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
    const artworkRegion = { ...region, width: 640, height: 480 };
    const targets: VideoProjectReviewTarget[] = [
      { kind: 'project' },
      { kind: 'segment', segmentId: 'shot-1' },
      {
        kind: 'moment',
        tick: 50,
        timebase: { numerator: 1, denominator: 30 },
        segmentId: 'shot-1',
        visualUseId: 'visual-1',
        region,
      },
      { kind: 'artwork', assetVersionRef: 'image-v1', visualUseId: 'visual-1', region: artworkRegion },
      {
        kind: 'artwork',
        assetVersionRef: 'image-v1',
        region: { ...artworkRegion, bbox: { x: 100.5, y: 80.25, width: 100.5, height: 90.5 } },
      },
    ];
    for (const [index, target] of targets.entries()) {
      const saved = await reviews.annotate({
        principal,
        reviewId: view.review.reviewId,
        expectedRevision: view.review.revision,
        operationId: `valid:${index}`,
        body: 'Check this',
        target,
      });
      view = await reviews.read({ principal, reviewId: saved.review.reviewId });
    }
    assert.equal(view.review.annotations.length, 5);
    const invalid: VideoProjectReviewTarget[] = [
      { kind: 'segment', segmentId: 'deleted' },
      { kind: 'moment', tick: 300, timebase: { numerator: 1, denominator: 30 } },
      { kind: 'moment', tick: 50, timebase: { numerator: 1, denominator: 25 } },
      { kind: 'moment', tick: 50, timebase: { numerator: 1, denominator: 30 }, segmentId: 'shot-2' },
      { kind: 'moment', tick: 50, timebase: { numerator: 1, denominator: 30 }, visualUseId: 'visual-2' },
      { kind: 'moment', tick: 50, timebase: { numerator: 1, denominator: 30 }, region: artworkRegion },
      { kind: 'artwork', assetVersionRef: 'missing' },
      { kind: 'artwork', assetVersionRef: 'image-v1', region },
      {
        kind: 'artwork',
        assetVersionRef: 'image-v1',
        region: { ...artworkRegion, bbox: { x: 639, y: 0, width: 2, height: 1 } },
      },
    ];
    for (const [index, target] of invalid.entries()) {
      await assert.rejects(
        reviews.annotate({
          principal,
          reviewId: view.review.reviewId,
          expectedRevision: view.review.revision,
          operationId: `invalid:${index}`,
          body: 'Cannot anchor here',
          target,
        }),
        { code: 'invalid_action' },
      );
    }
    assert.deepEqual((await reviews.read({ principal, reviewId: view.review.reviewId })).review, view.review);
  } finally {
    await f.cleanup();
  }
});
