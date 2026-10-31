import { isDeepStrictEqual } from 'node:util';
import {
  displayRegionToProjectCanvas,
  mapScreeningMediaRange,
  type ProjectScreeningContextAttachment,
  type VideoProjectMessageContext,
  type VideoProjectReviewTarget,
  type VideoProjectScreening,
  type VideoProjectScreeningSelection,
} from '@cat-cafe/shared';
import type { VideoProjectSnapshot } from '../../../video-studio/project/types.js';
import { WorkspaceContentReviewError } from '../errors.js';
import { assertProjectReviewTarget, projectReviewAnchor } from '../video-project-review-anchors.js';

/** Client chips name the frozen registration; the server checks its owner, bytes and historical mapping. */
export function validateProjectMessageSelection(
  attachment: ProjectScreeningContextAttachment,
  selection: VideoProjectScreeningSelection,
  screening: VideoProjectScreening,
  frozen: VideoProjectSnapshot,
) {
  const media = {
    contentRef: screening.media.contentRef,
    ownerRevision: screening.media.ownerRevision,
    blobDigest: screening.media.blobDigest,
  };
  const claimed = {
    contentRef: attachment.contentRef,
    screeningId: attachment.screeningId,
    input: attachment.input,
    media: attachment.media,
  };
  const actual = { contentRef: frozen.contentRef, screeningId: screening.id, input: screening.input, media };
  if (
    !isDeepStrictEqual(claimed, actual) ||
    frozen.ownerRevision !== screening.input.ownerRevision ||
    frozen.blobDigest !== screening.input.blobDigest
  )
    invalid();
  const probe = screening.media.media;
  const { startPts, endPts } = selection.mediaRange;
  if (startPts < probe.startTick || endPts > probe.startTick + probe.durationTicks) invalid();
  const mapping = mapScreeningMediaRange(screening, selection.mediaRange);
  const target = selection.target;
  assertMappedTarget(target, mapping, frozen);
  const canvasRegion = selection.displayRegion
    ? displayRegionToProjectCanvas(screening, selection.displayRegion)
    : undefined;
  if (selection.displayRegion && !canvasRegion) invalid();
  if (selection.canvasRegion && !isDeepStrictEqual(selection.canvasRegion, canvasRegion)) invalid();
  if (target.kind === 'moment' && !isDeepStrictEqual(target.region, canvasRegion)) invalid();
  assertProjectReviewTarget(frozen.document, target);
  return {
    anchor: projectReviewAnchor(frozen, target),
    selection: { ...selection, ...(canvasRegion ? { canvasRegion } : {}) },
    media,
  };
}

function assertMappedTarget(
  target: VideoProjectReviewTarget,
  mapping: { startTick: number; endTick: number } | null,
  frozen: VideoProjectSnapshot,
) {
  if (!mapping && target.kind !== 'project') invalid();
  if (
    target.kind === 'moment' &&
    (!mapping ||
      target.tick !== mapping.startTick ||
      (target.endTick ?? target.tick + 1) !== mapping.endTick ||
      target.timebase.numerator !== frozen.document.timeline.timebase.numerator ||
      target.timebase.denominator !== frozen.document.timeline.timebase.denominator)
  )
    invalid();
  if (target.kind === 'segment') {
    const segment = frozen.document.timeline.segments.find((item) => item.id === target.segmentId);
    if (
      !mapping ||
      !segment ||
      mapping.startTick < segment.startTick ||
      mapping.endTick > segment.startTick + segment.durationTicks
    )
      invalid();
  }
  if (target.kind === 'artwork') invalid(); // This attachment describes an encoded screening, not a library image.
}

export function assertMessageResultLocation(
  annotation: { projectMessage?: VideoProjectMessageContext },
  targets: readonly { target: { kind: string } }[],
): void {
  if (annotation.projectMessage && targets.some((anchor) => anchor.target.kind === 'project')) invalid();
}
function invalid(): never {
  throw new WorkspaceContentReviewError('invalid_action');
}
