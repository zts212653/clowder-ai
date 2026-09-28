import assert from 'node:assert/strict';
import { test } from 'node:test';
import { artifactReviewAnchorSchema } from '../../shared/src/types/artifact-review.js';

test('video ranges are half-open, nonempty, and bind a frame inside that same range', () => {
  const valid = { kind: 'video-range', streamId: '0:0x1', startTick: 900, endTick: 1800 };
  assert.equal(artifactReviewAnchorSchema.safeParse(valid).success, true);
  assert.equal(artifactReviewAnchorSchema.safeParse({ ...valid, endTick: 900 }).success, false);
  assert.equal(artifactReviewAnchorSchema.safeParse({ ...valid, endTick: 800 }).success, false);
  assert.equal(
    artifactReviewAnchorSchema.safeParse({ ...valid, frameRegion: { tick: 1800, x: 0, y: 0, width: 10, height: 10 } })
      .success,
    false,
  );
});

test('non-finite and non-positive regions never become durable anchors', () => {
  for (const bad of [Number.NaN, Infinity, -1, 0]) {
    assert.equal(
      artifactReviewAnchorSchema.safeParse({ kind: 'image-region', x: 0, y: 0, width: bad, height: 100 }).success,
      false,
    );
  }
});

test('video point comments bind one real frame, and cannot also carry a conflicting frame region', () => {
  const anchor = {
    kind: 'video-range',
    streamId: 'stream',
    startTick: -100,
    endTick: 200,
    framePoint: { tick: -20, x: 12, y: 30 },
  };
  assert.equal(artifactReviewAnchorSchema.safeParse(anchor).success, true);
  for (const tick of [-101, 200, Infinity]) {
    assert.equal(
      artifactReviewAnchorSchema.safeParse({ ...anchor, framePoint: { ...anchor.framePoint, tick } }).success,
      false,
    );
  }
  assert.equal(
    artifactReviewAnchorSchema.safeParse({ ...anchor, frameRegion: { tick: -20, x: 12, y: 30, width: 10, height: 10 } })
      .success,
    false,
  );
});
