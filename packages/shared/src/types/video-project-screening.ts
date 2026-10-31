import { z } from 'zod';
import { immutableMediaSchema } from './artifact-review-media.js';
import {
  videoProjectActorSchema,
  videoProjectDigestSchema,
  videoProjectIdSchema,
  videoProjectPositiveSchema,
  videoProjectTextSchema,
  videoProjectTickSchema,
  videoProjectTimestampSchema,
} from './video-project-primitives.js';

/** The referenced input must already exist; owner authorization and history binding are server checks. */
export const videoProjectFrozenInputSchema = z
  .object({
    contentRef: videoProjectIdSchema,
    ownerRevision: videoProjectPositiveSchema,
    blobDigest: videoProjectDigestSchema,
  })
  .strict();
export type VideoProjectFrozenInput = z.infer<typeof videoProjectFrozenInputSchema>;

const refs = z.array(videoProjectIdSchema).min(1).max(1000);
const pts = z.number().int().safe();
const rotation = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
export const videoProjectScreeningMappingSegmentSchema = z
  .object({
    mediaStartPts: pts,
    mediaEndPts: pts,
    projectStartTick: videoProjectTickSchema,
    projectEndTick: videoProjectPositiveSchema,
    refs,
  })
  .strict()
  .superRefine((segment, ctx) => {
    if (segment.mediaEndPts <= segment.mediaStartPts)
      ctx.addIssue({ code: 'custom', path: ['mediaEndPts'], message: 'Media mapping must be nonempty' });
    if (segment.projectEndTick <= segment.projectStartTick)
      ctx.addIssue({ code: 'custom', path: ['projectEndTick'], message: 'Project mapping must be nonempty' });
  });
export type VideoProjectScreeningMappingSegment = z.infer<typeof videoProjectScreeningMappingSegmentSchema>;

export const videoProjectScreeningFrameSchema = z
  .object({
    displayWidth: videoProjectPositiveSchema,
    displayHeight: videoProjectPositiveSchema,
    canvasWidth: videoProjectPositiveSchema,
    canvasHeight: videoProjectPositiveSchema,
    /** Clockwise canvas-to-display rotation; display coordinates have already been decoded. */
    rotation,
    /** Content pixels within the decoded display; omitted means the entire display has content. */
    contentRect: z
      .object({
        x: z.number().finite().nonnegative(),
        y: z.number().finite().nonnegative(),
        width: z.number().finite().positive(),
        height: z.number().finite().positive(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((frame, ctx) => {
    if (
      frame.contentRect &&
      (frame.contentRect.x + frame.contentRect.width > frame.displayWidth ||
        frame.contentRect.y + frame.contentRect.height > frame.displayHeight)
    )
      ctx.addIssue({ code: 'custom', path: ['contentRect'], message: 'Content pixels exceed decoded display' });
  });
export type VideoProjectScreeningFrame = z.infer<typeof videoProjectScreeningFrameSchema>;

export const videoProjectScreeningSchema = z
  .object({
    id: videoProjectIdSchema,
    title: videoProjectTextSchema(1000),
    input: videoProjectFrozenInputSchema,
    media: videoProjectFrozenInputSchema
      .extend({
        byteLength: videoProjectPositiveSchema,
        media: immutableMediaSchema.options[1],
      })
      .strict(),
    mapping: z
      .object({
        segments: z.array(videoProjectScreeningMappingSegmentSchema).max(10000),
        frame: videoProjectScreeningFrameSchema,
      })
      .strict(),
    actor: videoProjectActorSchema,
    at: videoProjectTimestampSchema,
    operationId: videoProjectIdSchema,
    refs,
  })
  .strict()
  .superRefine((screening, ctx) => {
    const probe = screening.media.media;
    const end = probe.startTick + probe.durationTicks;
    if (!Number.isSafeInteger(end))
      ctx.addIssue({ code: 'custom', path: ['media', 'media'], message: 'Media stream end must be safe' });
    const frame = screening.mapping.frame;
    if (frame.displayWidth !== probe.width || frame.displayHeight !== probe.height)
      ctx.addIssue({ code: 'custom', path: ['mapping', 'frame'], message: 'Frame must match frozen decoded display' });
    let previousMediaEnd: number | undefined;
    screening.mapping.segments.forEach((segment, index) => {
      if (segment.mediaStartPts < probe.startTick || segment.mediaEndPts > end)
        ctx.addIssue({ code: 'custom', path: ['mapping', 'segments', index], message: 'Mapping exceeds video stream' });
      if (previousMediaEnd !== undefined && segment.mediaStartPts < previousMediaEnd)
        ctx.addIssue({
          code: 'custom',
          path: ['mapping', 'segments', index],
          message: 'Media mappings must be ordered and nonoverlapping',
        });
      previousMediaEnd = segment.mediaEndPts;
    });
    const projectPieces = screening.mapping.segments
      .map((segment, index) => ({ segment, index }))
      .sort((a, b) => a.segment.projectStartTick - b.segment.projectStartTick);
    for (let i = 1; i < projectPieces.length; i++) {
      if (projectPieces[i].segment.projectStartTick < projectPieces[i - 1].segment.projectEndTick)
        ctx.addIssue({
          code: 'custom',
          path: ['mapping', 'segments', projectPieces[i].index],
          message: 'Project mappings must not overlap; inverse position would be ambiguous',
        });
    }
  });
export type VideoProjectScreening = z.infer<typeof videoProjectScreeningSchema>;

export const videoProjectScreeningsSchema = z
  .array(videoProjectScreeningSchema)
  .max(10000)
  .superRefine((items, ctx) => {
    for (const field of ['id', 'operationId'] as const) {
      const seen = new Set<string>();
      items.forEach((item, index) => {
        if (seen.has(item[field]))
          ctx.addIssue({ code: 'custom', path: [index, field], message: 'Screening fact must be unique' });
        seen.add(item[field]);
      });
    }
  });
