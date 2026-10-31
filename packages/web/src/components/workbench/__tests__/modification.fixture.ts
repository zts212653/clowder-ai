import type {
  VideoProjectAssetVersion,
  VideoProjectReviewAnchor,
  VideoProjectReviewResult,
  VideoProjectReviewTarget,
  VideoProjectScreening,
  WorkspaceContentAnnotation,
} from '@cat-cafe/shared';
import type { ProjectSnapshot } from '../video-project/api';
import { comparisonShot, comparisonSide } from './compare-screening.fixture';

// Immutable API response fixtures, never labelled as a sampled film or rendered browser evidence.
export const modificationAt = '2026-10-10T15:00:00.000Z';
export function modificationAsset(id: string, sha: string): VideoProjectAssetVersion {
  return {
    id,
    mediaType: 'image/png',
    byteLength: 70,
    sha256: `sha256:${sha.repeat(64)}`,
    locator: { kind: 'workspace', rootId: 'registered', path: `${id}.png` },
    recordedAt: modificationAt,
    origin: { kind: 'created', actor: { kind: 'human', actorId: 'owner' }, at: modificationAt, refs: ['message:1'] },
    width: 1920,
    height: 1080,
  };
}
export function modificationSnapshot(revision: number, changed = revision > 1): ProjectSnapshot {
  const value = comparisonSide('old', [comparisonShot('opening', 0, 1359), comparisonShot('C08', 1359, 200)]).input;
  value.ownerRevision = revision;
  value.blobDigest = `sha256:${String(revision).repeat(64)}`;
  value.document.timeline.timebase = { numerator: 1, denominator: 30 };
  value.document.timeline.segments[1].visuals = [
    { id: 'C08c', assetVersionRef: changed ? 'png-new' : 'png-old', startTick: 70, endTick: 200 },
  ];
  value.document.assets = [
    {
      id: 'artwork',
      name: 'C08c',
      kind: 'image',
      versions: [modificationAsset('png-old', 'a'), modificationAsset('png-new', 'b')],
    },
  ];
  return value;
}
export function modificationAnchor(
  snapshot: ProjectSnapshot,
  target?: VideoProjectReviewTarget,
): VideoProjectReviewAnchor {
  return {
    kind: 'video-project',
    baseOwnerRevision: snapshot.ownerRevision,
    baseRevision: snapshot.blobDigest,
    target: target ?? { kind: 'artwork', assetVersionRef: 'png-old', visualUseId: 'C08c' },
  };
}
export function modificationOpinion(
  before: ProjectSnapshot,
  after: ProjectSnapshot,
  result?: VideoProjectReviewResult,
): WorkspaceContentAnnotation {
  return {
    id: 'opinion',
    anchor: modificationAnchor(before),
    body: '放大镜的位置需要调整',
    author: { kind: 'human', actorId: 'owner' },
    createdAt: modificationAt,
    updatedAt: modificationAt,
    state: 'open',
    projectHistory: [
      {
        kind: 'addressed',
        actor: { kind: 'cat', actorId: 'sol' },
        at: modificationAt,
        operationId: 'addressed',
        reason: '调整了画稿',
        result: result ?? {
          contentRef: after.contentRef,
          ownerRevision: after.ownerRevision,
          blobDigest: after.blobDigest,
          operationId: 'edit',
        },
      },
    ],
  };
}
export function modificationScreening(snapshot: ProjectSnapshot, id = 'rendered-change'): VideoProjectScreening {
  const value = comparisonSide('new', snapshot.document.timeline.segments).screening;
  value.id = id;
  value.input = {
    contentRef: snapshot.contentRef,
    ownerRevision: snapshot.ownerRevision,
    blobDigest: snapshot.blobDigest,
  };
  value.media.media.timebase = { numerator: 1, denominator: 15360 };
  value.media.media.durationTicks = snapshot.document.timeline.durationTicks * 512;
  value.mapping.segments = [
    {
      mediaStartPts: 0,
      mediaEndPts: snapshot.document.timeline.durationTicks * 512,
      projectStartTick: 0,
      projectEndTick: snapshot.document.timeline.durationTicks,
      refs: ['render:mapped'],
    },
  ];
  return value;
}

export function twoArtworkModification() {
  const before = modificationSnapshot(1),
    after = modificationSnapshot(2);
  for (const snapshot of [before, after])
    snapshot.document.timeline.segments[1].visuals.push({
      ...snapshot.document.timeline.segments[1].visuals[0],
      id: 'C08-extra',
      startTick: 110,
    });
  const firstOnly = structuredClone(after);
  firstOnly.ownerRevision = 3;
  firstOnly.blobDigest = `sha256:${'3'.repeat(64)}`;
  firstOnly.document.timeline.segments[1].visuals[1].assetVersionRef = 'png-old';
  const unknown = structuredClone(after);
  unknown.ownerRevision = 4;
  unknown.blobDigest = `sha256:${'4'.repeat(64)}`;
  const annotation = modificationOpinion(before, after);
  annotation.anchor = modificationAnchor(before, { kind: 'artwork', assetVersionRef: 'png-old' });
  return { before, after, firstOnly, unknown, annotation };
}
