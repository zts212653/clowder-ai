import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentRef, fixture, principal, region } from './workspace-review-video-project.fixture.js';

const targets = [
  { kind: 'project' },
  { kind: 'segment', segmentId: 'shot-1' },
  { kind: 'moment', tick: 50, timebase: { numerator: 1, denominator: 30 } },
  { kind: 'moment', tick: 50, timebase: { numerator: 1, denominator: 30 }, visualUseId: 'visual-1' },
  { kind: 'moment', tick: 50, timebase: { numerator: 1, denominator: 30 }, visualUseId: 'visual-1', region },
] as const;

for (const [index, target] of targets.entries())
  test(`existing-key swap cannot name equivalent image after unrelated text change ${index} ${target.kind}`, async () => {
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
      before.timeline.segments[0]!.visuals.push({
        id: 'visual-third',
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
      changed.assets[0]!.versions.push({ ...first, id: 'equivalent-v2' });
      changed.assets[0]!.versions.push({ ...first, id: 'actually-changed-v2', sha256: `sha256:${'b'.repeat(64)}` });
      changed.timeline.segments[0]!.visuals[0]!.id = 'visual-sibling';
      changed.timeline.segments[0]!.visuals[0]!.assetVersionRef = 'equivalent-v2';
      changed.timeline.segments[0]!.visuals[1]!.id = 'visual-1';
      changed.timeline.segments[0]!.visuals[2]!.assetVersionRef = 'actually-changed-v2';
      const receipt = await f.projects.save(changed, 'swap-plus-real');
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

for (const [index, target] of targets.entries())
  test(`event rename cannot name equivalent audio after unrelated picture change ${index} ${target.kind}`, async () => {
    const f = await fixture();
    try {
      const before = f.projects.snapshots.get(1)!;
      const first = before.assets[0]!.versions[0]!;
      before.assets.push({
        id: 'audio',
        name: 'Dialogue',
        kind: 'audio',
        versions: [
          {
            ...first,
            id: 'audio-v1',
            mediaType: 'audio/mpeg',
            sha256: `sha256:${'c'.repeat(64)}`,
            locator: { kind: 'workspace', rootId: 'registered-root', path: 'one.mp3' },
          },
        ],
      });
      before.timeline.events.push({
        id: 'audio-event',
        kind: 'audio',
        startTick: 0,
        durationTicks: 100,
        assetVersionRef: 'audio-v1',
      });
      const reviews = f.service();
      const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
      const marked = await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: 1,
        operationId: 'mark',
        body: 'Replace dialogue',
        target,
      });
      const changed = (await f.projects.load({ principal, contentRef })).document;
      changed.assets[1]!.versions.push({ ...changed.assets[1]!.versions[0]!, id: 'equivalent-audio-v2' });
      changed.assets[0]!.versions.push({ ...first, id: 'actually-changed-v2', sha256: `sha256:${'b'.repeat(64)}` });
      changed.timeline.segments[0]!.visuals[0]!.assetVersionRef = 'actually-changed-v2';
      changed.timeline.events[0]!.id = 'renamed-audio-event';
      changed.timeline.events[0]!.assetVersionRef = 'equivalent-audio-v2';
      const receipt = await f.projects.save(changed, 'event-plus-real');
      await assert.rejects(
        reviews.act({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: marked.review.revision,
          operationId: 'address',
          action: {
            kind: 'addressed',
            annotationId: marked.review.annotations[0]!.id,
            result: { assetVersionRef: 'equivalent-audio-v2', ownerRevision: receipt.ownerRevision },
          },
        }),
        { code: 'invalid_action' },
      );
    } finally {
      await f.cleanup();
    }
  });
