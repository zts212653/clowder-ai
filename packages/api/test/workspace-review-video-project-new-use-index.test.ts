import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { VideoProjectDocumentV1, VideoProjectReviewTarget } from '@cat-cafe/shared';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { VideoProjectReviewService } from '../src/domains/collaborative-content/workspace-review/video-project-review-service.js';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { VideoProjectAssetIndex } from '../src/domains/video-studio/project/asset-index.js';
import { VideoProjectService } from '../src/domains/video-studio/project/service.js';
import { projectHumanFixture as principal, projectDocumentFixture } from './helpers/video-project-fixture.js';

const targets: VideoProjectReviewTarget[] = [
  { kind: 'project' },
  { kind: 'segment', segmentId: 'C01' },
  { kind: 'moment', tick: 50, timebase: { numerator: 1, denominator: 30 } },
  {
    kind: 'moment',
    tick: 50,
    timebase: { numerator: 1, denominator: 30 },
    region: {
      coordinateSpace: 'display-pixels',
      width: 1920,
      height: 1080,
      rotation: 0,
      bbox: { x: 0, y: 0, width: 100, height: 100 },
    },
  },
];

async function setup(kind: 'visual' | 'audio') {
  const root = await mkdtemp(join(tmpdir(), 'f326-real-new-use-'));
  const store = new ArtifactReviewStore(join(root, 'artifact-reviews.sqlite'));
  const assets = new VideoProjectAssetIndex({ resolveRoot: async (rootId) => ({ root, canonicalWorktreeId: rootId }) });
  const document: VideoProjectDocumentV1 = structuredClone(projectDocumentFixture);
  const versions = [];
  for (const letter of ['a', 'b']) {
    const path = `${letter}.${kind === 'visual' ? 'png' : 'mp3'}`;
    await writeFile(join(root, path), Buffer.from(`encoded-material-${letter}`));
    const observed = await assets.inspect({ kind: 'workspace', rootId: 'test-root', path });
    versions.push({
      id: `${letter}-v1`,
      mediaType: kind === 'visual' ? 'image/png' : 'audio/mpeg',
      ...observed,
      recordedAt: document.origin.at,
      origin: document.origin,
    });
  }
  document.assets.push({ id: 'material', name: 'Material', kind: kind === 'visual' ? 'image' : 'audio', versions });
  document.timeline.durationTicks = 240;
  document.timeline.segments.push({
    id: 'C02',
    kind: 'shot',
    sceneId: 's1',
    label: 'Outside the marked shot',
    startTick: 120,
    durationTicks: 120,
    visuals: [],
  });
  addUse(document, kind, 'original', 'a-v1', 0, 100);
  const owner = new ProjectContentOwnerService({ dataDir: join(root, 'owner') });
  const projects = new VideoProjectService({ owner, ownerUserId: principal.userId, assets });
  const created = await projects.create({ principal, operationId: 'create', document });
  const reviews = new VideoProjectReviewService({ store: store.ledgers, projects });
  return { root, store, projects, reviews, contentRef: created.contentRef };
}

function addUse(
  document: VideoProjectDocumentV1,
  kind: 'visual' | 'audio',
  id: string,
  assetVersionRef: string,
  startTick: number,
  endTick: number,
) {
  if (kind === 'audio') {
    document.timeline.events.push({
      id,
      kind: 'audio',
      startTick,
      durationTicks: endTick - startTick,
      assetVersionRef,
    });
  } else {
    const segment = document.timeline.segments[startTick >= 120 ? 1 : 0];
    assert.ok(segment);
    segment.visuals.push({
      id,
      assetVersionRef,
      startTick: startTick - segment.startTick,
      endTick: endTick - segment.startTick,
    });
  }
}

async function assertEdit(
  kind: 'visual' | 'audio',
  target: VideoProjectReviewTarget,
  branch: 'receipt' | 'asset',
  startTick: number,
  endTick: number,
  rename: boolean,
) {
  const f = await setup(kind);
  try {
    const opened = await f.reviews.prepare({ principal, contentRef: f.contentRef, operationId: 'prepare' });
    const marked = await f.reviews.annotate({
      principal,
      reviewId: opened.review.reviewId,
      expectedRevision: opened.review.revision,
      operationId: 'mark',
      body: 'Add another layer',
      target,
    });
    const changed = (await f.projects.load({ principal, contentRef: f.contentRef })).document;
    const asset = changed.assets[0];
    assert.ok(asset);
    const originalVersion = asset.versions[0];
    assert.ok(originalVersion);
    asset.versions.push({ ...originalVersion, id: 'a-v2' });
    if (rename) {
      const segment = changed.timeline.segments[0];
      assert.ok(segment);
      if (kind === 'visual') segment.visuals = [];
      else changed.timeline.events = [];
      // A genuinely different sibling must not make the renamed A material a valid asset result.
      addUse(changed, kind, 'unrelated-change', 'b-v1', 0, 100);
    }
    addUse(changed, kind, 'new-use', 'a-v2', startTick, endTick);
    const receipt = await f.projects.save({
      principal,
      contentRef: f.contentRef,
      expectedOwnerRevision: 1,
      operationId: 'edit',
      document: changed,
    });
    const annotation = marked.review.annotations[0];
    assert.ok(annotation);
    const act = () =>
      f.reviews.act({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: marked.review.revision,
        operationId: 'address',
        action: {
          kind: 'addressed',
          annotationId: annotation.id,
          result:
            branch === 'asset'
              ? { assetVersionRef: 'a-v2', ownerRevision: receipt.ownerRevision }
              : {
                  contentRef: receipt.contentRef,
                  ownerRevision: receipt.ownerRevision,
                  blobDigest: receipt.blobDigest,
                  operationId: receipt.operationId,
                },
        },
      });
    const spatial = target.kind === 'moment' && target.region !== undefined;
    const inTarget = target.kind === 'project' || startTick < 120;
    if (!rename && inTarget && !(spatial && kind === 'audio')) await assert.doesNotReject(act);
    else await assert.rejects(act, { code: 'invalid_action' });
  } finally {
    f.store.close();
    await rm(f.root, { recursive: true, force: true });
  }
}

for (const kind of ['visual', 'audio'] as const)
  for (const [targetIndex, target] of targets.entries()) {
    for (const sameInterval of [true, false])
      for (const outside of [true, false])
        for (const branch of ['receipt', 'asset'] as const) {
          const startTick = (outside ? 120 : 0) + (sameInterval ? 0 : 20);
          const endTick = (outside ? 120 : 0) + (sameInterval ? 100 : 80);
          test(`real new ${kind} use existing material target=${targetIndex} same=${sameInterval} outside=${outside} ${branch}`, () =>
            assertEdit(kind, target, branch, startTick, endTick, false));
        }
    test(`real renamed ${kind} cannot borrow different sibling bytes target=${targetIndex}`, () =>
      assertEdit(kind, target, 'asset', 0, 100, true));
  }
