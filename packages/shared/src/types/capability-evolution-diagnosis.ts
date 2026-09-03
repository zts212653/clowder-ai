// biome-ignore-all format: Compact contract block, mirroring the Program state machine's style.
import { z } from 'zod';
import { assetVersionRefV1Schema, bounded, ownerTruthRefV1Schema, strictEvent } from './capability-evolution-refs.js';

/**
 * F311 Phase 3 — the durable, typed diagnosis snapshot (AC-31/AC-34).
 *
 * F311 owns its own attribution conclusion, so it must survive restart and replay: without it the
 * Workbench could only re-show "something happened" after a restart. Everything here is an enum, a
 * code or an owner ref — no rubric text, cohort rows, scores or verdict payload. `notAssessedLayers`
 * is deliberately absent: it is derived as (all layers − assessedLayers) so "nobody looked" can
 * never drift into a stored claim of "ruled out".
 *
 * The reason and blocker vocabularies are CLOSED enums and live here, in one shared truth source:
 * an open string would let an unknown code reach the F307 surface verbatim and be rendered as if
 * the Program had understood it.
 */

export const EVOLUTION_ATTRIBUTION_LAYERS = ['execution', 'harness', 'rubric', 'observation'] as const;
export const EVOLUTION_ATTRIBUTION_VERDICTS = ['attributed', 'unresolved', 'insufficient', 'incomparable'] as const;
export const EVOLUTION_UNCERTAINTY_BASES = ['interval', 'power', 'not_estimable', 'unknown'] as const;
export const EVOLUTION_COMPARABILITY_MODES = ['unchanged', 'two_by_two_rejudge', 'baseline_rebuild', 'none'] as const;
export const EVOLUTION_COMPARABILITY_STATUSES = ['comparable', 'incomparable'] as const;

// biome-ignore format: One code per concept; the closed list is the contract.
export const EVOLUTION_EVAL_REASON_CODES = [
  'f311_cannot_own_evidence', 'owner_declared_insufficient', 'frozen_cohort_missing', 'baseline_missing',
  'exposure_proof_missing', 'uncertainty_evidence_missing', 'uncertainty_not_estimable',
  'rubric_version_changed_without_rejudge', 'rubric_version_missing', 'rejudge_incomplete', 'rejudge_cell_reused',
  'rejudge_duplicate_cell', 'rejudge_cohort_drift', 'attribution_candidate_without_evidence',
  'no_discriminating_evidence', 'competing_layers_tied', 'measurement_insufficient', 'comparison_incomparable',
] as const;

// biome-ignore format: One code per gate condition; the closed list is the contract.
export const EVOLUTION_GATE_BLOCKER_CODES = [
  'attribution_not_actionable', 'intervention_card_missing', 'intervention_card_not_owner_held',
  'competing_attributions_missing', 'causal_hypothesis_missing', 'expected_delta_missing', 'guardrails_missing',
  'replay_cohort_missing', 'promotion_holdout_missing', 'promotion_holdout_contaminated',
  'holdout_exposure_proof_missing', 'holdout_exposure_status_missing', 'intervention_falsifier_missing',
  'rubric_reopen_trigger_missing', 'cost_missing', 'rollback_missing', 'intervention_layer_missing',
  'gate_receipt_missing', 'gate_evidence_not_owner_held',
] as const;

const layerSchema = z.enum(EVOLUTION_ATTRIBUTION_LAYERS);
const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;

/** Blocker provenance: which owner has to move for this to clear. Never assumed to be F311. */
export const evolutionGateBlockerV1Schema = z
  .object({ code: z.enum(EVOLUTION_GATE_BLOCKER_CODES), ownerFeatureId: bounded(120) })
  .strict();

