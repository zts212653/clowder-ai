import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ArtifactReviewStore } from '../src//domains/collaborative-content/artifact-review/store.js';
import { VideoProjectReviewService } from '../src//domains/collaborative-content/workspace-review/video-project-review-service.js';
import { ProjectContentOwnerService } from '../src//domains/video-studio/content-owner/service.js';
import { VideoProjectAssetIndex } from '../src//domains/video-studio/project/asset-index.js';
import { VideoProjectService } from '../src//domains/video-studio/project/service.js';
import { projectHumanFixture as principal, projectDocumentFixture } from './helpers/video-project-fixture.js';

async function indexedVersion(
  root: string,
  assets: VideoProjectAssetIndex,
  document: typeof projectDocumentFixture,
  letter: string,
) {
  await writeFile(join(root, `${letter}.png`), Buffer.from(`encoded-artwork-${letter}`));
  const observed = await assets.inspect({ kind: 'workspace', rootId: 'test-root', path: `${letter}.png` });
  return {
    id: `image-${letter}`,
    mediaType: 'image/png',
    ...observed,
    recordedAt: document.origin.at,
    origin: document.origin,
  };
}

async function setupSegmentSwap() {
  const root = await mkdtemp(join(tmpdir(), 'f326-real-segment-swap-change-'));
  const store = new ArtifactReviewStore(join(root, 'artifact-reviews.sqlite'));
  const assets = new VideoProjectAssetIndex({ resolveRoot: async (rootId) => ({ root, canonicalWorktreeId: rootId }) });
  const document = structuredClone(projectDocumentFixture);
  const a = await indexedVersion(root, assets, document, 'a');
  const c = await indexedVersion(root, assets, document, 'c');
  document.assets.push({ id: 'art', name: 'Artwork', kind: 'image', versions: [a, c] });
  document.timeline.durationTicks = 200;
  document.timeline.segments = [
    {
      id: 'shot-1',
      kind: 'shot',
      sceneId: 's1',
      label: 'One',
      startTick: 0,
      durationTicks: 100,
      visuals: [{ id: 'visual-1', assetVersionRef: 'image-a', startTick: 0, endTick: 100 }],
    },
    {
      id: 'shot-2',
      kind: 'shot',
      sceneId: 's1',
      label: 'Two',
      startTick: 100,
      durationTicks: 100,
      visuals: [{ id: 'visual-2', assetVersionRef: 'image-c', startTick: 0, endTick: 100 }],
    },
  ];
  const owner = new ProjectContentOwnerService({ dataDir: join(root, 'owner') });
  const projects = new VideoProjectService({ owner, ownerUserId: principal.userId, assets });
  const created = await projects.create({ principal, operationId: 'create', document });
  const reviews = new VideoProjectReviewService({ store: store.ledgers, projects });
  return { root, store, assets, projects, reviews, contentRef: created.contentRef };
}

async function setupArtworkReplacement(sameInterval: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'f326-real-artwork-net-footprint-'));
  const store = new ArtifactReviewStore(join(root, 'artifact-reviews.sqlite'));
  const assets = new VideoProjectAssetIndex({ resolveRoot: async (rootId) => ({ root, canonicalWorktreeId: rootId }) });
  const document = structuredClone(projectDocumentFixture);
  const a = await indexedVersion(root, assets, document, 'a');
  const b = await indexedVersion(root, assets, document, 'b');
  document.assets.push({ id: 'art', name: 'Artwork', kind: 'image', versions: [a, b] });
  document.timeline.segments[0]!.visuals = [
    { id: 'visual-a', assetVersionRef: 'image-a', startTick: 0, endTick: 60 },
    { id: 'visual-b', assetVersionRef: 'image-b', startTick: sameInterval ? 0 : 60, endTick: sameInterval ? 60 : 120 },
  ];
  const owner = new ProjectContentOwnerService({ dataDir: join(root, 'owner') });
  const projects = new VideoProjectService({ owner, ownerUserId: principal.userId, assets });
  const created = await projects.create({ principal, operationId: 'create', document });
  const reviews = new VideoProjectReviewService({ store: store.ledgers, projects });
  return { root, store, projects, reviews, contentRef: created.contentRef };
}

