import {
  mediaPtsToProjectTick,
  projectTickToMediaPts,
  type VideoProjectScreening,
  type VideoProjectSegment,
} from '@cat-cafe/shared';
import { browserTimeToTick, tickToBrowserTime } from '@/components/content-review/review-geometry';
import type { ProjectSnapshot } from './api';

export type ScreeningCompareSide = { screening: VideoProjectScreening; input: ProjectSnapshot; mediaUrl: string };
export type ScreeningComparePosition =
  | { kind: 'aligned'; leftMediaTime: number; rateScale: number }
  | { kind: 'missing'; reason: 'unmapped' | 'segment-missing' | 'visual-missing' | 'input-mismatch' };

export function compareSideMatchesInput(side: ScreeningCompareSide): boolean {
  return (
    side.input.contentRef === side.screening.input.contentRef &&
    side.input.ownerRevision === side.screening.input.ownerRevision &&
    side.input.blobDigest === side.screening.input.blobDigest
  );
}
export function comparePairMatchesInput(left: ScreeningCompareSide, right: ScreeningCompareSide): boolean {
  return (
    compareSideMatchesInput(left) && compareSideMatchesInput(right) && left.input.contentRef === right.input.contentRef
  );
}

function sharedActiveVisual(right: VideoProjectSegment, left: VideoProjectSegment, tick: number, visualUseId?: string) {
  const active = right.visuals.filter(
    (visual) =>
      tick >= right.startTick + visual.startTick &&
      tick < right.startTick + visual.endTick &&
      (visualUseId ? visual.id === visualUseId : left.visuals.some((candidate) => candidate.id === visual.id)),
  );
  const rightVisual = active.length === 1 ? active[0] : undefined;
  return {
    rightVisual,
    leftVisual: rightVisual ? left.visuals.find((visual) => visual.id === rightVisual.id) : undefined,
  };
}
export function comparePairKey(left: ScreeningCompareSide, right: ScreeningCompareSide): string {
  return JSON.stringify(
    [left, right].map((side) => [
      side.screening.id,
      side.screening.input,
      side.input.contentRef,
      side.input.ownerRevision,
      side.input.blobDigest,
      side.screening.media.contentRef,
      side.screening.media.ownerRevision,
      side.screening.media.blobDigest,
      side.mediaUrl,
    ]),
  );
}

/** Right media drives a stable narrative identity, then each side uses its own frozen clock. */
export function compareScreeningPosition(
  right: ScreeningCompareSide,
  left: ScreeningCompareSide,
  rightMediaTime: number,
  visualUseId?: string,
): ScreeningComparePosition {
  if (!comparePairMatchesInput(left, right)) return { kind: 'missing', reason: 'input-mismatch' };
  const rightPts = browserTimeToTick(rightMediaTime, right.screening.media.media);
  const rightTick = mediaPtsToProjectTick(right.screening, rightPts);
  if (rightTick === null) return { kind: 'missing', reason: 'unmapped' };
  const rightSegment = right.input.document.timeline.segments.find(
    (segment) => rightTick >= segment.startTick && rightTick < segment.startTick + segment.durationTicks,
  );
  const leftSegment = left.input.document.timeline.segments.find((segment) => segment.id === rightSegment?.id);
  if (!rightSegment || !leftSegment) return { kind: 'missing', reason: 'segment-missing' };
  const { rightVisual, leftVisual } = sharedActiveVisual(rightSegment, leftSegment, rightTick, visualUseId);
  if (visualUseId && (!rightVisual || !leftVisual)) return { kind: 'missing', reason: 'visual-missing' };
  const rightStart = rightSegment.startTick + (rightVisual?.startTick ?? 0);
  const leftStart = leftSegment.startTick + (leftVisual?.startTick ?? 0);
  const rightSpan = rightVisual ? rightVisual.endTick - rightVisual.startTick : rightSegment.durationTicks;
  const leftSpan = leftVisual ? leftVisual.endTick - leftVisual.startTick : leftSegment.durationTicks;
  const leftTick = Number(BigInt(leftStart) + (BigInt(rightTick - rightStart) * BigInt(leftSpan)) / BigInt(rightSpan));
  const leftPts = projectTickToMediaPts(left.screening, leftTick);
  const leftPiece = left.screening.mapping.segments.find(
    (piece) => leftTick >= piece.projectStartTick && leftTick < piece.projectEndTick,
  );
  const rightPiece = right.screening.mapping.segments.find(
    (piece) => rightPts >= piece.mediaStartPts && rightPts < piece.mediaEndPts,
  );
  if (leftPts === null || !leftPiece || !rightPiece) return { kind: 'missing', reason: 'unmapped' };
  const leftSecondsPerTick =
    tickToBrowserTime(leftPiece.mediaEndPts - leftPiece.mediaStartPts, left.screening.media.media) /
    (leftPiece.projectEndTick - leftPiece.projectStartTick);
  const rightSecondsPerTick =
    tickToBrowserTime(rightPiece.mediaEndPts - rightPiece.mediaStartPts, right.screening.media.media) /
    (rightPiece.projectEndTick - rightPiece.projectStartTick);
  const rateScale = (leftSpan / rightSpan) * (leftSecondsPerTick / rightSecondsPerTick);
  if (!Number.isFinite(rateScale) || rateScale <= 0) return { kind: 'missing', reason: 'unmapped' };
  return { kind: 'aligned', leftMediaTime: tickToBrowserTime(leftPts, left.screening.media.media), rateScale };
}
