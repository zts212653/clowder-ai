import type { VideoProjectDocumentV1, VideoProjectReviewAnchor, VideoProjectReviewTarget } from '@cat-cafe/shared';
import { videoProjectReviewAnchorSchema } from '@cat-cafe/shared';
import type { VideoProjectPrincipal } from '../../video-studio/project/access.js';
import type {
  VideoProjectReadPort as VideoProjectReviewPort,
  VideoProjectSnapshot,
} from '../../video-studio/project/types.js';
import { WorkspaceContentReviewError } from './errors.js';

type Segment = VideoProjectDocumentV1['timeline']['segments'][number];
type VisualEvidence = { segment: Segment; use: Segment['visuals'][number] };

export function assertProjectReviewTarget(document: VideoProjectDocumentV1, target: VideoProjectReviewTarget): void {
  if (target.kind === 'project') return;
  if (target.kind === 'segment') {
    if (!document.timeline.segments.some((segment) => segment.id === target.segmentId)) invalid();
    return;
  }
  const visual = findVisual(document, target.visualUseId);
  if (target.kind === 'moment') assertMomentTarget(document, target, visual);
  else assertArtworkTarget(document, target, visual);
}

function findVisual(document: VideoProjectDocumentV1, id?: string): VisualEvidence | undefined {
  if (!id) return undefined;
  for (const segment of document.timeline.segments) {
    const use = segment.visuals.find((visual) => visual.id === id);
    if (use) return { segment, use };
  }
  return invalid();
}

function assertMomentTarget(
  document: VideoProjectDocumentV1,
  target: Extract<VideoProjectReviewTarget, { kind: 'moment' }>,
  visual?: VisualEvidence,
): void {
  const timeline = document.timeline;
  if (
    !Number.isSafeInteger(target.tick) ||
    target.tick < 0 ||
    target.tick >= timeline.durationTicks ||
    (target.endTick !== undefined &&
      (!Number.isSafeInteger(target.endTick) ||
        target.endTick <= target.tick ||
        target.endTick > timeline.durationTicks)) ||
    target.timebase.numerator !== timeline.timebase.numerator ||
    target.timebase.denominator !== timeline.timebase.denominator
  )
    invalid();
  assertMomentSegment(timeline.segments, target, visual);
  if (
    visual &&
    !containsTick(
      target.tick,
      visual.segment.startTick + visual.use.startTick,
      visual.segment.startTick + visual.use.endTick,
    )
  )
    invalid();
  if (
    target.region &&
    (target.region.width !== timeline.width || target.region.height !== timeline.height || target.region.rotation !== 0)
  )
    invalid();
}

function assertMomentSegment(
  segments: Segment[],
  target: Extract<VideoProjectReviewTarget, { kind: 'moment' }>,
  visual?: VisualEvidence,
): void {
  if (!target.segmentId) return;
  const segment = segments.find((segment) => segment.id === target.segmentId);
  if (!segment || !containsTick(target.tick, segment.startTick, segment.startTick + segment.durationTicks)) invalid();
  if (visual && visual.segment.id !== segment.id) invalid();
}

function containsTick(tick: number, start: number, end: number) {
  return tick >= start && tick < end;
}

function assertArtworkTarget(
  document: VideoProjectDocumentV1,
  target: Extract<VideoProjectReviewTarget, { kind: 'artwork' }>,
  visual?: VisualEvidence,
): void {
  const version = document.assets.flatMap((asset) => asset.versions).find((v) => v.id === target.assetVersionRef);
  if (!version || (visual && visual.use.assetVersionRef !== version.id)) invalid();
  if (!target.region) return;
  const rotation = version.rotation ?? 0;
  const swapped = rotation === 90 || rotation === 270;
  if (
    !version.width ||
    !version.height ||
    target.region.rotation !== rotation ||
    target.region.width !== (swapped ? version.height : version.width) ||
    target.region.height !== (swapped ? version.width : version.height)
  )
    invalid();
}

export function projectReviewAnchor(
  snapshot: VideoProjectSnapshot,
  target: VideoProjectReviewTarget,
): VideoProjectReviewAnchor {
  const parsed = videoProjectReviewAnchorSchema.safeParse({
    kind: 'video-project',
    baseOwnerRevision: snapshot.ownerRevision,
    baseRevision: snapshot.blobDigest,
    target,
  });
  if (!parsed.success) invalid();
  const anchor = parsed.data;
  assertProjectReviewTarget(snapshot.document, anchor.target);
  return anchor;
}

export async function validateProjectAnchor(
  port: VideoProjectReviewPort,
  principal: VideoProjectPrincipal,
  contentRef: string,
  value: VideoProjectReviewAnchor,
): Promise<VideoProjectReviewAnchor> {
  const parsed = videoProjectReviewAnchorSchema.safeParse(value);
  if (!parsed.success) invalid();
  const anchor = parsed.data;
  const snapshot = await port.load({ principal, contentRef, ownerRevision: anchor.baseOwnerRevision });
  if (snapshot.blobDigest !== anchor.baseRevision) throw new WorkspaceContentReviewError('source_changed');
  assertProjectReviewTarget(snapshot.document, anchor.target);
  return anchor;
}

function invalid(): never {
  throw new WorkspaceContentReviewError('invalid_action');
}
