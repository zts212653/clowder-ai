import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { VideoProjectDocumentV1, VideoProjectReviewTarget } from '@cat-cafe/shared';
import { contentRef, fixture, principal, region } from './workspace-review-video-project.fixture.js';

type Version = VideoProjectDocumentV1['assets'][number]['versions'][number];
const targets: VideoProjectReviewTarget[] = [
  { kind: 'project' },
  { kind: 'segment', segmentId: 'shot-1' },
  { kind: 'moment', tick: 50, timebase: { numerator: 1, denominator: 30 }, visualUseId: 'visual-1' },
  { kind: 'moment', tick: 50, timebase: { numerator: 1, denominator: 30 }, visualUseId: 'visual-1', region },
  { kind: 'artwork', assetVersionRef: 'image-v1', visualUseId: 'visual-1' },
];
const bookkeeping: Record<string, Partial<Version>> = {
  'MIME case': { mediaType: 'Image/PNG' },
  'MIME whitespace': { mediaType: '  image/png  ' },
  'undeclared MIME parameters': { mediaType: 'image/png; unrelated=note' },
  'static duration': { durationTicks: 999 },
  'intrinsic dimensions': { width: 320, height: 240 },
  'length descriptor': { byteLength: 99 },
};

for (const [metadata, patch] of Object.entries(bookkeeping))
  for (const [targetIndex, target] of targets.entries())
    for (const branch of ['receipt', 'asset'] as const)
      test(`F326 ${target.kind}${'region' in target ? ':region' : ''} rejects ${metadata} as render change (${branch})`, async () => {
        const f = await fixture();
        try {
          const reviews = f.service();
          const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
          const marked = await reviews.annotate({
            principal,
            reviewId: opened.review.reviewId,
            expectedRevision: 1,
            operationId: 'mark',
            body: 'Change this content',
            target,
          });
          const changed = (await f.projects.load({ principal, contentRef })).document;
          changed.assets[0]!.versions.push({ ...changed.assets[0]!.versions[0]!, ...patch, id: 'equivalent-v2' });
          changed.timeline.segments[0]!.visuals[0]!.assetVersionRef = 'equivalent-v2';
          const receipt = await f.projects.save(changed, `save-${targetIndex}`);
          const result =
            branch === 'receipt' ? receipt : { assetVersionRef: 'equivalent-v2', ownerRevision: receipt.ownerRevision };
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

for (const effect of ['bytes', 'orientation'] as const)
  for (const target of targets)
    for (const branch of ['receipt', 'asset'] as const)
      test(`F326 ${target.kind} preserves real ${effect} proof despite equivalent descriptors (${branch})`, async () => {
        const f = await fixture();
        try {
          const reviews = f.service();
          const opened = await reviews.prepare({ principal, contentRef, operationId: 'prepare' });
          const marked = await reviews.annotate({
            principal,
            reviewId: opened.review.reviewId,
            expectedRevision: 1,
            operationId: 'mark',
            body: 'Change this content',
            target,
          });
          const changed = (await f.projects.load({ principal, contentRef })).document;
          changed.assets[0]!.versions.push({
            ...changed.assets[0]!.versions[0]!,
            id: 'changed-v2',
            mediaType: 'Image/PNG; metadata=only',
            durationTicks: 999,
            ...(effect === 'bytes' ? { sha256: `sha256:${'b'.repeat(64)}` as const } : { rotation: 90 as const }),
          });
          changed.timeline.segments[0]!.visuals[0]!.assetVersionRef = 'changed-v2';
          const receipt = await f.projects.save(changed, 'real-change');
          await reviews.act({
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
        } finally {
          await f.cleanup();
        }
      });
