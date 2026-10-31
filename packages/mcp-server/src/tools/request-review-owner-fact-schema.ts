import { exactAssetVersionRefV1Schema, ownerTruthRefV1Schema } from '@cat-cafe/shared';
import { z } from 'zod';

export const requestReviewOwnerFactSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('changed'),
      proposalId: z.string().trim().min(1),
      assetVersionRef: exactAssetVersionRefV1Schema,
      mainCommitSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
      loadedRuntimeRef: ownerTruthRefV1Schema,
      changedAt: z.string().datetime({ offset: true }),
      loadedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      type: z.literal('no_change'),
      proposalId: z.string().trim().min(1),
      reasonCode: z.enum([
        'evidence_already_satisfied',
        'risk_exceeds_benefit',
        'target_retired',
        'blocked_external',
        'other',
      ]),
      withdrawalCondition: z.string().trim().min(1).max(4_000),
      nextEvalAt: z.string().datetime({ offset: true }),
      recordedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      type: z.literal('evidence'),
      proposalId: z.string().trim().min(1),
      assetVersionRef: exactAssetVersionRefV1Schema,
      role: z.enum(['comparison_baseline', 'candidate_independent_verification', 'post_adoption_observation']),
      evidenceRef: ownerTruthRefV1Schema,
      proofRef: ownerTruthRefV1Schema,
      status: z.enum(['verified', 'insufficient']),
      label: z.string().trim().min(1).max(400).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('fresh_outcome'),
      proposalId: z.string().trim().min(1),
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
      measuredAt: z.string().datetime({ offset: true }),
      uncontaminated: z.boolean(),
    })
    .strict(),
  z
    .object({
      type: z.literal('rollback'),
      proposalId: z.string().trim().min(1),
      interventionReceiptRef: ownerTruthRefV1Schema,
      restoredVersionRef: exactAssetVersionRefV1Schema,
      mainCommitSha: z.string().regex(/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/),
      loadedRuntimeRef: ownerTruthRefV1Schema,
      restoredAt: z.string().datetime({ offset: true }),
      loadedAt: z.string().datetime({ offset: true }),
    })
    .strict(),
]);

export const recordRequestReviewOwnerFactInputSchema = {
  fact: requestReviewOwnerFactSchema.describe(
    'One typed F100 owner fact from the exact active F266 Task/F167 carrier; rollback must cite its prior changed receipt, and changed/no_change/fresh_outcome also advances the canonical F266 lifecycle.',
  ),
};
