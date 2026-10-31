import { z } from 'zod';

const id = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim().length > 0);
const revision = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const positive = z.number().int().positive().safe();
const tick = z.number().int().nonnegative().safe();
const body = z
  .string()
  .min(1)
  .max(8000)
  .refine((value) => value.trim().length > 0);
const actor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('human'), actorId: id }).strict(),
  z.object({ kind: z.literal('cat'), actorId: id }).strict(),
]);

/** A JSON editing input is not an immutable encoded-video stream. */
export const videoProjectReviewSourceSchema = z
  .object({
    kind: z.literal('video-project'),
    contentRef: id,
    ownerRevision: positive,
    revision,
    mime: z.literal('application/vnd.cat-cafe.video-project+json'),
  })
  .strict();
export type VideoProjectReviewSource = z.infer<typeof videoProjectReviewSourceSchema>;

const regionBboxSchema = z
  .object({
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
  })
  .strict();

/** Coordinates are original display pixels, never CSS or letterbox coordinates. */
export const videoProjectReviewRegionSchema = z
  .object({
    coordinateSpace: z.literal('display-pixels'),
    width: positive,
    height: positive,
    rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
    bbox: regionBboxSchema,
  })
  .strict()
  .refine(
    ({ bbox, width, height }) => bbox.x + bbox.width <= width && bbox.y + bbox.height <= height,
    'Region exceeds display pixels',
  );
export type VideoProjectReviewRegion = z.infer<typeof videoProjectReviewRegionSchema>;

/** A mapped project-space region is explicit; it never replaces the original display evidence. */
export const videoProjectCanvasRegionSchema = z
  .object({
    coordinateSpace: z.literal('canvas-pixels'),
    width: positive,
    height: positive,
    rotation: z.literal(0),
    bbox: regionBboxSchema,
  })
  .strict()
  .refine(
    ({ bbox, width, height }) => bbox.x + bbox.width <= width && bbox.y + bbox.height <= height,
    'Region exceeds project canvas pixels',
  );
export type VideoProjectCanvasRegion = z.infer<typeof videoProjectCanvasRegionSchema>;
export const videoProjectReviewMomentRegionSchema = z.union([
  videoProjectReviewRegionSchema,
  videoProjectCanvasRegionSchema,
]);
export type VideoProjectReviewMomentRegion = z.infer<typeof videoProjectReviewMomentRegionSchema>;

export const videoProjectReviewTargetSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('project') }).strict(),
    z.object({ kind: z.literal('segment'), segmentId: id }).strict(),
    z
      .object({
        kind: z.literal('moment'),
        tick,
        endTick: positive.optional(),
        timebase: z.object({ numerator: positive, denominator: positive }).strict(),
        segmentId: id.optional(),
        visualUseId: id.optional(),
        region: videoProjectReviewMomentRegionSchema.optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal('artwork'),
        assetVersionRef: id,
        visualUseId: id.optional(),
        region: videoProjectReviewRegionSchema.optional(),
      })
      .strict(),
  ])
  .superRefine((target, ctx) => {
    if (target.kind === 'moment' && target.endTick !== undefined && target.endTick <= target.tick)
      ctx.addIssue({ code: 'custom', path: ['endTick'], message: 'Moment range must be nonempty and half-open' });
  });
export type VideoProjectReviewTarget = z.infer<typeof videoProjectReviewTargetSchema>;

export const videoProjectReviewAnchorSchema = z
  .object({
    kind: z.literal('video-project'),
    baseRevision: revision,
    baseOwnerRevision: positive,
    target: videoProjectReviewTargetSchema,
  })
  .strict();
export type VideoProjectReviewAnchor = z.infer<typeof videoProjectReviewAnchorSchema>;

export const videoProjectReviewResultSchema = z.union([
  z.object({ contentRef: id, ownerRevision: positive, blobDigest: revision, operationId: id }).strict(),
  z.object({ assetVersionRef: id, ownerRevision: positive }).strict(),
  z.object({ kind: z.literal('not-changed'), reason: body }).strict(),
]);
export type VideoProjectReviewResult = z.infer<typeof videoProjectReviewResultSchema>;

export const videoProjectReviewHistorySchema = z
  .object({
    kind: z.enum(['created', 'located', 'replied', 'addressed', 'reopened', 'resolved']),
    actor,
    at: z.string().datetime(),
    operationId: id,
    reason: body.optional(),
    targets: z.array(videoProjectReviewAnchorSchema).min(1).max(100).optional(),
    result: videoProjectReviewResultSchema.optional(),
    replyId: id.optional(),
  })
  .strict();
export type VideoProjectReviewHistory = z.infer<typeof videoProjectReviewHistorySchema>;

export const videoProjectReviewActionSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('located'),
      annotationId: id,
      targets: z.array(videoProjectReviewAnchorSchema).min(1).max(100),
      reason: body.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('replied'), annotationId: id, replyId: id, body }).strict(),
  z
    .object({
      kind: z.literal('addressed'),
      annotationId: id,
      result: videoProjectReviewResultSchema,
      reason: body.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('reopened'), annotationId: id, reason: body }).strict(),
  z.object({ kind: z.literal('resolved'), annotationId: id, reason: body.optional() }).strict(),
]);
export type VideoProjectReviewAction = z.infer<typeof videoProjectReviewActionSchema>;
