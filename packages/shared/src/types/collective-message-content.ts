import { z } from 'zod';

/** Immutable owner references only. Private drafts, signed URLs and bytes never enter an event. */
export const collectiveMessageAttachmentSchema = z
  .object({
    v: z.literal(1),
    attachmentId: z.string().regex(/^att_[A-Za-z0-9_-]{8,120}$/),
    contentRef: z.string().startsWith('collective-attachment:').max(240),
    ownerRevision: z.literal(1),
    ownerReceiptRef: z.string().trim().min(1).max(240),
    blobDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    byteLength: z
      .number()
      .int()
      .positive()
      .max(50 * 1024 * 1024),
    mediaType: z
      .string()
      .regex(/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/)
      .max(120),
    fileName: z
      .string()
      .trim()
      .min(1)
      .max(240)
      .refine((value) => !/[\u0000-\u001f\u007f/\\]/u.test(value)),
  })
  .strict();
export type CollectiveMessageAttachment = z.infer<typeof collectiveMessageAttachmentSchema>;

export const collectiveAttachmentScopeSchema = z
  .object({
    serviceInstanceId: z.string().regex(/^svc_[A-Za-z0-9_-]{8,150}$/),
    collectiveId: z.string().regex(/^col_[A-Za-z0-9_-]{8,150}$/),
    humanId: z.string().regex(/^human_[A-Za-z0-9_-]{8,150}$/),
    channelId: z.string().trim().min(1).max(160),
    attachmentId: collectiveMessageAttachmentSchema.shape.attachmentId,
  })
  .strict();
export type CollectiveAttachmentScope = z.infer<typeof collectiveAttachmentScopeSchema>;
export const collectiveDraftSendReceiptSchema = z
  .object({
    revision: z.number().int().positive().safe(),
    rootEventId: z.string().trim().min(1).max(160).optional(),
  })
  .strict();

export const collectiveMessageContentFields = {
  body: z.string().trim().max(32_000),
  attachments: z.array(collectiveMessageAttachmentSchema).min(1).max(12).optional(),
};

export function requireCollectiveMessageContent(
  content: { body: string; attachments?: readonly CollectiveMessageAttachment[] },
  context: z.RefinementCtx,
) {
  if (!content.body && !content.attachments?.length)
    context.addIssue({ code: 'custom', path: ['body'], message: 'A message needs text or content' });
  if (new Set(content.attachments?.map((item) => item.attachmentId)).size !== (content.attachments?.length ?? 0))
    context.addIssue({ code: 'custom', path: ['attachments'], message: 'Duplicate attachment reference' });
}
