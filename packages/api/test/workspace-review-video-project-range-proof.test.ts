import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { VideoProjectDocumentV1, VideoProjectReviewTarget } from '@cat-cafe/shared';
import { ArtifactReviewStore } from '../src/domains/collaborative-content/artifact-review/store.js';
import { assertProjectTargetChanged } from '../src/domains/collaborative-content/workspace-review/result-proof/target.js';
import { VideoProjectReviewService } from '../src/domains/collaborative-content/workspace-review/video-project-review-service.js';
import { ProjectContentOwnerService } from '../src/domains/video-studio/content-owner/service.js';
import { VideoProjectAssetIndex } from '../src/domains/video-studio/project/asset-index.js';
import { VideoProjectService } from '../src/domains/video-studio/project/service.js';
import { projectHumanFixture as principal, projectDocumentFixture } from './helpers/video-project-fixture.js';
import { region, document as syntheticDocument } from './workspace-review-video-project.fixture.js';

type Moment = Extract<VideoProjectReviewTarget, { kind: 'moment' }> & { endTick: number };
function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}
const target: Moment = { kind: 'moment', tick: 20, endTick: 180, timebase: { numerator: 1, denominator: 30 } };

// A direct consumer RED distinguishes missing range traversal from a schema-only refusal.
test('F326 range proof consumes a visual changed after its first frame', () => {
  const before = syntheticDocument();
  const after = structuredClone(before);
  required(after.assets[0]).versions.push({
    ...required(required(after.assets[0]).versions[0]),
    id: 'changed',
    sha256: `sha256:${'b'.repeat(64)}`,
  });
  required(required(after.timeline.segments[1]).visuals[0]).assetVersionRef = 'changed';
  assert.doesNotThrow(() => assertProjectTargetChanged(before, after, target));
  assert.doesNotThrow(() => assertProjectTargetChanged(before, after, target, 'changed'));
});

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'f326-real-range-'));
  const store = new ArtifactReviewStore(join(root, 'artifact-reviews.sqlite'));
  const index = new VideoProjectAssetIndex({ resolveRoot: async (id) => ({ root, canonicalWorktreeId: id }) });
  const document: VideoProjectDocumentV1 = structuredClone(projectDocumentFixture);
  for (const [kind, mime] of [
    ['image', 'image/png'],
    ['audio', 'audio/mpeg'],
  ] as const) {
    const versions = [];
    for (const letter of ['a', 'b']) {
      const path = `${kind}-${letter}`;
      await writeFile(join(root, path), Buffer.from(`encoded-${kind}-${letter}`));
      const observed = await index.inspect({ kind: 'workspace', rootId: 'test-root', path });
      versions.push({
        id: `${kind}-${letter}`,
        mediaType: mime,
        ...observed,
        recordedAt: document.origin.at,
        origin: document.origin,
      });
    }
    document.assets.push({ id: kind, name: kind, kind, versions });
  }
  document.timeline.durationTicks = 240;
  const first = required(document.timeline.segments[0]);
  first.visuals = [
    { id: 'ended-visual', assetVersionRef: 'image-a', startTick: 0, endTick: 20 },
    { id: 'initial-visual', assetVersionRef: 'image-a', startTick: 20, endTick: 120 },
  ];
  document.timeline.segments.push({
    id: 'C02',
    kind: 'shot',
    label: 'Second shot',
    startTick: 120,
    durationTicks: 120,
    visuals: [
      { id: 'late-visual', assetVersionRef: 'image-a', startTick: 0, endTick: 60 },
      { id: 'outside-visual', assetVersionRef: 'image-a', startTick: 60, endTick: 120 },
    ],
  });
  document.timeline.events = [
    { id: 'ended-audio', kind: 'audio', assetVersionRef: 'audio-a', startTick: 10, durationTicks: 10 },
    { id: 'late-audio', kind: 'audio', assetVersionRef: 'audio-a', startTick: 160, durationTicks: 20 },
    { id: 'outside-audio', kind: 'audio', assetVersionRef: 'audio-a', startTick: 180, durationTicks: 20 },
  ];
  const owner = new ProjectContentOwnerService({ dataDir: join(root, 'owner') });
  const projects = new VideoProjectService({ owner, assets: index, ownerUserId: principal.userId });
  const created = await projects.create({ principal, operationId: 'create', document });
  return {
    root,
    store,
    projects,
    contentRef: created.contentRef,
    reviews: new VideoProjectReviewService({ store: store.ledgers, projects }),
    async cleanup() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function assertRangeEdit(
  kind: 'visual' | 'audio',
  position: 'late' | 'ended' | 'outside',
  boxed: boolean,
  hinted: boolean,
  branch: 'receipt' | 'asset',
) {
  const f = await setup();
  try {
    const opened = await f.reviews.prepare({ principal, contentRef: f.contentRef, operationId: 'prepare' });
    const marked = await f.reviews.annotate({
      principal,
      reviewId: opened.review.reviewId,
      expectedRevision: 1,
      operationId: 'mark',
      body: 'Fix the selected range',
      target: {
        ...target,
        ...(hinted ? { segmentId: 'C01', visualUseId: 'initial-visual' } : {}),
        ...(boxed ? { region } : {}),
      },
    });
    const annotation = required(marked.review.annotations[0]);
    const previousHistory = structuredClone(annotation.projectHistory);
    const changed = (await f.projects.load({ principal, contentRef: f.contentRef })).document;
    const material = kind === 'visual' ? 'image' : 'audio';
    const asset = required(changed.assets.find((asset) => asset.id === material));
    const version = required(asset.versions[1]);
    asset.versions.push({ ...version, id: 'registered-result' });
    const use =
      kind === 'visual'
        ? changed.timeline.segments
            .flatMap((segment) => segment.visuals)
            .find((visual) => visual.id === `${position}-visual`)
        : changed.timeline.events.find((event) => event.id === `${position}-audio`);
    required(use).assetVersionRef = 'registered-result';
    const receipt = await f.projects.save({
      principal,
      contentRef: f.contentRef,
      expectedOwnerRevision: 1,
      operationId: 'edit',
      document: changed,
    });
    const action = () =>
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
              ? { assetVersionRef: 'registered-result', ownerRevision: receipt.ownerRevision }
              : {
                  contentRef: receipt.contentRef,
                  ownerRevision: receipt.ownerRevision,
                  blobDigest: receipt.blobDigest,
                  operationId: receipt.operationId,
                },
        },
      });
    if (position === 'late' && !(boxed && kind === 'audio')) {
      const addressed = await action();
      assert.deepEqual(
        required(required(addressed.review.annotations[0]).projectHistory).slice(0, -1),
        previousHistory,
      );
      assert.deepEqual(required(addressed.review.annotations[0]).anchor, annotation.anchor);
    } else {
      await assert.rejects(action, { code: 'invalid_action' });
      assert.equal(
        (await f.reviews.read({ principal, reviewId: opened.review.reviewId })).review.revision,
        marked.review.revision,
      );
    }
  } finally {
    await f.cleanup();
  }
}

for (const kind of ['visual', 'audio'] as const)
  for (const position of ['late', 'ended', 'outside'] as const)
    for (const boxed of [false, true])
      for (const hinted of [false, true])
        for (const branch of ['receipt', 'asset'] as const)
          test(`F326 real range ${kind} ${position} boxed=${boxed} hinted=${hinted} ${branch}`, () =>
            assertRangeEdit(kind, position, boxed, hinted, branch));