export const attributionDiagnosisV1Schema = z
  .object({
    verdict: z.enum(EVOLUTION_ATTRIBUTION_VERDICTS),
    primaryLayer: layerSchema.optional(),
    assessedLayers: z.array(layerSchema).max(4),
    competingLayers: z.array(layerSchema).max(4),
    // Asset refs are admissible evidence: which rubric VERSION was used is part of the evidence,
    // and dropping the asset identity to fit a narrower ref type would erase exactly that.
    evidenceRefs: z.array(z.union([assetVersionRefV1Schema, ownerTruthRefV1Schema])).min(1).max(128),
    uncertaintyBasis: z.enum(EVOLUTION_UNCERTAINTY_BASES),
    comparabilityMode: z.enum(EVOLUTION_COMPARABILITY_MODES),
    /** Persisted, never re-derived from the verdict: a partial 2×2 is incomparable in `two_by_two_rejudge` mode. */
    comparabilityStatus: z.enum(EVOLUTION_COMPARABILITY_STATUSES),
    reasonCodes: z.array(z.enum(EVOLUTION_EVAL_REASON_CODES)).max(32),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (!unique(value.assessedLayers)) issue('assessedLayers', 'each layer may be assessed once');
    if (!unique(value.competingLayers)) issue('competingLayers', 'each competing layer may appear once');
    if (!unique(value.reasonCodes)) issue('reasonCodes', 'reason codes must be unique');
    if ((value.verdict === 'attributed') !== (value.primaryLayer !== undefined))
      issue('primaryLayer', 'a primary layer exists exactly when the verdict is attributed');
    if (value.primaryLayer !== undefined && !value.assessedLayers.includes(value.primaryLayer))
      issue('primaryLayer', 'the primary layer must have been assessed');
    if (value.competingLayers.some((layer) => !value.assessedLayers.includes(layer)))
      issue('competingLayers', 'competing layers must have been assessed');
    if (value.verdict === 'incomparable' && value.comparabilityStatus !== 'incomparable')
      issue('comparabilityStatus', 'an incomparable verdict requires incomparable comparability');
    if (value.comparabilityMode === 'none' && value.comparabilityStatus === 'comparable')
      issue('comparabilityStatus', 'a moved ruler with no rejudge or rebuild is never comparable');
  });

/**
 * The measurement outcome carries WHY, not just a verdict flag. A bare `insufficient` replays as an
 * unexplained empty state, and the surface then has to guess a reason — which is how "no baseline"
 * became "F267 judged it insufficient".
 */
export const measurementLinkedEventV1Schema = strictEvent({
  type: z.literal('measurement_linked'),
  measurementResultRef: ownerTruthRefV1Schema,
  validity: z.enum(['valid', 'insufficient']),
  reasonCodes: z.array(z.enum(EVOLUTION_EVAL_REASON_CODES)).max(32),
  evidenceRefs: z.array(z.union([assetVersionRefV1Schema, ownerTruthRefV1Schema])).max(128),
  uncertaintyBasis: z.enum(EVOLUTION_UNCERTAINTY_BASES),
  /**
   * The ruler this round was scored with, as the owner declared it. Persisted so the NEXT round can
   * ask "did the ruler move" against what was actually used, instead of against whatever a caller
   * says the previous rubric was. Optional: a certificate need not name exactly one rubric component,
   * and rounds recorded before this field existed have none.
   */
  rubricRef: assetVersionRefV1Schema.optional(),
});

export const attributionLinkedEventV1Schema = strictEvent({
  type: z.literal('attribution_linked'),
  attributionRef: ownerTruthRefV1Schema,
  disposition: z.enum(['intervention_candidate', 'no_intervention']),
  diagnosis: attributionDiagnosisV1Schema,
});

export const observeOrInsufficientEventV1Schema = strictEvent({
  type: z.literal('observe_or_insufficient_recorded'),
  result: z.enum(['observe', 'insufficient']),
  autoRecheckRef: ownerTruthRefV1Schema,
  /** Why the zero-approval lane was taken; human wording is generated at read time from the codes. */
  gateBlockers: z.array(evolutionGateBlockerV1Schema).min(1).max(32),
});

export type EvolutionAttributionLayerV1 = (typeof EVOLUTION_ATTRIBUTION_LAYERS)[number];
export type EvolutionAttributionVerdictV1 = (typeof EVOLUTION_ATTRIBUTION_VERDICTS)[number];
export type EvolutionUncertaintyBasisV1 = (typeof EVOLUTION_UNCERTAINTY_BASES)[number];
export type EvolutionComparabilityModeV1 = (typeof EVOLUTION_COMPARABILITY_MODES)[number];
export type EvolutionComparabilityStatusV1 = (typeof EVOLUTION_COMPARABILITY_STATUSES)[number];
export type EvolutionEvalReasonCodeV1 = (typeof EVOLUTION_EVAL_REASON_CODES)[number];
export type EvolutionGateBlockerCodeV1 = (typeof EVOLUTION_GATE_BLOCKER_CODES)[number];
export type EvolutionGateBlockerV1 = z.infer<typeof evolutionGateBlockerV1Schema>;
export type AttributionDiagnosisV1 = z.infer<typeof attributionDiagnosisV1Schema>;