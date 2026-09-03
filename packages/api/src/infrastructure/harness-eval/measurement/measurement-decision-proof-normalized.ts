import type { MeasurementBundleCertificate, MeasurementBundleResult } from './measurement-bundle-schema.js';
import type { MeasurementDecisionProof } from './measurement-decision-proof-schema.js';

/**
 * F267 owner-contract repair — the normalized projection of a verified decision proof.
 *
 * The proof record addresses its certificate, result and cohorts by REPOSITORY PATH plus sha256,
 * because those are what F267's own reader opens. A cross-feature consumer cannot use a path as an
 * identity: it is not stable under a file move, it is not an owner ref, and a consumer that wrapped
 * one as if it were would be manufacturing owner identity. Consumers previously had no honest way to
 * name the very things the proof is about, so they could only ever report "owner refs missing".
 *
 * This projection is what the owner publishes instead. Every ref below is derived from bytes the
 * owner already recorded — an id the owner assigned, or a content address over the owner's own
 * sha256. Nothing is defaulted and nothing is invented; when an identity cannot be expressed safely
 * the whole projection fails closed rather than emitting a malformed ref.
 *
 * Compatibility: additive only. Historical certificate/result `schemaVersion: 1`, component and
 * version-set hashes, and `InterventionCard.holdout` bytes are untouched and unread here — free-text
 * holdout may describe a plan, and this projection never lets it stand in for the structured
 * promotion-independence proof.
 *
 * Authority: `verified` is about the evidence chain, not about the measurement. This projection
 * carries `measurementDecisionStatus` through unchanged, so a verified proof over an insufficient
 * measurement stays insufficient and can never authorize an action.
 */

export const NORMALIZED_MEASUREMENT_DECISION_SCHEMA_VERSION = 1;

export interface MeasurementOwnerRefV1 {
  ownerFeatureId: string;
  ownerStateRef: string;
}

export type NormalizedUncertaintyBasisV1 = 'interval' | 'power' | 'not_estimable';
export type NormalizedAttributionLayerV1 = 'execution' | 'harness' | 'rubric' | 'observation';

/** A versioned asset identity, in the shape a cross-feature consumer can compare for equality. */
export interface NormalizedAssetVersionRefV1 extends MeasurementOwnerRefV1 {
  version: string;
  assetKind: string;
  assetId: string;
}

export interface NormalizedMeasurementDecisionV1 {
  schemaVersion: typeof NORMALIZED_MEASUREMENT_DECISION_SCHEMA_VERSION;
  /** The owner's verdict about the MEASUREMENT. Orthogonal to the proof's `verified`. */
  measurementDecisionStatus: 'usable' | 'insufficient';
  certificateRef: MeasurementOwnerRefV1;
  resultRef: MeasurementOwnerRefV1;
  evaluationCohortRef: MeasurementOwnerRefV1;
  /** Absent when the owner published no structured optimizer-exposure proof. */
  exposureProofRef?: MeasurementOwnerRefV1;
  /** Absent when the owner published no structured promotion holdout. */
  promotionHoldoutRef?: MeasurementOwnerRefV1;
  /**
   * Whether the promotion holdout was exposed to candidate or rubric selection. Absent — not
   * `false` — when the owner published no exposure facts, so a consumer cannot read silence as safe.
   */
  holdoutOptimizerExposed?: boolean;
  /** The weakest uncertainty basis across the primary-loss metrics, with the artifact that states it. */
  uncertainty?: { evidenceRef: MeasurementOwnerRefV1; basis: NormalizedUncertaintyBasisV1 };
  /** Absent unless the owner's result declares a baseline; never defaulted to the cohort. */
  baselineRef?: MeasurementOwnerRefV1;
  /**
   * Layers this cohort's evidence can tell apart from the others, as declared by the measurement's
   * owner. Absent — not empty — when the owner made no such claim, so a consumer cannot read
   * silence as "nothing discriminates" any more than as "everything does".
   */
  discriminatingLayers?: NormalizedAttributionLayerV1[];
  /** The owner object backing the discrimination claim, for lineage. */
  discriminationProofRef?: MeasurementOwnerRefV1;
  /**
   * The RULER this measurement was actually scored with, read from the certificate's own decision
   * procedure. A consumer asking "did the ruler move between rounds" must compare what the owner
   * used, not what a caller says was used. Absent when the certificate declares no single rubric
   * component — zero means there is nothing to compare, and more than one means the consumer must
   * not pick.
   */
  rubricRef?: NormalizedAssetVersionRefV1;
  /**
   * Identity of the whole decision procedure. Two results with different version sets were not
   * produced the same way even when the rubric component happens to match.
   */
  decisionProcedureVersionSetHash: string;
  /** Absent unless the owner published a structured card. Absent means the gate stays closed. */
  interventionCard?: NormalizedInterventionCardV1;
}

/**
 * The card, with every element named by a ref a consumer can carry into its own gate. Present only
 * when the owner published the structured card; the legacy free-text card never produces this.
 */
