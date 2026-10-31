import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { VideoProjectDocumentV1, VideoProjectReviewAnchor, VideoProjectReviewTarget } from '@cat-cafe/shared';
import { assertProjectReviewTarget } from '../src/domains/collaborative-content/workspace-review/video-project-review-anchors.js';
import { resolveProjectAnchor } from '../src/domains/collaborative-content/workspace-review/video-project-review-resolution.js';
import type { VideoProjectSnapshot } from '../src/domains/video-studio/project/types.js';
import { document, region } from './workspace-review-video-project.fixture.js';

type Moment = Extract<VideoProjectReviewTarget, { kind: 'moment' }> & { endTick: number };
const target: Moment = { kind: 'moment', tick: 20, endTick: 180, timebase: { numerator: 1, denominator: 30 } };
function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}
function snapshot(document: VideoProjectDocumentV1, ownerRevision: number): VideoProjectSnapshot {
  return {
    contentRef: 'video-project:range',
    document,
    ownerRevision,
    blobDigest: `sha256:${createHash('sha256').update(JSON.stringify(document)).digest('hex')}`,
  };
}
function baseline() {
  const before = document();
  required(required(before.timeline.segments[1]).visuals[0]).endTick = 80;
  required(before.timeline.segments[1]).visuals.push({
    id: 'outside',
    assetVersionRef: 'image-v1',
    startTick: 80,
    endTick: 100,
  });
  before.timeline.events.push({
    id: 'late-caption',
    kind: 'subtitle',
    text: 'Original',
    startTick: 160,
    durationTicks: 20,
  });
  return before;
}
function resolution(before: VideoProjectDocumentV1, after: VideoProjectDocumentV1, moment: Moment = target) {
  const previous = snapshot(before, 1);
  const anchor: VideoProjectReviewAnchor = {
    kind: 'video-project',
    baseOwnerRevision: 1,
    baseRevision: previous.blobDigest,
    target: moment,
  };
  return resolveProjectAnchor(anchor, previous, snapshot(after, 2));
}
function replacement(after: VideoProjectDocumentV1) {
  required(after.assets[0]).versions.push({
    ...required(required(after.assets[0]).versions[0]),
    id: 'changed',
    sha256: `sha256:${'b'.repeat(64)}`,
  });
}

for (const hinted of [false, true])
  for (const boxed of [false, true])
    test(`F326 range location checks the later shot with hinted=${hinted} boxed=${boxed}`, () => {
      const before = baseline();
      const after = structuredClone(before);
      replacement(after);
      required(required(after.timeline.segments[1]).visuals[0]).assetVersionRef = 'changed';
      assert.equal(
        resolution(before, after, {
          ...target,
          ...(hinted ? { segmentId: 'shot-1', visualUseId: 'visual-1' } : {}),
          ...(boxed ? { region } : {}),
        }),
        'orphaned',
      );
    });

for (const boxed of [false, true])
  test(`F326 range location treats a later event as spatial=${boxed}`, () => {
    const before = baseline();
    const after = structuredClone(before);
    required(after.timeline.events[0]).text = 'Changed';
    assert.equal(
      resolution(before, after, { ...target, visualUseId: 'visual-1', ...(boxed ? { region } : {}) }),
      boxed ? 'moved' : 'orphaned',
    );
  });

test('F326 range location ignores edits outside its half-open end and project bookkeeping', () => {
  const before = baseline();
  const after = structuredClone(before);
  replacement(after);
  required(required(after.timeline.segments[1]).visuals[1]).assetVersionRef = 'changed';
  after.title = 'A different title';
  assert.equal(resolution(before, after), 'moved');
});

test('F326 range location orphans a deleted later shot and missing range end', () => {
  const before = baseline();
  const after = structuredClone(before);
  after.timeline.segments.pop();
  assert.equal(resolution(before, after, { ...target, visualUseId: 'visual-1' }), 'orphaned');
  after.timeline.durationTicks = 179;
  assert.equal(resolution(before, after), 'orphaned');
});

test('F326 range location retains equivalent static-image metadata and raw anchor history', () => {
  const before = baseline();
  const after = structuredClone(before);
  const original = required(required(after.assets[0]).versions[0]);
  required(after.assets[0]).versions.push({
    ...original,
    id: 'equivalent',
    mediaType: 'Image/PNG',
    durationTicks: 999,
    rotation: 0,
  });
  required(required(after.timeline.segments[1]).visuals[0]).assetVersionRef = 'equivalent';
  const savedTarget = structuredClone(target);
  assert.equal(resolution(before, after, target), 'moved');
  assert.deepEqual(target, savedTarget);
});

test('F326 range location validates input/current timebase and starts as well as the range end', () => {
  const before = baseline();
  const after = structuredClone(before);
  after.timeline.timebase = { numerator: 1, denominator: 24 };
  assert.equal(resolution(before, after), 'orphaned');
  const mismatchedBefore = structuredClone(before);
  mismatchedBefore.timeline.timebase = { numerator: 1, denominator: 24 };
  assert.equal(resolution(mismatchedBefore, before), 'orphaned');
  assert.equal(resolution(before, before, { ...target, visualUseId: 'outside' }), 'orphaned');
});

for (const values of [
  { endTick: 20 },
  { endTick: 19 },
  { endTick: 301 },
  { endTick: 180.5 },
  { endTick: Number.MAX_SAFE_INTEGER + 1 },
  { tick: -1 },
  { tick: 20.5 },
  { timebase: { numerator: 1, denominator: 24 } },
])
  test(`F326 rejects invalid range coordinates ${JSON.stringify(values)}`, () => {
    assert.throws(() => assertProjectReviewTarget(baseline(), { ...target, ...values }), { code: 'invalid_action' });
  });

test('F326 range may end exactly at timeline duration and cross a hinted start shot', () => {
  assert.doesNotThrow(() =>
    assertProjectReviewTarget(baseline(), { ...target, endTick: 300, segmentId: 'shot-1', visualUseId: 'visual-1' }),
  );
});

for (const material of ['image/png', 'video/mp4'])
  test(`F326 range location includes playback phase for ${material}`, () => {
    const before = baseline();
    required(required(before.assets[0]).versions[0]).mediaType = material;
    const after = structuredClone(before);
    required(required(after.timeline.segments[0]).visuals[0]).startTick = 10;
    assert.equal(
      resolution(before, after, { ...target, endTick: 90 }),
      material === 'image/png' ? 'moved' : 'orphaned',
    );
  });
