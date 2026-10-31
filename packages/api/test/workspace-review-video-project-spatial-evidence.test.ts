import assert from 'node:assert/strict';
import { test } from 'node:test';
import { at, contentRef, fixture, principal, region } from './workspace-review-video-project.fixture.js';

for (const change of ['caption-text', 'caption-speaker', 'caption-end', 'segment-end'] as const)
  for (const hint of [false, true])
    for (const branch of ['receipt', 'asset'] as const)
      test(`F326 unplaced ${change} cannot prove boxed pixels (${branch}, hint=${hint})`, async () => {
        const f = await fixture();
        try {
          const base = f.projects.snapshots.get(1)!;
          base.timeline.events.push({
            id: 'caption',
            kind: 'subtitle',
            startTick: 40,
            durationTicks: 40,
            text: 'Short bottom caption',
            speaker: 'Speaker',
          });
          const reviews = f.service();
          const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
          const marked = await reviews.annotate({
            principal,
            reviewId: opened.review.reviewId,
            expectedRevision: 1,
            operationId: 'mark',
            body: 'Fix top-left pixels',
            target: {
              kind: 'moment',
              tick: 50,
              timebase: { numerator: 1, denominator: 30 },
              region: { ...region, bbox: { x: 0, y: 0, width: 10, height: 10 } },
              ...(hint ? { visualUseId: 'visual-1' } : {}),
            },
          });
          const changed = (await f.projects.load({ principal, contentRef })).document;
          if (change === 'caption-text') changed.timeline.events[0]!.text = 'Another short bottom caption';
          if (change === 'caption-speaker') changed.timeline.events[0]!.speaker = 'Other speaker';
          if (change === 'caption-end') changed.timeline.events[0]!.durationTicks = 41;
          if (change === 'segment-end') {
            changed.timeline.segments[0]!.durationTicks = 99;
            changed.timeline.segments[0]!.visuals[0]!.endTick = 99;
          }
          const receipt = await f.projects.save(changed, 'change');
          const result =
            branch === 'receipt' ? receipt : { assetVersionRef: 'image-v1', ownerRevision: receipt.ownerRevision };
          await assert.rejects(
            reviews.act({
              principal,
              reviewId: opened.review.reviewId,
              expectedRevision: marked.review.revision,
              operationId: 'address',
              action: {
                kind: 'addressed',
                annotationId: marked.review.annotations[0]!.id,
                result,
              },
            }),
            { code: 'invalid_action' },
          );
        } finally {
          await f.cleanup();
        }
      });

for (const branch of ['receipt', 'asset'] as const)
  for (const hint of [false, true])
    for (const mediaType of ['audio/wav', 'application/octet-stream'])
      test(`F326 ${mediaType} cannot masquerade as a changed spatial visual (${branch}, hint=${hint})`, async () => {
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
                mediaType,
                byteLength: 10,
                sha256: `sha256:${'c'.repeat(64)}`,
                locator: { kind: 'workspace', rootId: 'registered-root', path: 'sound.wav' },
                recordedAt: at,
                origin: base.origin,
              },
            ],
          });
          base.timeline.segments[0]!.visuals.push({
            id: 'sound-as-visual',
            startTick: 0,
            endTick: 100,
            assetVersionRef: 'sound-v1',
          });
          const reviews = f.service();
          const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
          const marked = await reviews.annotate({
            principal,
            reviewId: opened.review.reviewId,
            expectedRevision: 1,
            operationId: 'mark',
            body: 'Fix the pixels',
            target: {
              kind: 'moment',
              tick: 50,
              timebase: { numerator: 1, denominator: 30 },
              region,
              ...(hint ? { visualUseId: 'visual-1' } : {}),
            },
          });
          const changed = (await f.projects.load({ principal, contentRef })).document;
          changed.assets[1]!.versions.push({
            ...changed.assets[1]!.versions[0]!,
            id: 'sound-v2',
            sha256: `sha256:${'d'.repeat(64)}`,
          });
          changed.timeline.segments[0]!.visuals[1]!.assetVersionRef = 'sound-v2';
          const receipt = await f.projects.save(changed, 'change');
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
                    : { assetVersionRef: 'sound-v2', ownerRevision: receipt.ownerRevision },
              },
            }),
            { code: 'invalid_action' },
          );
        } finally {
          await f.cleanup();
        }
      });

for (const branch of ['receipt', 'asset'] as const)
  for (const boxed of [false, true])
    test(`F326 audio cannot masquerade as addressed artwork (${branch}, region=${boxed})`, async () => {
      const f = await fixture();
      try {
        const base = f.projects.snapshots.get(1)!;
        base.assets[0]!.kind = 'audio';
        base.assets[0]!.versions[0]!.mediaType = 'audio/wav';
        const reviews = f.service();
        const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
        const marked = await reviews.annotate({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: 1,
          operationId: 'mark',
          body: 'Change artwork',
          target: {
            kind: 'artwork',
            assetVersionRef: 'image-v1',
            visualUseId: 'visual-1',
            ...(boxed ? { region: { ...region, width: 640, height: 480 } } : {}),
          },
        });
        const changed = (await f.projects.load({ principal, contentRef })).document;
        changed.assets[0]!.versions.push({
          ...changed.assets[0]!.versions[0]!,
          id: 'voice-v2',
          sha256: `sha256:${'b'.repeat(64)}`,
        });
        changed.timeline.segments[0]!.visuals[0]!.assetVersionRef = 'voice-v2';
        const receipt = await f.projects.save(changed, 'voice');
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
                branch === 'receipt' ? receipt : { assetVersionRef: 'voice-v2', ownerRevision: receipt.ownerRevision },
            },
          }),
          { code: 'invalid_action' },
        );
      } finally {
        await f.cleanup();
      }
    });

for (const mediaType of ['image/png', 'Image/PNG', 'video/mp4'])
  test(`F326 ${mediaType} remains eligible as spatial material`, async () => {
    const f = await fixture();
    try {
      f.projects.snapshots.get(1)!.assets[0]!.versions[0]!.mediaType = mediaType;
      const reviews = f.service();
      const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
      const marked = await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: 1,
        operationId: 'mark',
        body: 'Change visual',
        target: {
          kind: 'moment',
          tick: 50,
          timebase: { numerator: 1, denominator: 30 },
          region,
        },
      });
      const changed = (await f.projects.load({ principal, contentRef })).document;
      changed.assets[0]!.versions.push({
        ...changed.assets[0]!.versions[0]!,
        id: 'spatial-v2',
        sha256: `sha256:${'b'.repeat(64)}`,
      });
      changed.timeline.segments[0]!.visuals[0]!.assetVersionRef = 'spatial-v2';
      const receipt = await f.projects.save(changed, 'visual');
      await reviews.act({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: marked.review.revision,
        operationId: 'address',
        action: { kind: 'addressed', annotationId: marked.review.annotations[0]!.id, result: receipt },
      });
    } finally {
      await f.cleanup();
    }
  });
