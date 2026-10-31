import assert from 'node:assert/strict';
import { test } from 'node:test';

import { at, contentRef, fixture, principal } from './workspace-review-video-project.fixture.js';

for (const resultKind of ['receipt', 'asset'] as const) {
  test(`latest located shot must bind ${resultKind} proof instead of the original whole-film anchor`, async () => {
    const f = await fixture();
    try {
      const reviews = f.service();
      const opened = await reviews.prepare({ principal, contentRef, operationId: `prepare-${resultKind}` });
      const marked = await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: opened.review.revision,
        operationId: `mark-${resultKind}`,
        body: 'Something is wrong somewhere in the film',
        target: { kind: 'project' },
      });
      const frozen = await f.projects.load({ principal, contentRef, ownerRevision: 1 });
      const located = await reviews.act({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: marked.review.revision,
        operationId: `locate-${resultKind}`,
        action: {
          kind: 'located',
          annotationId: marked.review.annotations[0]!.id,
          targets: [
            {
              kind: 'video-project',
              baseOwnerRevision: frozen.ownerRevision,
              baseRevision: frozen.blobDigest,
              target: { kind: 'segment', segmentId: 'shot-1' },
            },
          ],
          reason: 'The issue was located to shot-1',
        },
      });
      const changed = (await f.projects.load({ principal, contentRef })).document;
      changed.assets[0]!.versions.push({
        ...changed.assets[0]!.versions[0]!,
        id: 'shot-2-only-v2',
        sha256: `sha256:${'b'.repeat(64)}`,
      });
      changed.timeline.segments[1]!.visuals[0]!.assetVersionRef = 'shot-2-only-v2';
      const receipt = await f.projects.save(changed, `change-shot-2-${resultKind}`);
      const result =
        resultKind === 'receipt'
          ? receipt
          : { assetVersionRef: 'shot-2-only-v2', ownerRevision: receipt.ownerRevision };
      await assert.rejects(
        reviews.act({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: located.review.revision,
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

for (const resultKind of ['receipt', 'asset'] as const)
  test(`visualUseId must not hide changed audio at the same moment (${resultKind})`, async () => {
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
      const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare-moment' });
      const marked = await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: opened.review.revision,
        operationId: 'mark-moment',
        body: 'Fix the sound at this frame',
        target: {
          kind: 'moment',
          tick: 50,
          timebase: { numerator: 1, denominator: 30 },
          segmentId: 'shot-1',
          visualUseId: 'visual-1',
        },
      });
      const changed = (await f.projects.load({ principal, contentRef })).document;
      changed.assets[1]!.versions.push({
        ...changed.assets[1]!.versions[0]!,
        id: 'sound-v2',
        sha256: `sha256:${'d'.repeat(64)}`,
      });
      changed.timeline.events[0]!.assetVersionRef = 'sound-v2';
      const receipt = await f.projects.save(changed, 'fix-audio');
      const addressed = await reviews.act({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: marked.review.revision,
        operationId: 'address-moment',
        action: {
          kind: 'addressed',
          annotationId: marked.review.annotations[0]!.id,
          result:
            resultKind === 'receipt' ? receipt : { assetVersionRef: 'sound-v2', ownerRevision: receipt.ownerRevision },
        },
      });
      assert.equal(addressed.review.annotations[0]!.projectHistory!.at(-1)!.kind, 'addressed');
    } finally {
      await f.cleanup();
    }
  });
