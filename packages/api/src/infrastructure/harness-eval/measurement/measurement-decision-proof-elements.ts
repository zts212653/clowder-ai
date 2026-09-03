import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const featureId = z.string().regex(/^F\d{3}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256');
const exposureState = z.enum(['exposed', 'not_exposed']);

/**
 * The individual claims a decision proof can carry.
 *
 * Each one is a separate owner object with its own bytes and hash, so a proof is assembled from
 * independently verifiable pieces rather than asserted as a whole. Kept apart from the proof/record
 * envelopes so the pieces can be read without the union noise around them.
 */

export const OwnerEvidenceRefSchema = z
  .object({
    ownerFeatureId: featureId,
    ref: nonEmpty,
    sha256,
  })
  .strict();

export const CohortWindowSchema = z
  .object({
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
  })
  .strict()
  .refine(({ startMs, endMs }) => startMs < endMs, {
    message: 'cohort window must be a non-empty half-open window',
  });

export const DecisionProofSubjectSchema = z
  .object({
    certificateId: nonEmpty,
    certificateRef: nonEmpty,
    certificateSha256: sha256,
    resultId: nonEmpty,
    resultRef: nonEmpty,
    resultSha256: sha256,
    evaluationCohortRef: nonEmpty,
    evaluationCohortSha256: sha256,
  })
  .strict();

export const EvidenceRoleProofSchema = z
  .object({
    cohortRef: nonEmpty,
    cohortSha256: sha256,
    roles: z
      .array(z.enum(['discovery', 'attribution', 'validation']))
      .min(1)
      .refine((roles) => new Set(roles).size === roles.length, {
        message: 'evidence roles must be unique',
      }),
    proof: OwnerEvidenceRefSchema,
  })
  .strict();

/**
 * Owner-declared layer discrimination. Optional, and deliberately NOT part of `missingProofs`: a
 * proof can be fully verified while the owner still cannot separate the layers. Absent means the
 * consumer must stay at `unresolved`, never that every layer discriminates.
 */
export const LayerDiscriminationProofSchema = z
  .object({
    cohortRef: nonEmpty,
    cohortSha256: sha256,
    layers: z
      .array(z.enum(['execution', 'harness', 'rubric', 'observation']))
      .min(1)
      .refine((layers) => new Set(layers).size === layers.length, {
        message: 'discriminated layers must be unique',
      }),
    proof: OwnerEvidenceRefSchema,
  })
  .strict();

/**
 * Owner-published structured intervention card. Optional and outside `missingProofs`: a decision
 * proof is about evidence validity, not about whether anyone proposed a change.
 */
export const InterventionCardProofSchema = z
  .object({
    cardId: nonEmpty,
    /**
     * The owner's record that this card's gate conditions were met. It must be owner-held:
     * authorisation to change something cannot be evidence the changer wrote for itself.
     */
    gateReceiptId: nonEmpty,
    competingAttributionIds: z
      .array(nonEmpty)
      .min(2)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'competing attributions must be unique' }),
    causalHypothesisId: nonEmpty,
    expectedDeltaId: nonEmpty,
    guardrailMetricIds: z.array(nonEmpty).min(1),
    replayCohortSha256: sha256,
    interventionFalsifierId: nonEmpty,
    rubricReopenTriggerId: nonEmpty,
    costId: nonEmpty,
    rollbackId: nonEmpty,
    proof: OwnerEvidenceRefSchema,
  })
  .strict();

export const ConsumerConsumptionProofSchema = z
  .object({
    consumerFeatureId: featureId,
    consumerOwnerCatId: nonEmpty,
    resultId: nonEmpty,
    consumedAt: z.string().datetime(),
    receipt: OwnerEvidenceRefSchema,
  })
  .strict();

export const OptimizerExposureProofSchema = z
  .object({
    cohortRef: nonEmpty,
    cohortSha256: sha256,
    candidateSelection: exposureState,
    rubricSelection: exposureState,
    proof: OwnerEvidenceRefSchema,
  })
  .strict();

export const SealedHoldoutSchema = z
  .object({
    kind: z.literal('sealed'),
    sealedAtMs: z.number().int().nonnegative(),
    optimizerSelectionCutoffMs: z.number().int().nonnegative(),
    seal: OwnerEvidenceRefSchema,
  })
  .strict();

export const TimeFreshHoldoutSchema = z
  .object({
    kind: z.literal('time_fresh'),
    optimizerSelectionCutoffMs: z.number().int().nonnegative(),
  })
  .strict();

export const PromotionHoldoutProofSchema = z
  .object({
    cohortRef: nonEmpty,
    cohortSha256: sha256,
    window: CohortWindowSchema,
    independence: z.discriminatedUnion('kind', [SealedHoldoutSchema, TimeFreshHoldoutSchema]),
    optimizerExposure: z
      .object({
        candidateSelection: exposureState,
        rubricSelection: exposureState,
      })
      .strict(),
    proof: OwnerEvidenceRefSchema,
  })
  .strict();