export interface NormalizedInterventionCardV1 {
  cardRef: MeasurementOwnerRefV1;
  competingAttributionRefs: MeasurementOwnerRefV1[];
  causalHypothesisRef: MeasurementOwnerRefV1;
  expectedDeltaRef: MeasurementOwnerRefV1;
  guardrailRefs: MeasurementOwnerRefV1[];
  replayCohortRef: MeasurementOwnerRefV1;
  interventionFalsifierRef: MeasurementOwnerRefV1;
  rubricReopenTriggerRef: MeasurementOwnerRefV1;
  costRef: MeasurementOwnerRefV1;
  rollbackRef: MeasurementOwnerRefV1;
  gateReceiptRef: MeasurementOwnerRefV1;
}

export type NormalizedMeasurementDecisionResult =
  | { status: 'normalized'; decision: NormalizedMeasurementDecisionV1 }
  | { status: 'unnormalizable'; reason: 'proof_identity_unnormalizable' };

/**
 * An owner ref must survive being written into a consumer's canonical `kind:id` slot. Characters
 * that would break that shape mean the identity cannot be expressed, which is a fail-closed
 * condition — not a licence to sanitise the owner's id into something that no longer addresses it.
 */
const REF_ID_PATTERN = /^[^\s{}[\]"']+$/;

function ownerRef(ownerFeatureId: string, kind: string, id: string): MeasurementOwnerRefV1 | undefined {
  if (!REF_ID_PATTERN.test(id) || !REF_ID_PATTERN.test(kind)) return undefined;
  return { ownerFeatureId, ownerStateRef: `${kind}:${id}` };
}

/** Ordered weakest-first: one not-estimable primary loss makes the whole decision not estimable. */
const BASIS_RANK: Record<NormalizedUncertaintyBasisV1, number> = { not_estimable: 0, power: 1, interval: 2 };

function weakestPrimaryLossBasis(result: MeasurementBundleResult): NormalizedUncertaintyBasisV1 | undefined {
  let weakest: NormalizedUncertaintyBasisV1 | undefined;
  for (const metric of result.metrics) {
    if (metric.role !== 'primary_loss') continue;
    const basis = metric.uncertainty.kind;
    if (weakest === undefined || BASIS_RANK[basis] < BASIS_RANK[weakest]) weakest = basis;
  }
  return weakest;
}

function normalizeRubric(
  certificate: MeasurementBundleCertificate,
  ownerFeatureId: string,
): { ok: true; ref?: NormalizedAssetVersionRefV1 } | { ok: false } {
  const rubrics = certificate.decisionProcedure.components.filter((component) => component.kind === 'rubric');
  const only = rubrics.length === 1 ? rubrics[0] : undefined;
  if (only === undefined) return { ok: true };
  const base = ownerRef(ownerFeatureId, 'measurement-rubric', only.name);
  if (!base || !REF_ID_PATTERN.test(only.version)) return { ok: false };
  return { ok: true, ref: { ...base, version: only.version, assetKind: 'rubric', assetId: only.name } };
}

function normalizeCard(
  proof: MeasurementDecisionProof,
  ownerFeatureId: string,
): { ok: true; ref?: NormalizedInterventionCardV1 } | { ok: false } {
  const card = proof.interventionCard;
  if (card === undefined) return { ok: true };
  const one = (kind: string, id: string) => ownerRef(card.proof.ownerFeatureId, kind, id);
  const many = (kind: string, ids: readonly string[]) => ids.map((id) => one(kind, id));
  const cardRef = one('intervention-card', card.cardId);
  const competingAttributionRefs = many('competing-attribution', card.competingAttributionIds);
  const causalHypothesisRef = one('causal-hypothesis', card.causalHypothesisId);
  const expectedDeltaRef = one('expected-delta', card.expectedDeltaId);
  const guardrailRefs = many('guardrail-metric', card.guardrailMetricIds);
  const replayCohortRef = one('measurement-cohort', card.replayCohortSha256);
  const interventionFalsifierRef = one('intervention-falsifier', card.interventionFalsifierId);
  const rubricReopenTriggerRef = one('rubric-reopen-trigger', card.rubricReopenTriggerId);
  const costRef = one('intervention-cost', card.costId);
  const rollbackRef = one('rollback-plan', card.rollbackId);
  const gateReceiptRef = one('intervention-gate-receipt', card.gateReceiptId);
  const every = [
    cardRef,
    causalHypothesisRef,
    expectedDeltaRef,
    replayCohortRef,
    interventionFalsifierRef,
    rubricReopenTriggerRef,
    costRef,
    rollbackRef,
    gateReceiptRef,
    ...competingAttributionRefs,
    ...guardrailRefs,
  ];
  if (every.some((ref) => ref === undefined)) return { ok: false };
  return {
    ok: true,
    ref: {
      cardRef: cardRef as MeasurementOwnerRefV1,
      competingAttributionRefs: competingAttributionRefs as MeasurementOwnerRefV1[],
      causalHypothesisRef: causalHypothesisRef as MeasurementOwnerRefV1,
      expectedDeltaRef: expectedDeltaRef as MeasurementOwnerRefV1,
      guardrailRefs: guardrailRefs as MeasurementOwnerRefV1[],
      replayCohortRef: replayCohortRef as MeasurementOwnerRefV1,
      interventionFalsifierRef: interventionFalsifierRef as MeasurementOwnerRefV1,
      rubricReopenTriggerRef: rubricReopenTriggerRef as MeasurementOwnerRefV1,
      costRef: costRef as MeasurementOwnerRefV1,
      rollbackRef: rollbackRef as MeasurementOwnerRefV1,
      gateReceiptRef: gateReceiptRef as MeasurementOwnerRefV1,
    },
  };
}

export function normalizeMeasurementDecisionProof(input: {
  proof: MeasurementDecisionProof;
  result: MeasurementBundleResult;
  certificate: MeasurementBundleCertificate;
  ownerFeatureId: string;
}): NormalizedMeasurementDecisionResult {
  const { proof, result, certificate, ownerFeatureId } = input;
  const subject = proof.subject;
  const certificateRef = ownerRef(ownerFeatureId, 'measurement-certificate', subject.certificateId);
  const resultRef = ownerRef(ownerFeatureId, 'measurement-result', subject.resultId);
  // The evaluation cohort has no owner-assigned id, only a path and a sha256. The sha256 IS an
  // identity the owner already committed to, so the cohort is content-addressed rather than
  // path-addressed; two proofs over the same cohort bytes therefore name the same cohort.
  const evaluationCohortRef = ownerRef(ownerFeatureId, 'measurement-cohort', subject.evaluationCohortSha256);
  if (!certificateRef || !resultRef || !evaluationCohortRef) {
    return { status: 'unnormalizable', reason: 'proof_identity_unnormalizable' };
  }

  const exposure = proof.optimizerExposure;
  const holdout = proof.promotionHoldout;
  const exposureProofRef = exposure
    ? ownerRef(exposure.proof.ownerFeatureId, 'exposure-proof', exposure.proof.sha256)
    : undefined;
  const promotionHoldoutRef = holdout
    ? ownerRef(holdout.proof.ownerFeatureId, 'promotion-holdout', holdout.cohortSha256)
    : undefined;
  if ((exposure && !exposureProofRef) || (holdout && !promotionHoldoutRef)) {
    return { status: 'unnormalizable', reason: 'proof_identity_unnormalizable' };
  }

  const discrimination = proof.layerDiscrimination;
  const discriminationProofRef = discrimination
    ? ownerRef(discrimination.proof.ownerFeatureId, 'layer-discrimination', discrimination.proof.sha256)
    : undefined;
  if (discrimination && !discriminationProofRef) {
    return { status: 'unnormalizable', reason: 'proof_identity_unnormalizable' };
  }

  const card = normalizeCard(proof, ownerFeatureId);
  if (!card.ok) return { status: 'unnormalizable', reason: 'proof_identity_unnormalizable' };

  const rubric = normalizeRubric(certificate, ownerFeatureId);
  if (!rubric.ok) return { status: 'unnormalizable', reason: 'proof_identity_unnormalizable' };

  const basis = weakestPrimaryLossBasis(result);
  const baseline = result.baseline;
  const baselineRef = baseline ? ownerRef(ownerFeatureId, 'measurement-baseline', baseline.sha256) : undefined;
  if (baseline && !baselineRef) return { status: 'unnormalizable', reason: 'proof_identity_unnormalizable' };

  return {
    status: 'normalized',
    decision: {
      schemaVersion: NORMALIZED_MEASUREMENT_DECISION_SCHEMA_VERSION,
      measurementDecisionStatus: subject.measurementDecisionStatus,
      certificateRef,
      resultRef,
      evaluationCohortRef,
      ...(exposureProofRef === undefined ? {} : { exposureProofRef }),
      ...(promotionHoldoutRef === undefined ? {} : { promotionHoldoutRef }),
      ...(holdout === undefined
        ? {}
        : {
            holdoutOptimizerExposed:
              holdout.optimizerExposure.candidateSelection === 'exposed' ||
              holdout.optimizerExposure.rubricSelection === 'exposed',
          }),
      ...(discrimination === undefined
        ? {}
        : { discriminatingLayers: [...discrimination.layers], discriminationProofRef }),
      ...(card.ref === undefined ? {} : { interventionCard: card.ref }),
      ...(rubric.ref === undefined ? {} : { rubricRef: rubric.ref }),
      decisionProcedureVersionSetHash: certificate.decisionProcedure.versionSetHash,
      ...(basis === undefined ? {} : { uncertainty: { evidenceRef: resultRef, basis } }),
      ...(baselineRef === undefined ? {} : { baselineRef }),
    },
  };
}
