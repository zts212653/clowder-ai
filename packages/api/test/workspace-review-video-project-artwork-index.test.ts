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

for (const hint of [false, true])
  for (const branch of ['receipt', 'asset'] as const)
    test(`real owner artwork ${hint ? 'hinted' : 'unhinted'} ${branch} rejects ID-swap-only proof`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'f326-real-artwork-swap-'));
      const store = new ArtifactReviewStore(join(root, 'artifact-reviews.sqlite'));
      try {
        await writeFile(join(root, 'a.png'), Buffer.from('encoded-artwork-a'));
        await writeFile(join(root, 'b.png'), Buffer.from('encoded-artwork-b'));
        const assets = new VideoProjectAssetIndex({
          resolveRoot: async (rootId) => ({ root, canonicalWorktreeId: rootId }),
        });
        const a = await assets.inspect({ kind: 'workspace', rootId: 'test-root', path: 'a.png' });
        const b = await assets.inspect({ kind: 'workspace', rootId: 'test-root', path: 'b.png' });
        const doc = structuredClone(projectDocumentFixture);
        doc.assets.push({
          id: 'art',
          name: 'Artwork',
          kind: 'image',
          versions: [
            { id: 'image-a-v1', mediaType: 'image/png', ...a, recordedAt: doc.origin.at, origin: doc.origin },
            { id: 'image-b-v1', mediaType: 'image/png', ...b, recordedAt: doc.origin.at, origin: doc.origin },
          ],
        });
        doc.timeline.segments[0]!.visuals.push(
          { id: 'visual-a', assetVersionRef: 'image-a-v1', startTick: 0, endTick: 120 },
          { id: 'visual-b', assetVersionRef: 'image-b-v1', startTick: 0, endTick: 120 },
        );
        const owner = new ProjectContentOwnerService({ dataDir: join(root, 'owner') });
        const projects = new VideoProjectService({ owner, ownerUserId: principal.userId, assets });
        const created = await projects.create({ principal, operationId: 'create', document: doc });
        const reviews = new VideoProjectReviewService({ store: store.ledgers, projects });
        const opened = await reviews.prepare({ principal, contentRef: created.contentRef, operationId: 'prepare' });
        const marked = await reviews.annotate({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: 1,
          operationId: 'mark',
          body: 'Replace artwork A',
          target: { kind: 'artwork', assetVersionRef: 'image-a-v1', ...(hint ? { visualUseId: 'visual-a' } : {}) },
        });
        const changed = (await projects.load({ principal, contentRef: created.contentRef })).document;
        changed.timeline.segments[0]!.visuals[0]!.id = 'visual-b';
        changed.timeline.segments[0]!.visuals[1]!.id = 'visual-a';
        const receipt = await projects.save({
          principal,
          contentRef: created.contentRef,
          expectedOwnerRevision: 1,
          operationId: 'swap-ids',
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
            : { assetVersionRef: 'image-b-v1', ownerRevision: receipt.ownerRevision };
        await assert.rejects(
          reviews.act({
            principal,
            reviewId: opened.review.reviewId,
            expectedRevision: marked.review.revision,
            operationId: 'address',
            action: { kind: 'addressed', annotationId: marked.review.annotations[0]!.id, result },
          }),
          { code: 'invalid_action' },
        );
      } finally {
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    });
