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

async function setup(twoSegments: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'f326-real-stable-remap-'));
  await writeFile(join(root, 'a.png'), Buffer.from('encoded-artwork-a'));
  await writeFile(join(root, 'b.png'), Buffer.from('encoded-artwork-b'));
  const assets = new VideoProjectAssetIndex({
    resolveRoot: async (rootId) => ({ root, canonicalWorktreeId: rootId }),
  });
  const a = await assets.inspect({ kind: 'workspace', rootId: 'test-root', path: 'a.png' });
  const document = structuredClone(projectDocumentFixture);
  document.timeline.durationTicks = twoSegments ? 200 : 120;
  document.assets.push({
    id: 'art',
    name: 'Artwork',
    kind: 'image',
    versions: [
      {
        id: 'image-a-v1',
        mediaType: 'image/png',
        ...a,
        recordedAt: document.origin.at,
        origin: document.origin,
      },
    ],
  });
  document.timeline.segments[0]!.id = 'shot-1';
  document.timeline.segments[0]!.durationTicks = twoSegments ? 100 : 120;
  document.timeline.segments[0]!.visuals.push({
    id: 'visual-1',
    assetVersionRef: 'image-a-v1',
    startTick: 0,
    endTick: twoSegments ? 100 : 120,
  });
  if (twoSegments)
    document.timeline.segments.push({
      id: 'shot-2',
      kind: 'shot',
      sceneId: 's1',
      label: 'Second',
      startTick: 100,
      durationTicks: 100,
      visuals: [{ id: 'visual-2', assetVersionRef: 'image-a-v1', startTick: 0, endTick: 100 }],
    });
  const owner = new ProjectContentOwnerService({ dataDir: join(root, 'owner') });
  const projects = new VideoProjectService({ owner, ownerUserId: principal.userId, assets });
  const created = await projects.create({ principal, operationId: 'create', document });
  const store = new ArtifactReviewStore(join(root, 'artifact-reviews.sqlite'));
  const reviews = new VideoProjectReviewService({ store: store.ledgers, projects });
  const b = await assets.inspect({ kind: 'workspace', rootId: 'test-root', path: 'b.png' });
  return {
    root,
    store,
    projects,
    reviews,
    contentRef: created.contentRef,
    b,
    async cleanup() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
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
  test(`real F138 stable segment follows a genuine reorder (${branch})`, async () => {
    const f = await setup(true);
    try {
      const opened = await f.reviews.prepare({ principal, contentRef: f.contentRef, operationId: 'prepare' });
      const marked = await f.reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: opened.review.revision,
        operationId: 'mark',
        body: 'Replace shot one artwork',
        target: { kind: 'segment', segmentId: 'shot-1' },
      });
      const changed = (await f.projects.load({ principal, contentRef: f.contentRef })).document;
      changed.assets[0]!.versions.push({
        id: 'image-b-v2',
        mediaType: 'image/png',
        ...f.b,
        recordedAt: changed.origin.at,
        origin: changed.origin,
      });
      const shotOne = changed.timeline.segments[0]!;
      const shotTwo = changed.timeline.segments[1]!;
      shotTwo.startTick = 0;
      shotOne.startTick = 100;
      shotOne.visuals[0]!.assetVersionRef = 'image-b-v2';
      changed.timeline.segments = [shotTwo, shotOne];
      const receipt = await f.projects.save({
        principal,
        contentRef: f.contentRef,
        expectedOwnerRevision: 1,
        operationId: 'reorder-and-replace',
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
      await f.cleanup();
    }
  });

for (const branch of ['receipt', 'asset'] as const)
  test(`real F138 stable visual-use follows insertion before the use (${branch})`, async () => {
    const f = await setup(false);
    try {
      const opened = await f.reviews.prepare({ principal, contentRef: f.contentRef, operationId: 'prepare' });
      const marked = await f.reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: opened.review.revision,
        operationId: 'mark',
        body: 'Replace this artwork',
        target: { kind: 'artwork', assetVersionRef: 'image-a-v1', visualUseId: 'visual-1' },
      });
      const changed = (await f.projects.load({ principal, contentRef: f.contentRef })).document;
      changed.assets[0]!.versions.push({
        id: 'image-b-v2',
        mediaType: 'image/png',
        ...f.b,
        recordedAt: changed.origin.at,
        origin: changed.origin,
      });
      changed.timeline.segments[0]!.visuals[0]!.assetVersionRef = 'image-b-v2';
      changed.timeline.segments[0]!.visuals.unshift({
        id: 'new-overlay',
        generated: { kind: 'overlay', value: 'new' },
        startTick: 0,
        endTick: 120,
      });
      const receipt = await f.projects.save({
        principal,
        contentRef: f.contentRef,
        expectedOwnerRevision: 1,
        operationId: 'insert-and-replace',
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
      await f.cleanup();
    }
  });
