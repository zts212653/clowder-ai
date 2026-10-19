import { z } from 'zod';
import { mediaModificationSelectionItemSchema, reviewedMediaTypeSchema } from './artifact-review-media.js';
import { contentModificationSourceSchema } from './content-modification.js';
import { messageMediaPublicationSourceSchema } from './media-publication-source.js';

const id = z.string().trim().min(1).max(128);
const ownerId = z.string().trim().min(1).max(256);
const revision = z.number().int().positive().safe();
/** Navigation only. The selected work still uses its independent, version-bound source below. */
export const mediaGalleryOriginSchema = messageMediaPublicationSourceSchema
  .pick({ threadId: true, messageId: true, messageRevision: true, item: true })
  .extend({ index: z.number().int().min(0).max(10000), count: z.number().int().min(1).max(10001) })
  .strict()
  .refine((value) => value.index < value.count, 'Gallery position must be inside its original message group');
export type MediaGalleryOrigin = z.infer<typeof mediaGalleryOriginSchema>;
/** References owner truth; preview images and the original Human body stay in ordinary message blocks. */
export const MediaContextAttachmentSchema = z
  .object({
    v: z.literal(1),
    id,
    kind: z.literal('media'),
    title: z.string().trim().min(1).max(300),
    mediaType: reviewedMediaTypeSchema,
    source: contentModificationSourceSchema,
    gallery: mediaGalleryOriginSchema.optional(),
    selections: z.array(mediaModificationSelectionItemSchema).max(12),
    taskContext: z
      .object({
        kind: z.literal('media'),
        taskId: ownerId,
        expectedTaskRevision: revision,
        reviewId: ownerId,
        expectedReviewRevision: revision,
        round: revision,
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (new Set(value.selections.map((item) => item.id)).size !== value.selections.length)
      ctx.addIssue({ code: 'custom', path: ['selections'], message: 'Media selection ids must be unique' });
    for (const [i, item] of value.selections.entries()) {
      if ((value.mediaType === 'video/mp4') !== (item.selection.kind === 'video-range'))
        ctx.addIssue({ code: 'custom', path: ['selections', i], message: 'Selection media type differs' });
    }
    if (
      value.source.kind === 'artifact-review' &&
      value.taskContext &&
      (value.taskContext.reviewId !== value.source.reviewId ||
        value.taskContext.round !== value.source.round ||
        value.taskContext.expectedReviewRevision !== value.source.expectedReviewRevision)
    )
      ctx.addIssue({ code: 'custom', path: ['taskContext'], message: 'Task context must identify the source round' });
  });
export type MediaContextAttachment = z.infer<typeof MediaContextAttachmentSchema>;
