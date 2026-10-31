import { isDeepStrictEqual } from 'node:util';
import type {
  VideoProjectReviewAnchor,
  VideoProjectReviewTarget,
  WorkspaceContentAnnotationResolution,
} from '@cat-cafe/shared';
import type { VideoProjectSnapshot } from '../../video-studio/project/types.js';
import { momentRangeEvidence } from './result-proof/moment-range.js';
import { assertProjectReviewTarget } from './video-project-review-anchors.js';

/** Stable entity evidence can remap an ID, never scale an old image box onto replacement pixels. */
export function resolveProjectAnchor(
  anchor: VideoProjectReviewAnchor,
  previous: VideoProjectSnapshot,
  current: VideoProjectSnapshot,
): WorkspaceContentAnnotationResolution['status'] {
  const target = anchor.target;
  try {
    assertProjectReviewTarget(current.document, target);
    if (target.kind === 'moment' && target.endTick !== undefined) assertProjectReviewTarget(previous.document, target);
  } catch {
    return 'orphaned';
  }
  if (anchor.baseRevision === current.blobDigest) return 'attached';
  if (target.kind === 'project' || target.kind === 'segment') return 'moved';
  if (target.kind === 'artwork') {
    const before = previous.document.assets
      .flatMap((asset) => asset.versions)
      .find((v) => v.id === target.assetVersionRef);
    const after = current.document.assets
      .flatMap((asset) => asset.versions)
      .find((v) => v.id === target.assetVersionRef);
    return before &&
      after &&
      before.sha256 === after.sha256 &&
      before.width === after.width &&
      before.height === after.height &&
      before.rotation === after.rotation
      ? 'moved'
      : 'orphaned';
  }
  if (target.endTick !== undefined) {
    return isDeepStrictEqual(
      momentRangeEvidence(previous.document, target).value,
      momentRangeEvidence(current.document, target).value,
    )
      ? 'moved'
      : 'orphaned';
  }
  return momentEvidenceMatches(target, previous, current) ? 'moved' : 'orphaned';
}

function momentEvidenceMatches(
  target: Extract<VideoProjectReviewTarget, { kind: 'moment' }>,
  previous: VideoProjectSnapshot,
  current: VideoProjectSnapshot,
): boolean {
  const find = (snapshot: VideoProjectSnapshot) =>
    snapshot.document.timeline.segments.find((segment) =>
      target.visualUseId
        ? segment.visuals.some((visual) => visual.id === target.visualUseId)
        : segment.id === target.segmentId,
    );
  const before = find(previous);
  const after = find(current);
  if (
    !before ||
    !after ||
    before.id !== after.id ||
    before.startTick !== after.startTick ||
    before.durationTicks !== after.durationTicks
  )
    return false;
  // A moment without visual-use evidence cannot claim its old pixels still exist.
  if (!target.visualUseId) return !target.region && JSON.stringify(before.visuals) === JSON.stringify(after.visuals);
  const oldUse = before.visuals.find((visual) => visual.id === target.visualUseId);
  const newUse = after.visuals.find((visual) => visual.id === target.visualUseId);
  if (
    !oldUse ||
    !newUse ||
    oldUse.startTick !== newUse.startTick ||
    oldUse.endTick !== newUse.endTick ||
    oldUse.assetVersionRef !== newUse.assetVersionRef
  )
    return false;
  const oldAsset = previous.document.assets
    .flatMap((asset) => asset.versions)
    .find((v) => v.id === oldUse.assetVersionRef);
  const newAsset = current.document.assets
    .flatMap((asset) => asset.versions)
    .find((v) => v.id === newUse.assetVersionRef);
  if (
    !oldAsset ||
    !newAsset ||
    oldAsset.sha256 !== newAsset.sha256 ||
    oldAsset.rotation !== newAsset.rotation ||
    oldAsset.width !== newAsset.width ||
    oldAsset.height !== newAsset.height
  )
    return false;
  if (target.region && JSON.stringify(previous.document.timeline) !== JSON.stringify(current.document.timeline))
    return false;
  return (
    Boolean(oldUse.assetVersionRef) &&
    previous.document.timeline.width === current.document.timeline.width &&
    previous.document.timeline.height === current.document.timeline.height
  );
}
