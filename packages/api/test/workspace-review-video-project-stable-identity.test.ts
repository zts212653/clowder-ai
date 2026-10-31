import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentRef, fixture, principal } from './workspace-review-video-project.fixture.js';

for (const entity of ['segment', 'artwork-hinted', 'artwork-unhinted'] as const)
  for (const edit of ['insert-before', 'insert-after', 'move-before', 'move-after'] as const)
    for (const branch of ['receipt', 'asset'] as const)
      test(`stable ${entity} permits ${edit} with genuine material change (${branch})`, async () => {
        const f = await fixture();
        try {
          const before = f.projects.snapshots.get(1)!;
          const segmentTarget = entity === 'segment';
          const shotIndex = segmentTarget && edit === 'move-before' ? 1 : 0;
          const originalShot = before.timeline.segments[shotIndex]!;
          const shotId = originalShot.id;
          const useId = originalShot.visuals[0]!.id;
          if (!segmentTarget)
            originalShot.visuals.push({
              id: 'second-overlay',
              generated: { kind: 'overlay', value: 'existing' },
              startTick: 0,
              endTick: 100,
            });
          if (!segmentTarget && edit === 'move-before') originalShot.visuals.reverse();
          const reviews = f.service();
          const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
          const marked = await reviews.annotate({
            principal,
            reviewId: opened.review.reviewId,
            expectedRevision: 1,
            operationId: 'mark',
            body: 'Replace this drawing',
            target: segmentTarget
              ? { kind: 'segment', segmentId: shotId }
              : {
                  kind: 'artwork',
                  assetVersionRef: 'image-v1',
                  ...(entity === 'artwork-hinted' ? { visualUseId: useId } : {}),
                },
          });
          const changed = (await f.projects.load({ principal, contentRef })).document;
          changed.assets[0]!.versions.push({
            ...changed.assets[0]!.versions[0]!,
            id: 'changed-v2',
            sha256: `sha256:${'b'.repeat(64)}`,
          });
          const shot = changed.timeline.segments[shotIndex]!;
          const use = shot.visuals.find((visual) => visual.id === useId)!;
          use.assetVersionRef = 'changed-v2';
          if (segmentTarget) {
            if (edit.startsWith('insert')) {
              const insertBefore = edit === 'insert-before';
              if (insertBefore) for (const segment of changed.timeline.segments) segment.startTick += 20;
              const inserted = {
                id: 'inserted-shot',
                kind: 'shot' as const,
                label: 'New shot',
                startTick: insertBefore ? 0 : 200,
                durationTicks: 20,
                visuals: [{ id: 'new-use', generated: { kind: 'solid', value: 'new' }, startTick: 0, endTick: 20 }],
              };
              if (insertBefore) changed.timeline.segments.unshift(inserted);
              else changed.timeline.segments.push(inserted);
            } else {
              const other = changed.timeline.segments[1 - shotIndex]!;
              shot.startTick = edit === 'move-before' ? 0 : 100;
              other.startTick = edit === 'move-before' ? 100 : 0;
              changed.timeline.segments = edit === 'move-before' ? [shot, other] : [other, shot];
            }
          } else if (edit.startsWith('insert')) {
            const inserted = {
              id: 'new-overlay',
              generated: { kind: 'overlay', value: 'new' },
              startTick: 0,
              endTick: 100,
            };
            if (edit === 'insert-before') shot.visuals.unshift(inserted);
            else shot.visuals.push(inserted);
          } else {
            // Preserve identity and its input together while changing its render order.
            const overlay = shot.visuals.find((visual) => visual.id === 'second-overlay')!;
            shot.visuals = edit === 'move-before' ? [use, overlay] : [overlay, use];
          }
          const receipt = await f.projects.save(changed, 'stable-edit');
          const result = await reviews.act({
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
                  : { assetVersionRef: 'changed-v2', ownerRevision: receipt.ownerRevision },
            },
          });
          assert.equal(result.review.annotations[0]!.projectHistory!.at(-1)!.kind, 'addressed');
          assert.deepEqual(result.review.annotations[0]!.anchor, marked.review.annotations[0]!.anchor);
        } finally {
          await f.cleanup();
        }
      });
