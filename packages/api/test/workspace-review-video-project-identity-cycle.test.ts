import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VideoProjectReviewTarget } from '@cat-cafe/shared';
import { contentRef, fixture, principal } from './workspace-review-video-project.fixture.js';

const targets: VideoProjectReviewTarget[] = [
  { kind: 'project' },
  { kind: 'segment', segmentId: 'shot-1' },
  { kind: 'moment', tick: 50, timebase: { numerator: 1, denominator: 30 } },
  { kind: 'artwork', assetVersionRef: 'image-v1', visualUseId: 'visual-1' },
];

for (const target of targets)
  for (const branch of target.kind === 'artwork' ? (['receipt', 'asset'] as const) : (['asset'] as const))
    test(`three-use ID cycle cannot borrow another visible input change (${target.kind}, ${branch})`, async () => {
      const f = await fixture();
      try {
        const before = f.projects.snapshots.get(1)!;
        const version = before.assets[0]!.versions[0]!;
        before.assets[0]!.versions.push(
          { ...version, id: 'image-b', sha256: `sha256:${'b'.repeat(64)}` },
          { ...version, id: 'image-c', sha256: `sha256:${'c'.repeat(64)}` },
        );
        before.timeline.segments[0]!.visuals.push(
          { id: 'visual-b', assetVersionRef: 'image-b', startTick: 0, endTick: 100 },
          { id: 'visual-c', assetVersionRef: 'image-c', startTick: 0, endTick: 100 },
          { id: 'unrelated', generated: { kind: 'solid', value: 'black' }, startTick: 0, endTick: 100 },
        );
        const reviews = f.service();
        const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
        const marked = await reviews.annotate({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: 1,
          operationId: 'mark',
          body: 'Replace this content',
          target,
        });
        const changed = (await f.projects.load({ principal, contentRef })).document;
        const visuals = changed.timeline.segments[0]!.visuals;
        visuals[0]!.id = 'visual-b';
        visuals[1]!.id = 'visual-c';
        visuals[2]!.id = 'visual-1';
        visuals[3]!.generated = { kind: 'solid', value: 'white' };
        const receipt = await f.projects.save(changed, 'cycle-with-unrelated-change');
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
                branch === 'receipt' ? receipt : { assetVersionRef: 'image-c', ownerRevision: receipt.ownerRevision },
            },
          }),
          { code: 'invalid_action' },
        );
      } finally {
        await f.cleanup();
      }
    });
