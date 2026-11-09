import { type ArtifactReviewAnchor, artifactReviewAnchorSchema, type ImmutableMedia } from '@cat-cafe/shared';
import { ArtifactReviewError } from './errors.js';

export function assertMediaAnchor(raw: ArtifactReviewAnchor, media: ImmutableMedia): void {
  const parsed = artifactReviewAnchorSchema.safeParse(raw);
  if (!parsed.success) throw new ArtifactReviewError('invalid_anchor');
  const anchor = parsed.data;
  if (anchor.kind !== 'video-range') {
    if (media.kind !== 'image') throw new ArtifactReviewError('invalid_anchor');
    const clock = media.animation;
    if (clock && clock.frameCount > 1) {
      if (
        anchor.frameIndex === undefined ||
        anchor.frameIndex >= clock.frameCount ||
        (anchor.endFrameIndex !== undefined && anchor.endFrameIndex >= clock.frameCount) ||
        anchor.timestampMs !== clock.frameDelaysMs.slice(0, anchor.frameIndex).reduce((sum, delay) => sum + delay, 0)
      )
        throw new ArtifactReviewError('invalid_anchor');
    } else if (
      anchor.frameIndex !== undefined ||
      anchor.timestampMs !== undefined ||
      anchor.endFrameIndex !== undefined
    )
      throw new ArtifactReviewError('invalid_anchor');
  }
  if (anchor.kind === 'image-point') {
    if (media.kind !== 'image') throw new ArtifactReviewError('invalid_anchor');
    assertPoint(anchor, media);
    return;
  }
  if (anchor.kind === 'image-region') {
    if (media.kind !== 'image') throw new ArtifactReviewError('invalid_anchor');
    assertRegion(anchor, media);
    return;
  }
  if (
    media.kind !== 'video' ||
    anchor.streamId !== media.streamId ||
    anchor.startTick < media.startTick ||
    anchor.endTick > media.startTick + media.durationTicks
  )
    throw new ArtifactReviewError('invalid_anchor');
  if (anchor.frameRegion) assertRegion(anchor.frameRegion, media);
  if (anchor.framePoint) assertPoint(anchor.framePoint, media);
}

function assertPoint(point: { x: number; y: number }, media: ImmutableMedia) {
  if (point.x > media.width || point.y > media.height) throw new ArtifactReviewError('invalid_anchor');
}

function assertRegion(region: { x: number; y: number; width: number; height: number }, media: ImmutableMedia) {
  if (region.x + region.width > media.width || region.y + region.height > media.height) {
    throw new ArtifactReviewError('invalid_anchor');
  }
}
