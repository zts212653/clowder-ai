import { z } from 'zod';

const ref = z.string().trim().min(1).max(2048);
const id = z.string().trim().min(1).max(128);
const positive = z.number().int().positive().safe();
const tick = z.number().int().safe();
const rational = z.object({ numerator: positive, denominator: positive }).strict();

export const immutableMediaSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('image'), width: positive.max(32768), height: positive.max(32768) }).strict(),
  z
    .object({
      kind: z.literal('video'),
      width: positive.max(32768),
      height: positive.max(32768),
      codedWidth: positive.max(32768),
      codedHeight: positive.max(32768),
      rotation: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
      pixelAspectRatio: rational,
      streamId: id,
      streamIndex: z.number().int().min(0).max(64),
      timebase: rational,
      startTick: tick,
      durationTicks: positive,
      /** Present only when complete packet PTS prove a uniform frame clock. Legacy/VFR remains absent. */
      frameRate: rational.optional(),
      containerStartSeconds: z.number().finite(),
    })
    .strict(),
]);
export type ImmutableMedia = z.infer<typeof immutableMediaSchema>;

/** Still images use their decoded EXIF display coordinates; immutable bytes keep their original MIME. */
export const reviewedMediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp', 'video/mp4']);
export type ReviewedMediaType = z.infer<typeof reviewedMediaTypeSchema>;

export const reviewedMediaAssetSchema = z
  .object({
    contentRef: ref,
    ownerRevision: positive,
    blobDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    mediaType: reviewedMediaTypeSchema,
    media: immutableMediaSchema,
    sourcePublication: z.object({ artifactRef: ref, sourceRef: ref, revision: ref, threadId: ref.optional() }).strict(),
    ownerReceiptRef: ref,
  })
  .strict();
export type ReviewedMediaAsset = z.infer<typeof reviewedMediaAssetSchema>;

const region = {
  x: z.number().finite().min(0),
  y: z.number().finite().min(0),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
};
const point = { x: z.number().finite().min(0), y: z.number().finite().min(0) };
export const artifactReviewAnchorSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('image-region'), ...region }).strict(),
    z.object({ kind: z.literal('image-point'), ...point }).strict(),
    z
      .object({
        kind: z.literal('video-range'),
        streamId: id,
        startTick: tick,
        endTick: tick,
        /** A quoted paragraph belongs to this exact media version and retained metadata revision. */
        storyEvidence: z
          .object({
            paragraphId: z.string().min(1).max(256),
            metadataRevision: positive,
            quote: z.string().min(1).max(12000),
          })
          .strict()
          .optional(),
        frameRegion: z
          .object({ tick, ...region })
          .strict()
          .optional(),
        framePoint: z
          .object({ tick, ...point })
          .strict()
          .optional(),
      })
      .strict(),
  ])
  .superRefine((anchor, context) => {
    if (anchor.kind !== 'video-range') return;
    if (anchor.endTick <= anchor.startTick)
      context.addIssue({ code: 'custom', message: 'Video range must be nonempty and half-open' });
    if (
      anchor.frameRegion &&
      (anchor.frameRegion.tick < anchor.startTick || anchor.frameRegion.tick >= anchor.endTick)
    ) {
      context.addIssue({ code: 'custom', message: 'Frame must be inside the selected time range' });
    }
    if (anchor.framePoint && (anchor.framePoint.tick < anchor.startTick || anchor.framePoint.tick >= anchor.endTick))
      context.addIssue({ code: 'custom', message: 'Point frame must be inside the selected time range' });
    if (anchor.framePoint && anchor.frameRegion)
      context.addIssue({ code: 'custom', message: 'Choose one spatial target per video anchor' });
  });
export type ArtifactReviewAnchor = z.infer<typeof artifactReviewAnchorSchema>;

export const mediaModificationSelectionItemSchema = z
  .object({
    id,
    selection: artifactReviewAnchorSchema,
    instruction: z.string().trim().min(1).max(4000).optional(),
  })
  .strict();
