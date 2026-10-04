import { type ArtifactReviewAnchor, artifactReviewAnchorSchema, type ImmutableMedia } from '@cat-cafe/shared';
import { assertMediaAnchor } from '../artifact-review/anchors.js';
import { ArtifactReviewError } from '../artifact-review/errors.js';

/** A new derivative has a new stream clock. Only the explicit request selection is mapped; old discussion stays on its owner. */
export function mapDerivedMediaAnchor(
  anchor: ArtifactReviewAnchor,
  from: ImmutableMedia,
  to: ImmutableMedia,
): ArtifactReviewAnchor {
  assertMediaAnchor(anchor, from);
  const point = (value: { x: number; y: number }) => ({
    x: (value.x * to.width) / from.width,
    y: (value.y * to.height) / from.height,
  });
  const region = (value: { x: number; y: number; width: number; height: number }) => ({
    ...point(value),
    width: (value.width * to.width) / from.width,
    height: (value.height * to.height) / from.height,
  });
  let mapped: ArtifactReviewAnchor;
  if (anchor.kind === 'image-point' && from.kind === 'image' && to.kind === 'image')
    mapped = { kind: anchor.kind, ...point(anchor) };
  else if (anchor.kind === 'image-region' && from.kind === 'image' && to.kind === 'image')
    mapped = { kind: anchor.kind, ...region(anchor) };
  else if (anchor.kind === 'video-range' && from.kind === 'video' && to.kind === 'video') {
    const tick = (value: number, end = false) => {
      const n = BigInt(value - from.startTick) * BigInt(from.timebase.numerator) * BigInt(to.timebase.denominator);
      const d = BigInt(from.timebase.denominator) * BigInt(to.timebase.numerator);
      return Math.min(to.startTick + to.durationTicks, to.startTick + Number((n + (end ? d - 1n : 0n)) / d));
    };
    mapped = {
      kind: 'video-range',
      streamId: to.streamId,
      startTick: tick(anchor.startTick),
      endTick: tick(anchor.endTick, true),
      ...(anchor.framePoint ? { framePoint: { ...point(anchor.framePoint), tick: tick(anchor.framePoint.tick) } } : {}),
      ...(anchor.frameRegion
        ? { frameRegion: { ...region(anchor.frameRegion), tick: tick(anchor.frameRegion.tick) } }
        : {}),
    };
  } else throw new ArtifactReviewError('invalid_action');
  const parsed = artifactReviewAnchorSchema.parse(mapped);
  assertMediaAnchor(parsed, to);
  return parsed;
}
