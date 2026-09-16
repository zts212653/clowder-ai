import { z } from 'zod';
import type { ImmutableMedia } from './artifact-review.js';

export const REVIEW_MARK_COLORS = ['#d04a3a', '#c77924', '#2c8c6a', '#3478c7', '#7546b8'] as const;
export const REVIEW_MARK_STROKE_WIDTHS = [2, 4, 8] as const;
export const MAX_REVIEW_DRAFT_MARKS = 100;
export const MAX_REVIEW_STROKE_POINTS = 300;
export const REVIEW_IMAGE_RATIOS = ['1:1', '3:4', '9:16', '4:3', '16:9'] as const;

const coordinate = z.number().finite().min(0).max(32768);
const point = z.object({ x: coordinate, y: coordinate }).strict();
const region = z
  .object({ x: coordinate, y: coordinate, width: coordinate.positive(), height: coordinate.positive() })
  .strict();
const style = z
  .object({
    id: z.string().trim().min(1).max(128),
    color: z.enum(REVIEW_MARK_COLORS),
    strokeWidth: z.union([z.literal(2), z.literal(4), z.literal(8)]),
    frame: z
      .object({ streamId: z.string().trim().min(1).max(128), tick: z.number().int().safe() })
      .strict()
      .optional(),
  })
  .strict();

/** Safe media-space primitives only: never SVG, HTML, executable styles, or URLs. */
export const artifactReviewDrawingSchema = z.discriminatedUnion('kind', [
  style.extend({ kind: z.literal('stroke'), points: z.array(point).min(2).max(MAX_REVIEW_STROKE_POINTS) }),
  style.extend({ kind: z.literal('rectangle'), ...region.shape }),
  style.extend({ kind: z.literal('ellipse'), ...region.shape }),
  style.extend({ kind: z.literal('arrow'), from: point, to: point }),
  style.extend({
    kind: z.literal('text'),
    at: point,
    text: z.string().trim().min(1).max(240),
    fontSize: z.number().int().min(12).max(48),
  }),
]);
export type ArtifactReviewDrawing = z.infer<typeof artifactReviewDrawingSchema>;

export const artifactReviewImageEditSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('erase-region'), region }).strict(),
  z.object({ kind: z.literal('aspect-ratio'), ratio: z.enum(REVIEW_IMAGE_RATIOS) }).strict(),
]);
export type ArtifactReviewImageEdit = z.infer<typeof artifactReviewImageEditSchema>;

export function reviewDrawingFitsMedia(mark: ArtifactReviewDrawing, media: ImmutableMedia): boolean {
  const fits = (at: { x: number; y: number }) => at.x >= 0 && at.y >= 0 && at.x <= media.width && at.y <= media.height;
  const fitsBounds = (() => {
    switch (mark.kind) {
      case 'stroke':
        return mark.points.every(fits);
      case 'rectangle':
      case 'ellipse':
        return fits(mark) && fits({ x: mark.x + mark.width, y: mark.y + mark.height });
      case 'arrow':
        return fits(mark.from) && fits(mark.to);
      case 'text':
        return fits(mark.at);
    }
  })();
  if (!fitsBounds) return false;
  if (media.kind === 'image') return mark.frame === undefined;
  return (
    mark.frame?.streamId === media.streamId &&
    mark.frame.tick >= media.startTick &&
    mark.frame.tick < media.startTick + media.durationTicks
  );
}
