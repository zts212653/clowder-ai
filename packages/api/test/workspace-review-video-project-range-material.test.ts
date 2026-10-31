import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VideoProjectReviewTarget } from '@cat-cafe/shared';
import { assertProjectTargetChanged } from '../src/domains/collaborative-content/workspace-review/result-proof/target.js';
import { document, region } from './workspace-review-video-project.fixture.js';

const target: VideoProjectReviewTarget = {
  kind: 'moment',
  tick: 20,
  endTick: 180,
  timebase: { numerator: 1, denominator: 30 },
};
function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}

for (const metadata of ['mime', 'duration', 'rotation', 'bytes'] as const)
  for (const boxed of [false, true])
    test(`F326 range material ${metadata} spatial=${boxed} honors render equivalence in both result branches`, () => {
      const before = document();
      const after = structuredClone(before);
      const asset = required(after.assets[0]);
      const oldVersion = required(asset.versions[0]);
      asset.versions.push({
        ...oldVersion,
        id: 'result',
        ...(metadata === 'mime' ? { mediaType: 'Image/PNG; charset=UTF-8' } : {}),
        ...(metadata === 'duration' ? { durationTicks: 999 } : {}),
        ...(metadata === 'rotation' ? { rotation: 90 as const } : {}),
        ...(metadata === 'bytes' ? { sha256: `sha256:${'b'.repeat(64)}` as const } : {}),
      });
      required(required(after.timeline.segments[1]).visuals[0]).assetVersionRef = 'result';
      const selected = { ...target, ...(boxed ? { region } : {}) };
      for (const assetRef of [undefined, 'result']) {
        const claim = () => assertProjectTargetChanged(before, after, selected, assetRef);
        if (metadata === 'rotation' || metadata === 'bytes') assert.doesNotThrow(claim);
        else assert.throws(claim, { code: 'invalid_action' });
      }
    });

for (const boxed of [false, true])
  test(`F326 range allows real equivalent-material insertion but rejects rename with spatial=${boxed}`, () => {
    const before = document();
    const after = structuredClone(before);
    const asset = required(after.assets[0]);
    asset.versions.push({ ...required(asset.versions[0]), id: 'result' });
    const segment = required(after.timeline.segments[1]);
    segment.visuals.push({ ...required(segment.visuals[0]), id: 'new-use', assetVersionRef: 'result' });
    const selected = { ...target, ...(boxed ? { region } : {}) };
    assert.doesNotThrow(() => assertProjectTargetChanged(before, after, selected, 'result'));
    segment.visuals.shift();
    assert.throws(() => assertProjectTargetChanged(before, after, selected, 'result'), { code: 'invalid_action' });
    assert.throws(() => assertProjectTargetChanged(before, after, selected), { code: 'invalid_action' });
  });

test('F326 range does not borrow changes to an event duration beyond its half-open bounds', () => {
  const before = document();
  before.timeline.events.push({
    id: 'caption',
    kind: 'subtitle',
    startTick: 10,
    durationTicks: 190,
    text: 'Unchanged',
  });
  const after = structuredClone(before);
  required(after.timeline.events[0]).durationTicks = 220;
  assert.throws(() => assertProjectTargetChanged(before, after, target), { code: 'invalid_action' });
});

test('F326 range can prove a later generated visual without borrowing unplaced spatial captions', () => {
  const before = document();
  before.timeline.events.push({ id: 'late-caption', kind: 'subtitle', startTick: 160, text: 'Before' });
  const after = structuredClone(before);
  required(after.timeline.events[0]).text = 'After';
  assert.doesNotThrow(() => assertProjectTargetChanged(before, after, target));
  assert.throws(() => assertProjectTargetChanged(before, after, { ...target, region }), { code: 'invalid_action' });
  required(after.timeline.segments[1]).visuals.push({
    id: 'generated',
    startTick: 20,
    endTick: 60,
    generated: { fill: '#111' },
  });
  assert.doesNotThrow(() => assertProjectTargetChanged(before, after, { ...target, region }));
});

for (const mediaType of ['audio/wav', 'application/octet-stream', 'video/mp4'])
  test(`F326 range spatial qualification honors ${mediaType}`, () => {
    const before = document();
    const asset = required(before.assets[0]);
    asset.versions.push({ ...required(asset.versions[0]), id: 'auxiliary', mediaType });
    required(before.timeline.segments[1]).visuals.push({
      id: 'auxiliary-use',
      assetVersionRef: 'auxiliary',
      startTick: 0,
      endTick: 80,
    });
    const after = structuredClone(before);
    required(after.assets[0]).versions.push({
      ...required(asset.versions[1]),
      id: 'result',
      sha256: `sha256:${'b'.repeat(64)}`,
    });
    required(required(after.timeline.segments[1]).visuals[1]).assetVersionRef = 'result';
    for (const assetRef of [undefined, 'result']) {
      const claim = () => assertProjectTargetChanged(before, after, { ...target, region }, assetRef);
      if (mediaType === 'video/mp4') assert.doesNotThrow(claim);
      else assert.throws(claim, { code: 'invalid_action' });
    }
  });
