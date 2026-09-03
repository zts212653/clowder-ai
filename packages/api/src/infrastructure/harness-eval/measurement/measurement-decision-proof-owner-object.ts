import { z } from 'zod';

const nonEmpty = z.string().trim().min(1);
const featureId = z.string().regex(/^F\d{3}$/);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/, 'must be a lowercase SHA-256');
const exposureState = z.enum(['exposed', 'not_exposed']);
const evidenceRole = z.enum(['discovery', 'attribution', 'validation']);
const attributionLayer = z.enum(['execution', 'harness', 'rubric', 'observation']);

const OwnerEvidenceRefSchema = z
  .object({
    ownerFeatureId: featureId,
    ref: nonEmpty,
    sha256,
  })
  .strict();

const CohortWindowSchema = z
  .object({
    startMs: z.number().int().nonnegative(),
    endMs: z.number().int().positive(),
  })
  .strict()
  .refine(({ startMs, endMs }) => startMs < endMs, {
    message: 'cohort window must be a non-empty half-open window',
  });

const base = {
  kind: z.literal('f267-measurement-decision-proof-owner-object'),
  schemaVersion: z.literal(1),
  ownerUserId: nonEmpty,
  ownerFeatureId: featureId,
};

const EvidenceRoleOwnerObjectSchema = z
  .object({
    ...base,
    objectType: z.literal('evidence_role'),
    cohortRef: nonEmpty,
    cohortSha256: sha256,
    roles: z
      .array(evidenceRole)
      .min(1)
      .refine((roles) => new Set(roles).size === roles.length, {
        message: 'evidence roles must be unique',
      }),
  })
  .strict();

/**
 * Which layers this cohort's evidence can actually tell APART from the others.
 *
 * Only the measurement's owner can say this: it depends on how the cohort was constructed and what
 * varies within it. A consumer that assumed discrimination from the mere presence of evidence would
 * be manufacturing the one fact that separates "we have evidence about four layers" from "we know
 * which layer it was".
 */
const LayerDiscriminationOwnerObjectSchema = z
  .object({
    ...base,
    objectType: z.literal('layer_discrimination'),
    cohortRef: nonEmpty,
    cohortSha256: sha256,
    layers: z
      .array(attributionLayer)
      .min(1)
      .refine((layers) => new Set(layers).size === layers.length, {
        message: 'discriminated layers must be unique',
      }),
  })
  .strict();

/**
 * The structured intervention card.
 *
 * The historical `InterventionCard` is free text end to end, and those bytes stay exactly as they
 * are: they may still describe an intervention plan. What free text cannot do is serve as PROOF —
 * a sentence saying "we held out last week's traffic" is not a promotion-independence guarantee, and
 * a consumer cannot resolve a paragraph. So a card that wants to open Change Review publishes this
 * alongside, naming each element by an id the owner assigned. Additive: absent means the gate stays
 * closed, never that the legacy card counts.
 */
const InterventionCardOwnerObjectSchema = z
  .object({
    ...base,
    objectType: z.literal('intervention_card'),
    cardId: nonEmpty,
    /**
     * The owner's record that this card's gate conditions were met. It must be owner-held:
     * authorisation to change something cannot be evidence the changer wrote for itself.
     */
    gateReceiptId: nonEmpty,
    /** At least two, because a card with one explanation has not competed anything. */
    competingAttributionIds: z
      .array(nonEmpty)
      .min(2)
      .refine((ids) => new Set(ids).size === ids.length, { message: 'competing attributions must be unique' }),
    causalHypothesisId: nonEmpty,
    expectedDeltaId: nonEmpty,
    guardrailMetricIds: z.array(nonEmpty).min(1),
    replayCohortSha256: sha256,
    /** Both falsifiers. One that can retire the intervention, one that can reopen the ruler. */
    interventionFalsifierId: nonEmpty,
    rubricReopenTriggerId: nonEmpty,
    costId: nonEmpty,
    rollbackId: nonEmpty,
  })
  .strict();

const ConsumerConsumptionOwnerObjectSchema = z
  .object({
    ...base,
    objectType: z.literal('consumer_consumption'),
    consumerFeatureId: featureId,
    consumerOwnerCatId: nonEmpty,
    resultId: nonEmpty,
    consumedAt: z.string().datetime(),
  })
  .strict();

const OptimizerExposureOwnerObjectSchema = z
  .object({
    ...base,
    objectType: z.literal('optimizer_exposure'),
    cohortRef: nonEmpty,
    cohortSha256: sha256,
    candidateSelection: exposureState,
    rubricSelection: exposureState,
  })
  .strict();

const PromotionHoldoutCohortOwnerObjectSchema = z
  .object({
    ...base,
    objectType: z.literal('promotion_holdout_cohort'),
    cohortRef: nonEmpty,
    window: CohortWindowSchema,
  })
  .strict();

const SealedIndependenceSchema = z
  .object({
    kind: z.literal('sealed'),
    sealedAtMs: z.number().int().nonnegative(),
    optimizerSelectionCutoffMs: z.number().int().nonnegative(),
    seal: OwnerEvidenceRefSchema,
  })
  .strict();

const TimeFreshIndependenceSchema = z
  .object({
    kind: z.literal('time_fresh'),
    optimizerSelectionCutoffMs: z.number().int().nonnegative(),
  })
  .strict();

const PromotionHoldoutOwnerObjectSchema = z
  .object({
    ...base,
    objectType: z.literal('promotion_holdout'),
    cohortRef: nonEmpty,
    cohortSha256: sha256,
    window: CohortWindowSchema,
    independence: z.discriminatedUnion('kind', [SealedIndependenceSchema, TimeFreshIndependenceSchema]),
    optimizerExposure: z
      .object({
        candidateSelection: exposureState,
        rubricSelection: exposureState,
      })
      .strict(),
  })
  .strict();

const PromotionHoldoutSealOwnerObjectSchema = z
  .object({
    ...base,
    objectType: z.literal('promotion_holdout_seal'),
    cohortRef: nonEmpty,
    cohortSha256: sha256,
    sealedAtMs: z.number().int().nonnegative(),
    optimizerSelectionCutoffMs: z.number().int().nonnegative(),
  })
  .strict();

export const MeasurementDecisionProofOwnerObjectSchema = z.discriminatedUnion('objectType', [
  EvidenceRoleOwnerObjectSchema,
  LayerDiscriminationOwnerObjectSchema,
  InterventionCardOwnerObjectSchema,
  ConsumerConsumptionOwnerObjectSchema,
  OptimizerExposureOwnerObjectSchema,
  PromotionHoldoutCohortOwnerObjectSchema,
  PromotionHoldoutOwnerObjectSchema,
  PromotionHoldoutSealOwnerObjectSchema,
]);

export type MeasurementDecisionProofOwnerObject = z.infer<typeof MeasurementDecisionProofOwnerObjectSchema>;
