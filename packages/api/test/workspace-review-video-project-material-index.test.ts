import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { VideoProjectReviewService } from '../src/domains/collaborative-content/workspace-review/video-project-review-service.js';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { VideoProjectAssetIndex } from '../src/domains/video-studio/project/asset-index.js';
import { VideoProjectService } from '../src/domains/video-studio/project/service.js';
import { projectHumanFixture as principal, projectDocumentFixture } from './helpers/video-project-fixture.js';

for (const metadata of ['mime-case', 'image-duration'] as const)
  for (const resultKind of ['receipt', 'asset'] as const)
    test(`real F138/F063 path rejects ${metadata}-only spatial proof (${resultKind})`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'f326-real-mime-proof-'));
      const store = new ArtifactReviewStore(join(root, 'artifact-reviews.sqlite'));
      try {
        const file = join(root, 'same.png');
        await writeFile(file, Buffer.from('same-rendered-bytes'));
        const assets = new VideoProjectAssetIndex({
          resolveRoot: async (rootId) => ({ root, canonicalWorktreeId: rootId }),
        });
        const observed = await assets.inspect({ kind: 'workspace', rootId: 'test-root', path: 'same.png' });
        const document = structuredClone(projectDocumentFixture);
        document.assets.push({
          id: 'art',
          name: 'Artwork',
          kind: 'image',
          versions: [
            {
              id: 'image-v1',
              mediaType: 'image/png',
              ...observed,
              recordedAt: document.origin.at,
              origin: document.origin,
            },
          ],
        });
        document.timeline.segments[0]!.visuals.push({
          id: 'visual-1',
          assetVersionRef: 'image-v1',
          startTick: 0,
          endTick: 120,
        });
        const owner = new ProjectContentOwnerService({ dataDir: join(root, 'owner') });
        const projects = new VideoProjectService({ owner, ownerUserId: principal.userId, assets });
        const created = await projects.create({ principal, operationId: 'create', document });
        const reviews = new VideoProjectReviewService({ store: store.ledgers, projects });
        const opened = await reviews.prepare({ principal, contentRef: created.contentRef, operationId: 'prepare' });
        const marked = await reviews.annotate({
          principal,
          reviewId: opened.review.reviewId,
          expectedRevision: opened.review.revision,
          operationId: 'mark',
          body: 'Fix these pixels',
          target: {
            kind: 'moment',
            tick: 50,
            timebase: { numerator: 1, denominator: 30 },
            visualUseId: 'visual-1',
            region: {
              coordinateSpace: 'display-pixels',
              width: 1920,
              height: 1080,
              rotation: 0,
              bbox: { x: 0, y: 0, width: 10, height: 10 },
            },
          },
        });
        const changed = (await projects.load({ principal, contentRef: created.contentRef })).document;
        changed.assets[0]!.versions.push({
          ...changed.assets[0]!.versions[0]!,
          id: 'image-v2',
          ...(metadata === 'mime-case' ? { mediaType: 'Image/PNG' } : { durationTicks: 999 }),
        });
        changed.timeline.segments[0]!.visuals[0]!.assetVersionRef = 'image-v2';
        const receipt = await projects.save({
          principal,
          contentRef: created.contentRef,
          expectedOwnerRevision: 1,
          operationId: 'case-only',
          document: changed,
        });
        const result =
          resultKind === 'receipt'
            ? {
                contentRef: receipt.contentRef,
                ownerRevision: receipt.ownerRevision,
                blobDigest: receipt.blobDigest,
                operationId: receipt.operationId,
              }
            : { assetVersionRef: 'image-v2', ownerRevision: receipt.ownerRevision };
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
