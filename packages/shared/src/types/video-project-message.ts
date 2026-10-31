import { z } from 'zod';
import {
  videoProjectCanvasRegionSchema,
  videoProjectReviewRegionSchema,
  videoProjectReviewTargetSchema,
} from './video-project-review.js';
import { videoProjectFrozenInputSchema } from './video-project-screening.js';

const id = z.string().trim().min(1).max(256);
const revision = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const videoProjectMediaRangeSchema = z
  .object({ startPts: z.number().int().safe(), endPts: z.number().int().safe() })
  .strict()
  .refine(({ startPts, endPts }) => endPts > startPts, 'Media selection must be a nonempty half-open range');
export const videoProjectScreeningSelectionSchema = z
  .object({
    id,
    mediaRange: videoProjectMediaRangeSchema,
    target: videoProjectReviewTargetSchema,
    displayRegion: videoProjectReviewRegionSchema.optional(),
    canvasRegion: videoProjectCanvasRegionSchema.optional(),
    comment: z.string().trim().min(1).max(8000).optional(),
  })
  .strict();
export const projectScreeningContextAttachmentSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal('project-screening'),
    id,
    title: z.string().trim().min(1).max(1000),
    contentRef: id,
    screeningId: id,
    input: videoProjectFrozenInputSchema,
    media: videoProjectFrozenInputSchema,
    selections: z.array(videoProjectScreeningSelectionSchema).min(1).max(12),
  })
  .strict()
  .refine(
    (attachment) =>
      new Set(attachment.selections.map((selection) => selection.id)).size === attachment.selections.length,
    'Selection IDs must be unique',
  );
export type ProjectScreeningContextAttachment = z.infer<typeof projectScreeningContextAttachmentSchema>;
export type VideoProjectScreeningSelection = z.infer<typeof videoProjectScreeningSelectionSchema>;

export const videoProjectMessageSourceSchema = z
  .object({
    threadId: id,
    messageId: id,
    messageRevision: revision,
    attachmentId: id,
    selectionId: id,
    visibility: z.enum(['public', 'whisper']),
    whisperTo: z.array(id).max(100),
  })
  .strict();
export const videoProjectMessageContextSchema = z
  .object({
    source: videoProjectMessageSourceSchema,
    screeningId: id,
    input: videoProjectFrozenInputSchema,
    media: videoProjectFrozenInputSchema,
    selection: videoProjectScreeningSelectionSchema,
    /** Projection only: the immutable source facts above never change when its message is edited/withdrawn. */
    sourceState: z.enum(['current', 'changed', 'unavailable']).optional(),
  })
  .strict();
export type VideoProjectMessageContext = z.infer<typeof videoProjectMessageContextSchema>;
