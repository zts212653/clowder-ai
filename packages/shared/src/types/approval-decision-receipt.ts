import { z } from 'zod';
import { APPROVAL_PRODUCER_IDS } from '../approval-producer-catalog.js';

/** Host-written decision facts only; proposal content never belongs in this carrier. */
export const approvalDecisionReceiptV1Schema = z
  .object({
    v: z.literal(1),
    kind: z.literal('approval_decision_receipt'),
    producerId: z.enum(APPROVAL_PRODUCER_IDS),
    canonicalProposalId: z.string().min(1),
    resolution: z.enum(['accepted', 'rejected']),
    approvalCardRef: z.object({ threadId: z.string().min(1), messageId: z.string().min(1) }).strict(),
    requesterCatId: z.string().min(1),
    decidedAt: z.number().finite().nonnegative(),
    decidedBy: z.string(),
    rejectionReason: z.string().max(500).optional(),
  })
  .strict();

export type ApprovalDecisionReceiptV1 = z.infer<typeof approvalDecisionReceiptV1Schema>;
