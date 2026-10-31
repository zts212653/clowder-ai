import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentRef, fixture, principal, region } from './workspace-review-video-project.fixture.js';

const targets = [
  { kind: 'project' },
  { kind: 'segment', segmentId: 'shot-1' },
  { kind: 'moment', tick: 50, timebase: { numerator: 1, denominator: 30 } },
  { kind: 'moment', tick: 50, timebase: { numerator: 1, denominator: 30 }, visualUseId: 'visual-1' },
  { kind: 'moment', tick: 50, timebase: { numerator: 1, denominator: 30 }, visualUseId: 'visual-1', region },
  { kind: 'artwork', assetVersionRef: 'image-v1' },
  { kind: 'artwork', assetVersionRef: 'image-v1', visualUseId: 'visual-1' },
] as const;

for (const [index, target] of targets.entries())
  test(`rejects identical named sibling after renamed visual + actual material change target ${index} ${target.kind}`, async () => {
    const f = await fixture();
    try {
      // Test-only authority snapshots. Same production review service and canonical SQLite store.
      f.projects.snapshots.get(1)!.timeline.segments[0]!.visuals.push({
        id: 'visual-sibling',
        assetVersionRef: 'image-v1',
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
        target,
      });
      const changed = (await f.projects.load({ principal, contentRef })).document;
      const original = changed.assets[0]!.versions[0]!;
      changed.assets[0]!.versions.push({ ...original, id: 'equivalent-v2' });
      changed.assets[0]!.versions.push({ ...original, id: 'actually-changed-v2', sha256: `sha256:${'b'.repeat(64)}` });
      changed.timeline.segments[0]!.visuals[0]!.assetVersionRef = 'actually-changed-v2';
      changed.timeline.segments[0]!.visuals[1]!.id = 'renamed-sibling';
      changed.timeline.segments[0]!.visuals[1]!.assetVersionRef = 'equivalent-v2';
      const receipt = await f.projects.save(changed, 'mixed-change');
      await assert.rejects(
        reviews.act({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: marked.review.revision,
          operationId: 'address',
          action: {
            kind: 'addressed',
            annotationId: marked.review.annotations[0]!.id,
            result: { assetVersionRef: 'equivalent-v2', ownerRevision: receipt.ownerRevision },
          },
        }),
        { code: 'invalid_action' },
      );
    } finally {
      await f.cleanup();
    }
  });

for (const target of targets.filter((t) => t.kind !== 'artwork'))
  for (const branch of ['receipt', 'asset'] as const)
    test(`IDs alone remain insufficient ${target.kind} ${'region' in target ? 'region' : 'plain'} ${branch}`, async () => {
      const f = await fixture();
      try {
        f.projects.snapshots.get(1)!.timeline.segments[0]!.visuals.push({
          id: 'visual-sibling',
          assetVersionRef: 'image-v1',
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
          target,
        });
        const changed = (await f.projects.load({ principal, contentRef })).document;
        changed.assets[0]!.versions.push({ ...changed.assets[0]!.versions[0]!, id: 'equivalent-v2' });
        changed.timeline.segments[0]!.visuals[1]!.id = 'renamed-sibling';
        changed.timeline.segments[0]!.visuals[1]!.assetVersionRef = 'equivalent-v2';
        const receipt = await f.projects.save(changed, 'identity-only');
        await assert.rejects(
          reviews.act({
            principal,
            reviewId: opened.review.reviewId,
            expectedRevision: marked.review.revision,
            operationId: 'address',
            action: {
              kind: 'addressed',
              annotationId: marked.review.annotations[0]!.id,
              result: branch === 'receipt' ? receipt : { assetVersionRef: 'equivalent-v2', ownerRevision: 2 },
            },
          }),
          { code: 'invalid_action' },
        );
      } finally {
        await f.cleanup();
      }
    });
