import { z } from 'zod';

const ref = z.string().trim().min(1).max(2048);
const id = z.string().trim().min(1).max(128);
const positive = z.number().int().positive().safe();
const tick = z.number().int().safe();
const rational = z.object({ numerator: positive, denominator: positive }).strict();

export const immutableMediaSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('image'),
      width: positive.max(32768),
      height: positive.max(32768),
      animation: z
        .object({
          frameCount: positive.max(600),
          frameDelaysMs: z.array(z.number().int().min(0).max(655350)).min(1).max(600),
          durationMs: z.number().int().safe().min(0),
          /** GIF repeat count including its initial play; zero means unlimited. */
          loopCount: z.number().int().min(0).max(65536),
        })
        .strict()
        .superRefine((value, ctx) => {
          if (
            value.frameCount !== value.frameDelaysMs.length ||
            value.durationMs !== value.frameDelaysMs.reduce((sum, delay) => sum + delay, 0)
          )
            ctx.addIssue({ code: 'custom', message: 'Animation clock must describe every frame' });
        })
        .optional(),
      viewBox: z
        .object({
          minX: z.number().finite(),
          minY: z.number().finite(),
          width: z.number().finite().positive(),
          height: z.number().finite().positive(),
        })
        .strict()
        .optional(),
    })
    .strict(),
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

/** The server projection and client viewport share a bounded grid, including very wide or tall GIFs. */
export function gifAtlasLayout(width: number, height: number, frameCount: number) {
  const maxColumns = Math.floor(32768 / width),
    maxRows = Math.floor(32768 / height);
  const columns = Math.max(Math.ceil(frameCount / maxRows), Math.min(Math.ceil(Math.sqrt(frameCount)), maxColumns));
  return { columns, rows: Math.ceil(frameCount / columns) };
}

/** Still images use their decoded EXIF display coordinates; immutable bytes keep their original MIME. */
export const reviewedMediaTypeSchema = z.enum([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/svg+xml',
  'video/mp4',
]);
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
const animationFrame = {
  frameIndex: z.number().int().min(0).max(599).optional(),
  endFrameIndex: z.number().int().min(0).max(599).optional(),
  timestampMs: z.number().int().safe().min(0).optional(),
};
export const artifactReviewAnchorSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('image-region'), ...region, ...animationFrame }).strict(),
    z.object({ kind: z.literal('image-point'), ...point, ...animationFrame }).strict(),
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
    if (anchor.kind !== 'video-range') {
      if (
        (anchor.frameIndex === undefined) !== (anchor.timestampMs === undefined) ||
        (anchor.endFrameIndex !== undefined &&
          (anchor.frameIndex === undefined || anchor.endFrameIndex < anchor.frameIndex))
      )
        context.addIssue({ code: 'custom', message: 'GIF frame and timestamp must name the same selection' });
      return;
    }
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

/** Explicit media read: one immutable original and bounded visual evidence, separate from paged review text. */
export const artifactReviewMediaEvidenceSchema = z
  .object({
    asset: reviewedMediaAssetSchema,
    originalPath: z.string().min(1).max(8192),
    anchor: artifactReviewAnchorSchema.optional(),
    images: z
      .array(
        z
          .object({
            purpose: z.enum(['frame', 'crop']),
            mimeType: z.literal('image/png'),
            data: z.string().min(1).max(4_000_000),
          })
          .strict(),
      )
      .max(2),
    trust: z.literal('untrusted_review_data'),
  })
  .strict();

export const mediaModificationSelectionItemSchema = z
  .object({
    id,
    selection: artifactReviewAnchorSchema,
    instruction: z.string().trim().min(1).max(4000).optional(),
  })
  .strict();
