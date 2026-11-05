import { createHash } from 'node:crypto';
import { type ContentModificationRecord, contentModificationRequestContractSchema } from '@cat-cafe/shared';
import { z } from 'zod';
import { modificationCancellationSchema } from '../control/cancellation-store.js';
import { ContentModificationJournalError } from '../journal-errors.js';

export const contentModificationJournalIdSchema = z.string().min(1).max(256);
const revision = z.number().int().positive().safe();
export const contentModificationMessageRevisionSchema = z
  .string()
  .regex(/^sha256:[a-f0-9]{64}$/) as z.ZodType<`sha256:${string}`>;

const sourceVisibilitySchema = z
  .discriminatedUnion('visibility', [
    z.object({ visibility: z.literal('public') }).strict(),
    z
      .object({
        visibility: z.literal('whisper'),
        whisperTo: z.array(contentModificationJournalIdSchema).min(1).max(100),
      })
      .strict(),
  ])
  .refine(
    (value) => value.visibility !== 'whisper' || new Set(value.whisperTo).size === value.whisperTo.length,
    'Whisper recipients must be unique',
  );

const preparedSchema = z.union([
  z
    .object({
      kind: z.literal('project'),
      contentRef: contentModificationJournalIdSchema,
      ownerRevision: revision,
      ledgerRef: contentModificationJournalIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('media'),
      contentRef: contentModificationJournalIdSchema,
      ownerRevision: revision,
      ledgerRef: contentModificationJournalIdSchema.optional(),
      legacyReview: z.object({ reviewId: contentModificationJournalIdSchema, round: revision }).strict().optional(),
    })
    .strict()
    .refine(
      (value) => Boolean(value.ledgerRef) !== Boolean(value.legacyReview),
      'One canonical discussion owner is required',
    ),
  z
    .object({
      kind: z.literal('text'),
      reviewId: contentModificationJournalIdSchema,
      sourceRevision: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    })
    .strict(),
]);

export const contentModificationProgressSchema = z
  .object({
    sourceMessageId: contentModificationJournalIdSchema.optional(),
    sourceMessageRevision: contentModificationMessageRevisionSchema.optional(),
    sourceAttachmentId: z.string().trim().min(1).max(128).optional(),
    takeoverOperationIds: z.array(z.string().uuid()).optional(),
    sourceKind: z.enum(['generated_request', 'human_message']).optional(),
    sourceVisibility: sourceVisibilitySchema.optional(),
    prepared: preparedSchema.optional(),
    task: z
      .object({
        taskId: contentModificationJournalIdSchema,
        revision,
        receiptRef: contentModificationJournalIdSchema,
      })
      .strict()
      .optional(),
    review: z
      .object({
        reviewId: contentModificationJournalIdSchema,
        round: revision.optional(),
        receiptRef: z.string().min(1).max(2048),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ContentModificationProgress = z.infer<typeof contentModificationProgressSchema>;

export function modificationRequestId(ownerUserId: string, operationId: string): string {
  return `f309-modification-${createHash('sha256')
    .update(JSON.stringify(['f309-modification-v1', ownerUserId, operationId]))
    .digest('hex')}`;
}

export function modificationMessageRequestId(
  ownerUserId: string,
  sourceMessageId: string,
  attachmentId?: string,
): string {
  return `f309-modification-${createHash('sha256')
    .update(
      JSON.stringify(
        attachmentId === undefined
          ? ['f309-message-modification-v1', ownerUserId, sourceMessageId]
          : ['f309-message-attachment-modification-v1', ownerUserId, sourceMessageId, attachmentId],
      ),
    )
    .digest('hex')}`;
}

export function modificationOperationKeys(requestId: string) {
  if (!/^f309-modification-[a-f0-9]{64}$/.test(requestId)) {
    throw new ContentModificationJournalError('invalid_progress');
  }
  const base = `f309-modification:${requestId.slice('f309-modification-'.length)}`;
  return {
    source: `${base}:source`,
    snapshot: `${base}:snapshot`,
    admit: `${base}:admit`,
    request: `${base}:request`,
  };
}

export function parseContentModificationRecord(body: string): ContentModificationRecord {
  const record = JSON.parse(body) as ContentModificationRecord;
  return {
    ...record,
    payload: contentModificationRequestContractSchema.parse(record.payload),
    progress: contentModificationProgressSchema.parse(record.progress),
    ...(record.control ? { control: modificationCancellationSchema.parse(record.control) } : {}),
  };
}
