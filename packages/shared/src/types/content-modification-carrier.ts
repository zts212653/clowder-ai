import { z } from 'zod';

const id = z.string().trim().min(1).max(256);
const requestId = z.string().regex(/^f309-modification-[a-f0-9]{64}$/);
const receiptRef = z.string().min(1).max(2048);

/** Typed source envelope for an executable request bound to its canonical modification journal. */
export const contentModificationRequestCarrierV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.enum(['request_text_edit', 'request_image_edit', 'request_media_edit', 'supersede_request']),
    requestId,
    sourceMessageId: id,
    targetCatId: id,
    taskId: id,
    expectedTaskRevision: z.number().int().positive().safe(),
    requestReceiptRef: receiptRef,
  })
  .strict();
export type ContentModificationRequestCarrierV1 = z.infer<typeof contentModificationRequestCarrierV1Schema>;

/** Executable platform publication. Its outbox source remains distinct from the original Human receipt. */
export const contentModificationPublicationCarrierV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal('resume_media_publication'),
    returnRef: receiptRef,
    requestId,
    sourceMessageId: id,
    sourceMessageRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    requestReceiptRef: receiptRef,
    taskId: id,
    targetCatId: id,
    expectedTaskRevision: z.number().int().positive().safe(),
    reviewId: id,
    round: z.number().int().positive().safe(),
    contentRef: id,
    ownerRevision: z.number().int().positive().safe(),
    publicationMessageId: id,
    publicationRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    publicationItemId: id,
    artifactRef: z.string().startsWith('/uploads/').max(1000),
    artifactRevision: z.string().regex(/^\d+$/),
    producingInvocationId: id,
  })
  .strict();
export type ContentModificationPublicationCarrierV1 = z.infer<typeof contentModificationPublicationCarrierV1Schema>;

/** Typed source envelope for an executable conflict/unknown follow-up. */
export const contentModificationFollowUpCarrierV1Schema = z
  .object({
    v: z.literal(1),
    requestId,
    sourceMessageId: id,
    targetCatId: id,
    taskId: id,
    candidateRef: z.string().min(1).max(1000).optional(),
    receiptRef,
    state: z.enum(['conflict', 'unknown']),
  })
  .strict();
export type ContentModificationFollowUpCarrierV1 = z.infer<typeof contentModificationFollowUpCarrierV1Schema>;

/** A completed file effect returns the original owner for verification; it never grants Task closure. */
export const contentTextWritebackCompletionCarrierV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal('text_writeback_completion'),
    returnRef: receiptRef,
    requestId,
    closureRequestId: requestId,
    sourceMessageId: id,
    taskId: id,
    targetCatId: id,
    observedTaskRevision: z.number().int().positive().safe(),
    expectedSignal: z.string().min(1).max(512),
    candidateRef: z.string().min(1).max(1000),
    humanReceiptRef: receiptRef,
    writebackReceiptRef: receiptRef,
    writtenRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict()
  .refine((carrier) => carrier.expectedSignal === `${carrier.closureRequestId}#file-writeback-applied`, {
    message: 'Completion signal must name the admitted request',
  });
export type ContentTextWritebackCompletionCarrierV1 = z.infer<typeof contentTextWritebackCompletionCarrierV1Schema>;
