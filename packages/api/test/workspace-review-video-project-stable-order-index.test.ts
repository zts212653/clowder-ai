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

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'f326-real-stable-visual-segment-'));
  const store = new ArtifactReviewStore(join(root, 'artifact-reviews.sqlite'));
  const assets = new VideoProjectAssetIndex({ resolveRoot: async (rootId) => ({ root, canonicalWorktreeId: rootId }) });
  const doc = structuredClone(projectDocumentFixture);
  const versions = [];
  for (const letter of ['a', 'b']) {
    await writeFile(join(root, `${letter}.png`), Buffer.from(`encoded-artwork-${letter}`));
    const observed = await assets.inspect({ kind: 'workspace', rootId: 'test-root', path: `${letter}.png` });
    versions.push({
      id: `image-${letter}`,
      mediaType: 'image/png',
      ...observed,
      recordedAt: doc.origin.at,
      origin: doc.origin,
    });
  }
  doc.assets.push({ id: 'art', name: 'Artwork', kind: 'image', versions });
  doc.timeline.durationTicks = 360;
  doc.timeline.segments = ['before', 'target', 'after'].map((id, index) => ({
    id: `shot-${id}`,
    kind: 'shot',
    sceneId: 's1',
    label: id,
    startTick: index * 120,
    durationTicks: 100,
    visuals: [
      { id: `overlay-before-${id}`, generated: { kind: 'overlay', value: 'before' }, startTick: 0, endTick: 100 },
      { id: `visual-${id}`, assetVersionRef: 'image-a', startTick: 0, endTick: 100 },
      { id: `overlay-after-${id}`, generated: { kind: 'overlay', value: 'after' }, startTick: 0, endTick: 100 },
    ],
  }));
  const owner = new ProjectContentOwnerService({ dataDir: join(root, 'owner') });
  const projects = new VideoProjectService({ owner, ownerUserId: principal.userId, assets });
  const created = await projects.create({ principal, operationId: 'create', document: doc });
  const reviews = new VideoProjectReviewService({ store: store.ledgers, projects });
  return {
    projects,
    reviews,
    contentRef: created.contentRef,
    async cleanup() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const targets = [
  { kind: 'project' },
  { kind: 'segment', segmentId: 'shot-target' },
  { kind: 'artwork', assetVersionRef: 'image-a', visualUseId: 'visual-target' },
] as const;
for (const object of ['segment', 'visual'] as const)
  for (const operation of ['insert-before', 'insert-after', 'move-before', 'move-after'] as const)
    for (const target of targets)
      for (const branch of ['receipt', 'asset'] as const)
        test(`real stable ${object} ${operation} + own bytes ${target.kind} ${branch}`, async () => {
          const f = await setup();
          try {
            const opened = await f.reviews.prepare({ principal, contentRef: f.contentRef, operationId: 'prepare' });
            const marked = await f.reviews.annotate({
              principal,
              reviewId: opened.review.reviewId,
              expectedRevision: 1,
              operationId: 'mark',
              body: 'Replace targeted drawing',
              target,
            });
            const changed = (await f.projects.load({ principal, contentRef: f.contentRef })).document;
            const shot = changed.timeline.segments.find((s) => s.id === 'shot-target')!;
            const visual = shot.visuals.find((v) => v.id === 'visual-target')!;
            visual.assetVersionRef = 'image-b';
            if (object === 'visual') {
              if (operation === 'insert-before' || operation === 'insert-after') {
                shot.visuals.splice(operation === 'insert-before' ? 1 : 2, 0, {
                  id: 'new-overlay',
                  generated: { kind: 'overlay', value: 'new' },
                  startTick: 0,
                  endTick: 100,
                });
              } else {
                shot.visuals =
                  operation === 'move-before'
                    ? [visual, shot.visuals[0]!, shot.visuals[2]!]
                    : [shot.visuals[0]!, shot.visuals[2]!, visual];
              }
            } else if (operation === 'insert-before' || operation === 'insert-after') {
              changed.timeline.segments.push({
                id: 'new-shot',
                kind: 'shot',
                sceneId: 's1',
                label: 'new',
                startTick: operation === 'insert-before' ? 100 : 220,
                durationTicks: 20,
                visuals: [],
              });
              changed.timeline.segments.sort((a, b) => a.startTick - b.startTick);
            } else {
              const peer = changed.timeline.segments.find(
                (s) => s.id === (operation === 'move-before' ? 'shot-before' : 'shot-after'),
              )!;
              [shot.startTick, peer.startTick] = [peer.startTick, shot.startTick];
              changed.timeline.segments.sort((a, b) => a.startTick - b.startTick);
            }
            const receipt = await f.projects.save({
              principal,
              contentRef: f.contentRef,
              expectedOwnerRevision: 1,
              operationId: `${object}-${operation}`,
              document: changed,
            });
            const result =
              branch === 'receipt'
                ? {
                    contentRef: receipt.contentRef,
                    ownerRevision: receipt.ownerRevision,
                    blobDigest: receipt.blobDigest,
                    operationId: receipt.operationId,
                  }
                : { assetVersionRef: 'image-b', ownerRevision: receipt.ownerRevision };
            await assert.doesNotReject(
              f.reviews.act({
                principal,
                reviewId: opened.review.reviewId,
                expectedRevision: marked.review.revision,
                operationId: 'address',
                action: { kind: 'addressed', annotationId: marked.review.annotations[0]!.id, result },
              }),
            );
          } finally {
            await f.cleanup();
          }
        });