function resultFor(
  branch: 'receipt' | 'asset',
  receipt: Awaited<ReturnType<VideoProjectService['save']>>,
  assetVersionRef: string,
) {
  return branch === 'receipt'
    ? {
        contentRef: receipt.contentRef,
        ownerRevision: receipt.ownerRevision,
        blobDigest: receipt.blobDigest,
        operationId: receipt.operationId,
      }
    : { assetVersionRef, ownerRevision: receipt.ownerRevision };
}

for (const branch of ['receipt', 'asset'] as const)
  test(`real segment ID reassignment cannot borrow the other shot's real new bytes (${branch})`, async () => {
    const f = await setupSegmentSwap();
    try {
      const opened = await f.reviews.prepare({ principal, contentRef: f.contentRef, operationId: 'prepare' });
      const marked = await f.reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: opened.review.revision,
        operationId: 'mark',
        body: 'Fix shot one',
        target: { kind: 'segment', segmentId: 'shot-1' },
      });
      const changed = (await f.projects.load({ principal, contentRef: f.contentRef })).document;
      const d = await indexedVersion(f.root, f.assets, changed, 'd');
      changed.assets[0]!.versions.push(d);
      changed.timeline.segments[0]!.id = 'shot-2';
      changed.timeline.segments[1]!.id = 'shot-1';
      changed.timeline.segments[1]!.visuals[0]!.assetVersionRef = 'image-d';
      const receipt = await f.projects.save({
        principal,
        contentRef: f.contentRef,
        expectedOwnerRevision: 1,
        operationId: 'swap-plus-other-change',
        document: changed,
      });
      await assert.rejects(
        f.reviews.act({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: marked.review.revision,
          operationId: 'address',
          action: {
            kind: 'addressed',
            annotationId: marked.review.annotations[0]!.id,
            result: resultFor(branch, receipt, 'image-d'),
          },
        }),
        { code: 'invalid_action' },
      );
    } finally {
      f.store.close();
      await rm(f.root, { recursive: true, force: true });
    }
  });

for (const sameInterval of [true, false])
  for (const removeSibling of [true, false])
    for (const hinted of [true, false])
      for (const branch of ['receipt', 'asset'] as const)
        test(`real stable artwork replacement with a new frozen B version handles sibling=${removeSibling ? 'removed' : 'retained'} interval=${sameInterval ? 'same' : 'different'} hint=${hinted} (${branch})`, async () => {
          const f = await setupArtworkReplacement(sameInterval);
          try {
            const opened = await f.reviews.prepare({ principal, contentRef: f.contentRef, operationId: 'prepare' });
            const marked = await f.reviews.annotate({
              principal,
              reviewId: opened.review.reviewId,
              expectedRevision: opened.review.revision,
              operationId: 'mark',
              body: 'Replace artwork A',
              target: { kind: 'artwork', assetVersionRef: 'image-a', ...(hinted ? { visualUseId: 'visual-a' } : {}) },
            });
            const changed = (await f.projects.load({ principal, contentRef: f.contentRef })).document;
            changed.assets[0]!.versions.push({ ...changed.assets[0]!.versions[1]!, id: 'image-b-v2' });
            changed.timeline.segments[0]!.visuals[0]!.assetVersionRef = 'image-b-v2';
            if (removeSibling) changed.timeline.segments[0]!.visuals.splice(1, 1);
            const receipt = await f.projects.save({
              principal,
              contentRef: f.contentRef,
              expectedOwnerRevision: 1,
              operationId: 'replace-and-remove-duplicate',
              document: changed,
            });
            await assert.doesNotReject(
              f.reviews.act({
                principal,
                reviewId: opened.review.reviewId,
                expectedRevision: marked.review.revision,
                operationId: 'address',
                action: {
                  kind: 'addressed',
                  annotationId: marked.review.annotations[0]!.id,
                  result: resultFor(branch, receipt, 'image-b-v2'),
                },
              }),
            );
          } finally {
            f.store.close();
            await rm(f.root, { recursive: true, force: true });
          }
        });
