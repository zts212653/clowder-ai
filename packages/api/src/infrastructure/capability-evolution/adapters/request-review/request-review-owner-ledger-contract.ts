import { exactAssetVersionRefV1Schema, ownerTruthRefV1Schema, reviewSubjectRefSchema } from '@cat-cafe/shared';
import { z } from 'zod';

const nonEmpty = z.string().trim().min(1).max(2_000);
const timestamp = z.string().datetime({ offset: true });
const gitCommit = z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u);

const base = {
  schemaVersion: z.literal(1),
  eventId: nonEmpty,
  occurredAt: timestamp,
};

const dispatchReserved = z
  .object({
    ...base,
    type: z.literal('dispatch_reserved'),
    dispatchId: nonEmpty,
    proposalId: nonEmpty,
    assetVersionRef: exactAssetVersionRefV1Schema,
  })
  .strict();

const interventionChanged = z
  .object({
    ...base,
    type: z.literal('intervention_changed'),
    proposalId: nonEmpty,
    receiptRef: ownerTruthRefV1Schema,
    assetVersionRef: exactAssetVersionRefV1Schema,
    mainCommitSha: gitCommit,
    loadedRuntimeRef: ownerTruthRefV1Schema,
    changedAt: timestamp,
    loadedAt: timestamp,
  })
  .strict();

const interventionNoChange = z
  .object({
    ...base,
    type: z.literal('intervention_no_change'),
    proposalId: nonEmpty,
    receiptRef: ownerTruthRefV1Schema,
    reasonCode: z.enum([
      'evidence_already_satisfied',
      'risk_exceeds_benefit',
      'target_retired',
      'blocked_external',
      'other',
    ]),
    withdrawalCondition: nonEmpty.max(4_000),
    nextEvalAt: timestamp,
    recordedAt: timestamp,
  })
  .strict();

const freshOutcome = z
  .object({
    ...base,
    type: z.literal('fresh_outcome_recorded'),
    proposalId: nonEmpty,
    receiptRef: ownerTruthRefV1Schema,
    interventionReceiptRef: ownerTruthRefV1Schema,
    reevaluationRef: ownerTruthRefV1Schema,
    freshnessProofRef: ownerTruthRefV1Schema,
    outcome: z.enum([
      'effective_keep',
      'ineffective_tune',
      'ineffective_rollback',
      'rubric_reopen',
      'insufficient_observe',
    ]),
    loadedRuntimeRef: ownerTruthRefV1Schema.optional(),
    measuredAt: timestamp,
    uncontaminated: z.boolean(),
  })
  .strict();

const evidenceLinked = z
  .object({
    ...base,
    type: z.literal('evidence_linked'),
    proposalId: nonEmpty,
    assetVersionRef: exactAssetVersionRefV1Schema,
    role: z.enum(['comparison_baseline', 'candidate_independent_verification', 'post_adoption_observation']),
    evidenceRef: ownerTruthRefV1Schema,
    proofRef: ownerTruthRefV1Schema,
    status: z.enum(['verified', 'insufficient']),
    label: nonEmpty.max(400).optional(),
  })
  .strict();

const useReserved = z
  .object({
    ...base,
    type: z.literal('use_reserved'),
    reservationId: nonEmpty,
    assetVersionRef: exactAssetVersionRefV1Schema,
    userId: nonEmpty,
    invocationId: nonEmpty,
    threadId: nonEmpty,
    authorCatId: nonEmpty,
    reviewerCatId: nonEmpty,
    reviewSubjectRef: reviewSubjectRefSchema,
    reviewedHeadSha: gitCommit,
    acceptedSourceRef: nonEmpty,
    acceptedRevision: nonEmpty,
    consumerRef: ownerTruthRefV1Schema,
  })
  .strict();

