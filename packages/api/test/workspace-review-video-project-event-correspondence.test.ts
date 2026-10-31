import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentRef, fixture, principal } from './workspace-review-video-project.fixture.js';

const targets = [
  { kind: 'project' },
  { kind: 'segment', segmentId: 'shot-1' },
  { kind: 'moment', tick: 50, timebase: { numerator: 1, denominator: 30 }, visualUseId: 'visual-1' },
] as const;

for (const target of targets)
  test(`same-position audio ID swap cannot name unchanged A after unrelated C changes (${target.kind})`, async () => {
    const f = await fixture();
    try {
      const before = f.projects.snapshots.get(1)!;
      const base = before.assets[0]!.versions[0]!;
      before.assets.push({
        id: 'audio',
        name: 'Dialogue',
        kind: 'audio',
        versions: ['a', 'b', 'c'].map((letter) => ({
          ...base,
          id: `audio-${letter}-v1`,
          mediaType: 'audio/mpeg',
          sha256: `sha256:${letter.repeat(64)}`,
          locator: { kind: 'workspace', rootId: 'registered-root', path: `${letter}.mp3` },
        })),
      });
      before.timeline.events = ['a', 'b', 'c'].map((letter) => ({
        id: `event-${letter}`,
        kind: 'audio',
        startTick: 0,
        durationTicks: 100,
        assetVersionRef: `audio-${letter}-v1`,
      }));
      const reviews = f.service();
      const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
      const marked = await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: 1,
        operationId: 'mark',
        body: 'Replace audio A',
        target,
      });
      const changed = (await f.projects.load({ principal, contentRef })).document;
      changed.assets[1]!.versions.push({ ...changed.assets[1]!.versions[0]!, id: 'audio-a-v2' });
      changed.assets[1]!.versions.push({
        ...changed.assets[1]!.versions[2]!,
        id: 'audio-c-v2',
        sha256: `sha256:${'d'.repeat(64)}`,
      });
      changed.timeline.events[0]!.id = 'event-b';
      changed.timeline.events[0]!.assetVersionRef = 'audio-a-v2';
      changed.timeline.events[1]!.id = 'event-a';
      changed.timeline.events[2]!.assetVersionRef = 'audio-c-v2';
      const receipt = await f.projects.save(changed, 'swap-with-c-change');
      await assert.rejects(
        reviews.act({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: marked.review.revision,
          operationId: 'address',
          action: {
            kind: 'addressed',
            annotationId: marked.review.annotations[0]!.id,
            result: { assetVersionRef: 'audio-a-v2', ownerRevision: receipt.ownerRevision },
          },
        }),
        { code: 'invalid_action' },
      );
    } finally {
      await f.cleanup();
    }
  });
