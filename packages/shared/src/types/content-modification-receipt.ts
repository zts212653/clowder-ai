import { z } from 'zod';

export const contentModificationReceiptFollowUpV1Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('cat_woken'), executionRef: z.string().min(1).max(2048).optional() }).strict(),
  z
    .object({
      kind: z.literal('none'),
      reason: z.enum(['task_closed', 'owner_changed', 'not_applicable']),
    })
    .strict(),
  z.object({ kind: z.literal('unverified') }).strict(),
]);

const contentModificationReceiptBaseV1 = {
  v: z.literal(1),
  requestId: z.string().regex(/^f309-modification-[a-f0-9]{64}$/),
  sourceMessageId: z.string().trim().min(1).max(256),
  targetCatId: z.string().trim().min(1).max(256),
  taskId: z.string().trim().min(1).max(256),
  receiptRef: z.string().min(1).max(2048),
  observedAt: z.number().int().nonnegative().safe(),
  followUp: contentModificationReceiptFollowUpV1Schema,
};
const contentModificationCandidateRef = z.string().min(1).max(1000);

/** Immutable Host-authored chat pointer. Canonical candidate/decision truth stays behind requestId. */
export const contentModificationReceiptV1Schema = z
  .discriminatedUnion('state', [
    z
      .object({
        ...contentModificationReceiptBaseV1,
        state: z.literal('candidate'),
        candidateRef: contentModificationCandidateRef,
      })
      .strict(),
    z
      .object({
        ...contentModificationReceiptBaseV1,
        state: z.literal('rejected'),
        candidateRef: contentModificationCandidateRef,
      })
      .strict(),
    z
      .object({
        ...contentModificationReceiptBaseV1,
        state: z.literal('applied'),
        candidateRef: contentModificationCandidateRef,
      })
      .strict(),
    z
      .object({
        ...contentModificationReceiptBaseV1,
        state: z.literal('conflict'),
        candidateRef: contentModificationCandidateRef,
      })
      .strict(),
    z
      .object({
        ...contentModificationReceiptBaseV1,
        state: z.literal('approved'),
        candidateRef: contentModificationCandidateRef,
      })
      .strict(),
    z
      .object({
        ...contentModificationReceiptBaseV1,
        state: z.literal('changes_requested'),
        candidateRef: contentModificationCandidateRef,
      })
      .strict(),
    z
      .object({
        ...contentModificationReceiptBaseV1,
        state: z.literal('unknown'),
        candidateRef: contentModificationCandidateRef.optional(),
      })
      .strict(),
  ])
  .superRefine((receipt, ctx) => {
    if (
      !['conflict', 'unknown'].includes(receipt.state) &&
      (receipt.followUp.kind !== 'none' || receipt.followUp.reason !== 'not_applicable')
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['followUp'],
        message: 'Ordinary candidate and decision receipts never start an acknowledgement invocation',
      });
    }
  });
export type ContentModificationReceiptV1 = z.infer<typeof contentModificationReceiptV1Schema>;