const useDispatchBound = z
  .object({
    ...base,
    type: z.literal('use_dispatch_bound'),
    reservationId: nonEmpty,
    requestMessageId: nonEmpty,
    reviewerInvocationId: nonEmpty,
    deliveryStatus: z.enum(['attested', 'unconfirmed']),
    deliveredAssetVersionRef: exactAssetVersionRefV1Schema.optional(),
    deliveredPackageRevision: z
      .string()
      .regex(/^sha256:[a-f0-9]{64}$/u)
      .optional(),
    deliveryProofRef: ownerTruthRefV1Schema,
  })
  .strict();

const useRecorded = z
  .object({
    ...base,
    type: z.literal('use_recorded'),
    reservationId: nonEmpty,
    reviewMessageId: nonEmpty.optional(),
    dismissalReason: z.enum(['outside_local_review_scope', 'request_not_reviewable', 'route_replaced']).optional(),
    use: z.enum(['applied', 'dismissed', 'unconfirmed']),
    proofRef: ownerTruthRefV1Schema,
  })
  .strict();

const rollbackRecorded = z
  .object({
    ...base,
    type: z.literal('rollback_recorded'),
    proposalId: nonEmpty,
    receiptRef: ownerTruthRefV1Schema,
    interventionReceiptRef: ownerTruthRefV1Schema,
    restoredVersionRef: exactAssetVersionRefV1Schema,
    mainCommitSha: gitCommit,
    loadedRuntimeRef: ownerTruthRefV1Schema,
    restoredAt: timestamp,
    loadedAt: timestamp,
  })
  .strict();

const decisionRecorded = z
  .object({
    ...base,
    type: z.literal('decision_recorded'),
    proposalId: nonEmpty,
    idempotencyRef: nonEmpty,
    outcomeReceiptRef: ownerTruthRefV1Schema,
    decision: z.enum(['keep', 'tune', 'rollback', 'sunset', 'no_change']),
    decisionRef: ownerTruthRefV1Schema,
    executionReceiptRef: ownerTruthRefV1Schema.optional(),
    assetVersionRef: exactAssetVersionRefV1Schema.optional(),
  })
  .strict();

export const requestReviewOwnerEventSchema = z
  .discriminatedUnion('type', [
    dispatchReserved,
    interventionChanged,
    interventionNoChange,
    freshOutcome,
    evidenceLinked,
    useReserved,
    useDispatchBound,
    useRecorded,
    rollbackRecorded,
    decisionRecorded,
  ])
  .superRefine((event, context) => {
    if (event.type === 'use_dispatch_bound') {
      const hasVersion = event.deliveredAssetVersionRef !== undefined;
      const hasPackage = event.deliveredPackageRevision !== undefined;
      if (hasVersion !== hasPackage || (event.deliveryStatus === 'attested' && !hasVersion)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            'attested delivery requires exact asset/package revisions; optional unconfirmed delivery refs move together',
        });
      }
      return;
    }
    if (event.type === 'use_recorded') {
      const validDismissal = event.use === 'dismissed' && event.dismissalReason && !event.reviewMessageId;
      const validReview = event.use !== 'dismissed' && event.reviewMessageId && !event.dismissalReason;
      if (validDismissal || validReview) return;
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'dismissed use requires only dismissalReason; applied/unconfirmed use requires only reviewMessageId',
      });
    }
  });

export type RequestReviewOwnerEvent = z.infer<typeof requestReviewOwnerEventSchema>;
export type RequestReviewUseReservationEvent = Extract<RequestReviewOwnerEvent, { type: 'use_reserved' }>;
export type RequestReviewUseDispatchBoundEvent = Extract<RequestReviewOwnerEvent, { type: 'use_dispatch_bound' }>;
export type RequestReviewUseRecordedEvent = Extract<RequestReviewOwnerEvent, { type: 'use_recorded' }>;

export type RequestReviewOwnerLedgerAppendResult =
  | { outcome: 'appended' }
  | { outcome: 'duplicate' }
  | { outcome: 'idempotency_collision' };

export interface RequestReviewOwnerLedger {
  append(event: RequestReviewOwnerEvent): Promise<RequestReviewOwnerLedgerAppendResult>;
  read(): Promise<RequestReviewOwnerEvent[]>;
}
