import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VideoProjectDocumentV1, VideoProjectReviewTarget } from '@cat-cafe/shared';
import { at, contentRef, fixture, principal, region } from './workspace-review-video-project.fixture.js';

type EventKind = VideoProjectDocumentV1['timeline']['events'][number]['kind'];
const timebase = { numerator: 1, denominator: 30 };

for (const kind of ['audio', 'dialogue', 'subtitle', 'marker'] as EventKind[])
  for (const withHint of [false, true])
    for (const resultKind of ['receipt', 'asset'] as const)
      test(`F326 boxed ${kind} voice/material changes are nonspatial (${resultKind}, visual hint=${withHint})`, async () => {
        const f = await fixture();
        try {
          const base = f.projects.snapshots.get(1)!;
          base.assets.push({
            id: 'voice',
            name: 'Voice',
            kind: 'audio',
            versions: [
              {
                id: 'voice-v1',
                mediaType: 'audio/wav',
                byteLength: 10,
                sha256: `sha256:${'c'.repeat(64)}`,
                locator: { kind: 'workspace', rootId: 'registered-root', path: 'voice.wav' },
                recordedAt: at,
                origin: base.origin,
              },
            ],
          });
          base.timeline.events.push({
            id: 'event',
            kind,
            startTick: 50,
            durationTicks: 10,
            text: 'Existing caption or label',
            speaker: 'Existing speaker',
            assetVersionRef: 'voice-v1',
          });
          const reviews = f.service();
          const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
          const marked = await reviews.annotate({
            principal,
            reviewId: opened.review.reviewId,
            expectedRevision: 1,
            operationId: 'mark',
            body: 'Change this frame region',
            target: { kind: 'moment', tick: 50, timebase, region, ...(withHint ? { visualUseId: 'visual-1' } : {}) },
          });
          const changed = (await f.projects.load({ principal, contentRef })).document;
          changed.assets[1]!.versions.push({
            ...changed.assets[1]!.versions[0]!,
            id: 'voice-v2',
            sha256: `sha256:${'d'.repeat(64)}`,
          });
          changed.timeline.events[0]!.assetVersionRef = 'voice-v2';
          const receipt = await f.projects.save(changed, 'voice-only');
          const result =
            resultKind === 'receipt' ? receipt : { assetVersionRef: 'voice-v2', ownerRevision: receipt.ownerRevision };
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

for (const withRegion of [false, true])
  for (const withHint of [false, true])
    for (const resultKind of ['receipt', 'asset'] as const)
      test(`F326 actual visual changes remain provable (region=${withRegion}, hint=${withHint}, ${resultKind})`, async () => {
        const f = await fixture();
        try {
          const reviews = f.service();
          const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
          const target: VideoProjectReviewTarget = {
            kind: 'moment',
            tick: 50,
            timebase,
            ...(withRegion ? { region } : {}),
            ...(withHint ? { visualUseId: 'visual-1' } : {}),
          };
          const marked = await reviews.annotate({
            principal,
            reviewId: opened.review.reviewId,
            expectedRevision: 1,
            operationId: 'mark',
            body: 'Change the visible drawing',
            target,
          });
          const changed = (await f.projects.load({ principal, contentRef })).document;
          changed.assets[0]!.versions.push({
            ...changed.assets[0]!.versions[0]!,
            id: 'image-v2',
            sha256: `sha256:${'b'.repeat(64)}`,
          });
          changed.timeline.segments[0]!.visuals[0]!.assetVersionRef = 'image-v2';
          const receipt = await f.projects.save(changed, 'change-drawing');
          const result =
            resultKind === 'receipt' ? receipt : { assetVersionRef: 'image-v2', ownerRevision: receipt.ownerRevision };
          await reviews.act({
            principal,
            reviewId: opened.review.reviewId,
            expectedRevision: marked.review.revision,
            operationId: 'address',
            action: {
              kind: 'addressed',
              annotationId: marked.review.annotations[0]!.id,
              result,
            },
          });
        } finally {
          await f.cleanup();
        }
      });

const textCases: [EventKind, boolean][] = [
  ['audio', true],
  ['marker', true],
  ['subtitle', true],
  ['dialogue', true],
  ['subtitle', false],
  ['dialogue', false],
];
for (const [kind, withRegion] of textCases)
  test(`F326 ${kind} text needs spatial placement for a region (region=${withRegion})`, async () => {
    const f = await fixture();
    try {
      f.projects.snapshots
        .get(1)!
        .timeline.events.push({ id: 'event', kind, startTick: 50, durationTicks: 10, text: 'Before' });
      const reviews = f.service();
      const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
      const marked = await reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: 1,
        operationId: 'mark',
        body: 'Fix the visible caption',
        target: { kind: 'moment', tick: 50, timebase, ...(withRegion ? { region } : {}), visualUseId: 'visual-1' },
      });
      const changed = (await f.projects.load({ principal, contentRef })).document;
      changed.timeline.events[0]!.text = 'After';
      const result = await f.projects.save(changed, 'change-text');
      const action = reviews.act({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: marked.review.revision,
        operationId: 'address',
        action: {
          kind: 'addressed',
          annotationId: marked.review.annotations[0]!.id,
          result,
        },
      });
      if (!withRegion) await action;
      else await assert.rejects(action, { code: 'invalid_action' });
    } finally {
      await f.cleanup();
    }
  });

test('F326 an unused audio result cannot borrow a simultaneous visual change for a region', async () => {
  const f = await fixture();
  try {
    const reviews = f.service();
    const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
    const marked = await reviews.annotate({
      principal,
      reviewId: opened.review.reviewId,
      expectedRevision: 1,
      operationId: 'mark',
      body: 'Change the visible drawing',
      target: { kind: 'moment', tick: 50, timebase, region },
    });
    const changed = (await f.projects.load({ principal, contentRef })).document;
    changed.assets[0]!.versions.push({
      ...changed.assets[0]!.versions[0]!,
      id: 'image-v2',
      sha256: `sha256:${'b'.repeat(64)}`,
    });
    changed.timeline.segments[0]!.visuals[0]!.assetVersionRef = 'image-v2';
    changed.assets.push({
      id: 'voice',
      name: 'Voice',
      kind: 'audio',
      versions: [
        {
          id: 'voice-v2',
          mediaType: 'audio/wav',
          byteLength: 10,
          sha256: `sha256:${'d'.repeat(64)}`,
          locator: { kind: 'workspace', rootId: 'registered-root', path: 'voice.wav' },
          recordedAt: at,
          origin: changed.origin,
        },
      ],
    });
    changed.timeline.events.push({ id: 'event', kind: 'audio', startTick: 50, assetVersionRef: 'voice-v2' });
    const receipt = await f.projects.save(changed, 'change-both');
    await assert.rejects(
      reviews.act({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: marked.review.revision,
        operationId: 'audio-result',
        action: {
          kind: 'addressed',
          annotationId: marked.review.annotations[0]!.id,
          result: { assetVersionRef: 'voice-v2', ownerRevision: receipt.ownerRevision },
        },
      }),
      { code: 'invalid_action' },
    );
    await reviews.act({
      principal,
      reviewId: opened.review.reviewId,
      expectedRevision: marked.review.revision,
      operationId: 'real-visual-result',
      action: { kind: 'addressed', annotationId: marked.review.annotations[0]!.id, result: receipt },
    });
    assert.deepEqual(
      (await f.reopen().read({ principal, reviewId: opened.review.reviewId })).review.annotations[0]!.anchor,
      marked.review.annotations[0]!.anchor,
    );
  } finally {
    await f.cleanup();
  }
});
