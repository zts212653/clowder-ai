import type { ArtifactReviewAnchor } from '@cat-cafe/shared';

/** Ordinary-file comments refer to the selected frame; no segment was selected. */
export function workspaceFrameAnchor(anchor: ArtifactReviewAnchor): ArtifactReviewAnchor {
  if (anchor.kind !== 'video-range') return anchor;
  const frame = anchor.framePoint ?? anchor.frameRegion;
  return frame ? { ...anchor, startTick: frame.tick, endTick: frame.tick + 1 } : anchor;
}
