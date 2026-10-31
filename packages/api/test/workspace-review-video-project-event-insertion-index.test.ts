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

const targets = [
  { kind: 'project' },
  { kind: 'segment', segmentId: 'C01' },
  { kind: 'moment', tick: 50, timebase: { numerator: 1, denominator: 30 } },
] as const;

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'f326-real-event-position-'));
  const store = new ArtifactReviewStore(join(root, 'artifact-reviews.sqlite'));
  const assets = new VideoProjectAssetIndex({ resolveRoot: async (rootId) => ({ root, canonicalWorktreeId: rootId }) });
  const doc = structuredClone(projectDocumentFixture);
  const versions = [];
  for (const letter of ['a', 'b', 'c', 'd']) {
    await writeFile(join(root, `${letter}.mp3`), Buffer.from(`encoded-audio-${letter}`));
    const observed = await assets.inspect({ kind: 'workspace', rootId: 'test-root', path: `${letter}.mp3` });
    versions.push({
      id: `audio-${letter}-v1`,
      mediaType: 'audio/mpeg',
      ...observed,
      recordedAt: doc.origin.at,
      origin: doc.origin,
    });
  }
  doc.assets.push({ id: 'audio', name: 'Dialogue', kind: 'audio', versions });
  doc.timeline.events = ['b', 'a', 'c'].map((letter) => ({
    id: `event-${letter}`,
    kind: 'audio',
    startTick: 0,
    durationTicks: 100,
    assetVersionRef: `audio-${letter}-v1`,
  }));
  const owner = new ProjectContentOwnerService({ dataDir: join(root, 'owner') });
  const projects = new VideoProjectService({ owner, ownerUserId: principal.userId, assets });
  const created = await projects.create({ principal, operationId: 'create', document: doc });
  const reviews = new VideoProjectReviewService({ store: store.ledgers, projects });
  return {
    root,
    store,
    projects,
    reviews,
    contentRef: created.contentRef,
    async cleanup() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

for (const target of targets)
  test(`real owner event ID swap cannot borrow unrelated insertion ${target.kind}`, async () => {
    const f = await setup();
    try {
      const opened = await f.reviews.prepare({ principal, contentRef: f.contentRef, operationId: 'prepare' });
      const marked = await f.reviews.annotate({
        principal,
        reviewId: opened.review.reviewId,
        expectedRevision: 1,
        operationId: 'mark',
        body: 'Replace A',
        target,
      });
      const changed = (await f.projects.load({ principal, contentRef: f.contentRef })).document;
      const a = changed.assets[0]!.versions.find((v) => v.id === 'audio-a-v1')!;
      changed.assets[0]!.versions.push({ ...a, id: 'audio-a-v2' });
      changed.timeline.events[0]!.id = 'event-a';
      changed.timeline.events[1]!.id = 'event-b';
      changed.timeline.events[1]!.assetVersionRef = 'audio-a-v2';
      changed.timeline.events.unshift({
        id: 'new-unrelated-d',
        kind: 'audio',
        startTick: 0,
        durationTicks: 100,
        assetVersionRef: 'audio-d-v1',
      });
      const receipt = await f.projects.save({
        principal,
        contentRef: f.contentRef,
        expectedOwnerRevision: 1,
        operationId: 'swap-plus-c-bytes',
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
            result: { assetVersionRef: 'audio-a-v2', ownerRevision: receipt.ownerRevision },
          },
        }),
        { code: 'invalid_action' },
      );
    } finally {
      await f.cleanup();
    }
  });
