import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentRef, fixture, principal } from './workspace-review-video-project.fixture.js';

for (const hint of [false, true])
  for (const branch of ['receipt', 'asset'] as const)
    test(`artwork ${hint ? 'hinted' : 'unhinted'} ${branch} cannot claim swapped IDs with unchanged applied inputs`, async () => {
      const f = await fixture();
      try {
        const before = f.projects.snapshots.get(1)!;
        const first = before.assets[0]!.versions[0]!;
        before.assets[0]!.versions.push({ ...first, id: 'different-v1', sha256: `sha256:${'c'.repeat(64)}` });
        before.timeline.segments[0]!.visuals.push({
          id: 'visual-sibling',
          assetVersionRef: 'different-v1',
          startTick: 0,
          endTick: 100,
        });
        const reviews = f.service();
        const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
        const marked = await reviews.annotate({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: 1,
          operationId: 'mark',
          body: 'Replace drawing',
          target: { kind: 'artwork', assetVersionRef: 'image-v1', ...(hint ? { visualUseId: 'visual-1' } : {}) },
        });
        const changed = (await f.projects.load({ principal, contentRef })).document;
        changed.timeline.segments[0]!.visuals[0]!.id = 'visual-sibling';
        changed.timeline.segments[0]!.visuals[1]!.id = 'visual-1';
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
              result: branch === 'receipt' ? receipt : { assetVersionRef: 'different-v1', ownerRevision: 2 },
            },
          }),
          { code: 'invalid_action' },
        );
      } finally {
        await f.cleanup();
      }
    });
