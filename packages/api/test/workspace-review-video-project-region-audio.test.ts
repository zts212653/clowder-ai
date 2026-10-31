import assert from 'node:assert/strict';
import { test } from 'node:test';

import { at, contentRef, fixture, principal, region } from './workspace-review-video-project.fixture.js';

for (const resultKind of ['receipt', 'asset'] as const) {
  test(`a spatial moment region cannot be addressed by audio-only change (${resultKind})`, async () => {
    const f = await fixture();
    try {
      const base = f.projects.snapshots.get(1)!;
      base.assets.push({
        id: 'sound',
        name: 'Sound',
        kind: 'audio',
        versions: [
          {
            id: 'sound-v1',
            mediaType: 'audio/wav',
            byteLength: 10,
            sha256: `sha256:${'c'.repeat(64)}`,
            locator: { kind: 'workspace', rootId: 'registered-root', path: 'sound.wav' },
            recordedAt: at,
            origin: base.origin,
          },
        ],
      });
      base.timeline.events.push({
        id: 'sound-at-frame',
        kind: 'audio',
        startTick: 50,
        durationTicks: 10,
        assetVersionRef: 'sound-v1',
        segmentId: 'shot-1',
      });
      const reviews = f.service();
      const opened = await reviews.prepare({ principal, contentRef, operationId: `prepare-${resultKind}` });
      const marked = await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: opened.review.revision,
        operationId: `mark-${resultKind}`,
        body: 'Fix the pixels inside this box',
        target: {
          kind: 'moment',
          tick: 50,
          timebase: { numerator: 1, denominator: 30 },
          segmentId: 'shot-1',
          visualUseId: 'visual-1',
          region,
        },
      });
      const changed = (await f.projects.load({ principal, contentRef })).document;
      changed.assets[1]!.versions.push({
        ...changed.assets[1]!.versions[0]!,
        id: 'sound-v2',
        sha256: `sha256:${'d'.repeat(64)}`,
      });
      changed.timeline.events[0]!.assetVersionRef = 'sound-v2';
      const receipt = await f.projects.save(changed, `audio-only-${resultKind}`);
      const result =
        resultKind === 'receipt' ? receipt : { assetVersionRef: 'sound-v2', ownerRevision: receipt.ownerRevision };
      await assert.rejects(
        reviews.act({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: marked.review.revision,
          operationId: `address-${resultKind}`,
          action: { kind: 'addressed', annotationId: marked.review.annotations[0]!.id, result },
        }),
        { code: 'invalid_action' },
      );
    } finally {
      await f.cleanup();
    }
  });
}
