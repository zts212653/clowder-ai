import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentRef, fixture, principal } from './workspace-review-video-project.fixture.js';

for (const unrelatedChange of [false, true])
  for (const branch of ['receipt', 'asset'] as const)
    test(`segment ID swap cannot borrow another shot's material (${branch}, unrelated=${unrelatedChange})`, async () => {
      const f = await fixture();
      try {
        const before = f.projects.snapshots.get(1)!;
        before.assets[0]!.versions.push({
          ...before.assets[0]!.versions[0]!,
          id: 'other-image-v1',
          sha256: `sha256:${'c'.repeat(64)}`,
        });
        before.timeline.segments[1]!.visuals[0]!.assetVersionRef = 'other-image-v1';
        const reviews = f.service();
        const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
        const marked = await reviews.annotate({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: 1,
          operationId: 'mark',
          body: 'Fix shot one',
          target: { kind: 'segment', segmentId: 'shot-1' },
        });
        const changed = (await f.projects.load({ principal, contentRef })).document;
        changed.timeline.segments[0]!.id = 'shot-2';
        changed.timeline.segments[1]!.id = 'shot-1';
        if (unrelatedChange)
          changed.timeline.events.push({
            id: 'unrelated-caption',
            kind: 'subtitle',
            startTick: 250,
            durationTicks: 10,
            text: 'Later caption',
          });
        const receipt = await f.projects.save(changed, 'identity-swap');
        await assert.rejects(
          reviews.act({
            principal,
            reviewId: opened.review.reviewId,
            expectedRevision: marked.review.revision,
            operationId: 'address',
            action: {
              kind: 'addressed',
              annotationId: marked.review.annotations[0]!.id,
              result:
                branch === 'receipt'
                  ? receipt
                  : {
                      assetVersionRef: 'other-image-v1',
                      ownerRevision: receipt.ownerRevision,
                    },
            },
          }),
          { code: 'invalid_action' },
        );
      } finally {
        await f.cleanup();
      }
    });
