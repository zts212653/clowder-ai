import {
  type EvolutionAttributionVerdictV1,
  type EvolutionGateBlockerCodeV1,
  type EvolutionGateBlockerV1,
  type EvolutionProgramEventV1,
  type OwnerTruthRefV1,
  refIdentity,
} from '@cat-cafe/shared';
import { CONTROL_PLANE_FEATURE_ID } from './eval-reasons.js';
import type { AttributionAssessment } from './program-eval-bridge.js';

/**
 * F311 Phase 3 — the only door into Change Review.
 *
 * A write-back suggestion may leave the Program only when an owner-held intervention card carries
 * competing attributions, a causal hypothesis, an expected delta, guardrails, a replay cohort, an
 * independent sealed holdout, BOTH falsifiers (`intervention_falsifier` + `rubric_reopen_trigger`)
 * and cost/rollback. Anything missing keeps the Program on the zero-approval `observe` /
 * `insufficient` lane; the gate never copies the card, it only checks refs.
 */

/** Single truth source: the closed blocker vocabulary lives in shared. */
export type InterventionGateBlockerCode = EvolutionGateBlockerCodeV1;

export interface InterventionGateBlocker {
  code: InterventionGateBlockerCode;
  message: string;
  ownerFeatureId: string;
  ownerStateRef?: string;
}

export interface OwnerHeldInterventionCardRefs {
  cardRef: OwnerTruthRefV1;
  competingAttributionRefs?: OwnerTruthRefV1[];
  causalHypothesisRef?: OwnerTruthRefV1;
  expectedDeltaRef?: OwnerTruthRefV1;
  guardrailRefs?: OwnerTruthRefV1[];
  replayCohortRef?: OwnerTruthRefV1;
  promotionHoldoutRef?: OwnerTruthRefV1;
  holdoutExposureProofRef?: OwnerTruthRefV1;
  holdoutOptimizerExposed?: boolean;
  interventionFalsifierRef?: OwnerTruthRefV1;
  rubricReopenTriggerRef?: OwnerTruthRefV1;
  costRef?: OwnerTruthRefV1;
  rollbackRef?: OwnerTruthRefV1;
}

/**
 * What the gate needs to know about the diagnosis — and nothing more. Deliberately the durable
 * shape, so the gate can be driven from the event stream instead of from a caller's claim.
 */
export interface AttributionGateView {
  verdict: EvolutionAttributionVerdictV1;
  disposition: 'intervention_candidate' | 'no_intervention';
  attributionRef: OwnerTruthRefV1;
}

export const toAttributionGateView = (assessment: AttributionAssessment): AttributionGateView => ({
  verdict: assessment.verdict,
  disposition: assessment.disposition,
  attributionRef: assessment.event.attributionRef,
});

export interface InterventionGateInput {
  attribution: AttributionGateView;
  card?: OwnerHeldInterventionCardRefs;
  interventionLayerRef?: OwnerTruthRefV1;
  gateReceiptRef?: OwnerTruthRefV1;
}

export interface InterventionGateVerdict {
  status: 'ready' | 'blocked';
  blockers: InterventionGateBlocker[];
  /** Plain-language sentences for the F307 surface: why we are not changing anything yet. */
  whyNotChange: string[];
  event?: Extract<EvolutionProgramEventV1, { type: 'intervention_linked' }>;
  /**
   * Proposal only: the zero-approval lane the Program should take instead. The F192 `autoRecheckRef`
   * is attached by the trigger bridge at append time — this gate never invents owner refs.
   */
  fallbackEvent?: {
    type: 'observe_or_insufficient_recorded';
    result: 'observe' | 'insufficient';
    /** Codes plus provenance: who has to move for this blocker to clear. */
    gateBlockers: EvolutionGateBlockerV1[];
  };
}

/**
 * Closed wording table. Blocker codes are persisted on the zero-approval event, so the surface can
 * re-render the same sentences after a restart without storing any prose.
 */
export const INTERVENTION_GATE_BLOCKER_TEXT: Record<InterventionGateBlockerCode, string> = {
  attribution_not_actionable: '归因结论还不足以支持改动。',
  intervention_card_missing: '还没有 owner 持有的 intervention card，不能进入 Change Review。',
  intervention_card_not_owner_held: 'intervention card 必须由 F267/source owner 持有，F311 只能引用。',
  competing_attributions_missing: '至少要写下两个不同的竞争归因，否则等于没有排除别的解释。',
  causal_hypothesis_missing: '缺少因果假设：说不清“为什么这么改会有用”。',
  expected_delta_missing: '缺少预期变化：改完了也不知道该看到什么。',
  guardrails_missing: '缺少护栏指标：只盯主指标会把别处改坏。',
  replay_cohort_missing: '缺少 replay cohort：改动前后无法在同一批样本上复判。',
  promotion_holdout_missing: '缺少独立 holdout：没法验证改动能不能推广。',
  promotion_holdout_contaminated: 'promotion holdout 已被 replay cohort 复用或被优化过程看过，不能再当独立验证。',
  holdout_exposure_proof_missing: '缺少 holdout 未被看过的证明。',
  holdout_exposure_status_missing: '没有声明 holdout 有没有被优化过程看过；未声明按未知处理，不放行。',
  intervention_falsifier_missing: '缺少 intervention falsifier：说不出“什么结果算这次干预失败”。',
  rubric_reopen_trigger_missing: '缺少 rubric reopen trigger：说不出“什么结果说明是尺子的问题”。',
  cost_missing: '缺少成本页：不知道这次改动要花多少。',
  rollback_missing: '缺少回滚方案：改坏了退不回来。',
  intervention_layer_missing: '没有指明这次干预落在哪一层资产上。',
  gate_receipt_missing: '缺少 owner 侧 intervention gate 回执。',
  gate_evidence_not_owner_held: '这份放行证据由 F311 自持；干预授权不能自证。',
};

const blocker = (
  code: InterventionGateBlockerCode,
  ref?: OwnerTruthRefV1,
  detail?: string,
): InterventionGateBlocker => ({
  code,
  message:
    detail === undefined
      ? INTERVENTION_GATE_BLOCKER_TEXT[code]
      : `${INTERVENTION_GATE_BLOCKER_TEXT[code]}（${detail}）`,
  ownerFeatureId: ref?.ownerFeatureId ?? 'F267',
  ...(ref === undefined ? {} : { ownerStateRef: ref.ownerStateRef }),
});

const REQUIRED_SINGLE_REFS: Array<[keyof OwnerHeldInterventionCardRefs, InterventionGateBlockerCode]> = [
  ['causalHypothesisRef', 'causal_hypothesis_missing'],
  ['expectedDeltaRef', 'expected_delta_missing'],
  ['replayCohortRef', 'replay_cohort_missing'],
  ['promotionHoldoutRef', 'promotion_holdout_missing'],
  ['holdoutExposureProofRef', 'holdout_exposure_proof_missing'],
  ['interventionFalsifierRef', 'intervention_falsifier_missing'],
  ['rubricReopenTriggerRef', 'rubric_reopen_trigger_missing'],
  ['costRef', 'cost_missing'],
  ['rollbackRef', 'rollback_missing'],
];

function cardBlockers(card: OwnerHeldInterventionCardRefs): InterventionGateBlocker[] {
  const blockers: InterventionGateBlocker[] = [];
  if (card.cardRef.ownerFeatureId === CONTROL_PLANE_FEATURE_ID) {
    blockers.push(blocker('intervention_card_not_owner_held', card.cardRef));
  }
  // Identity, not count: the same attribution listed twice is one explanation, not two.
  const competing = new Set((card.competingAttributionRefs ?? []).map(refIdentity));
  if (competing.size < 2) {
    blockers.push(blocker('competing_attributions_missing', card.cardRef));
  }
  if ((card.guardrailRefs ?? []).length === 0) {
    blockers.push(blocker('guardrails_missing', card.cardRef));
  }
  for (const [field, code] of REQUIRED_SINGLE_REFS) {
    if (card[field] === undefined) blockers.push(blocker(code, card.cardRef));
  }
  const holdout = card.promotionHoldoutRef;
  // Fail closed: an undeclared exposure status is "we do not know", never "it is clean".
  if (holdout !== undefined && card.holdoutOptimizerExposed === undefined) {
    blockers.push(blocker('holdout_exposure_status_missing', holdout));
  }
  const contaminated =
    holdout !== undefined &&
    (card.holdoutOptimizerExposed === true ||
      (card.replayCohortRef !== undefined && refIdentity(holdout) === refIdentity(card.replayCohortRef)));
  if (contaminated) {
    blockers.push(blocker('promotion_holdout_contaminated', holdout));
  }
  blockers.push(...selfCertifiedEvidence(card));
  return blockers;
}

/**
 * F311 may not self-certify the evidence that authorises a write-back. The economics page is the
 * one legitimate exception: the Owner Matrix gives F311 the Program's own cost page. Everything
 * else — falsifiers, holdout, guardrails, cohorts, hypothesis, expected delta, rollback — belongs
 * to an owner, and a card whose evidence all points back at F311 proves nothing.
 */
function selfCertifiedEvidence(card: OwnerHeldInterventionCardRefs): InterventionGateBlocker[] {
  const ownerHeld: Array<[string, OwnerTruthRefV1 | undefined]> = [
    ['causal hypothesis', card.causalHypothesisRef],
    ['expected delta', card.expectedDeltaRef],
    ['replay cohort', card.replayCohortRef],
    ['promotion holdout', card.promotionHoldoutRef],
    ['holdout exposure proof', card.holdoutExposureProofRef],
    ['intervention falsifier', card.interventionFalsifierRef],
    ['rubric reopen trigger', card.rubricReopenTriggerRef],
    ['rollback plan', card.rollbackRef],
    ...(card.competingAttributionRefs ?? []).map(
      (ref, index) => [`competing attribution #${index + 1}`, ref] as [string, OwnerTruthRefV1],
    ),
    ...(card.guardrailRefs ?? []).map((ref, index) => [`guardrail #${index + 1}`, ref] as [string, OwnerTruthRefV1]),
  ];
  return ownerHeld
    .filter(([, ref]) => ref !== undefined && ref.ownerFeatureId === CONTROL_PLANE_FEATURE_ID)
    .map(([label, ref]) => blocker('gate_evidence_not_owner_held', ref, label));
}

function attributionBlockers(attribution: AttributionGateView): InterventionGateBlocker[] {
  if (attribution.verdict === 'attributed' && attribution.disposition === 'intervention_candidate') return [];
  const detail: Record<AttributionGateView['verdict'], string> = {
    attributed: '结论尚未指向需要干预',
    unresolved: '还没确诊：多层并列或证据无法区分，现在改就是碰运气',
    insufficient: '本轮度量证据不足，先补证据再谈改动',
    incomparable: '旧尺与新尺不可比，先做冻结 cohort 的 2×2 复判或重建 baseline',
  };
  return [
    blocker(
      'attribution_not_actionable',
      { ownerFeatureId: 'F311', ownerStateRef: attribution.attributionRef.ownerStateRef },
      detail[attribution.verdict],
    ),
  ];
}

export function evaluateInterventionGate(input: InterventionGateInput): InterventionGateVerdict {
  const blockers = [...attributionBlockers(input.attribution)];
  if (input.card === undefined) {
    blockers.push(blocker('intervention_card_missing'));
  } else {
    blockers.push(...cardBlockers(input.card));
    if (input.interventionLayerRef === undefined) {
      blockers.push(blocker('intervention_layer_missing'));
    }
    if (input.gateReceiptRef === undefined) {
      blockers.push(blocker('gate_receipt_missing'));
    } else if (input.gateReceiptRef.ownerFeatureId === CONTROL_PLANE_FEATURE_ID) {
      blockers.push(blocker('gate_evidence_not_owner_held', input.gateReceiptRef, 'gate receipt'));
    }
  }

  if (blockers.length === 0 && input.card !== undefined) {
    return {
      status: 'ready',
      blockers: [],
      whyNotChange: [],
      event: {
        type: 'intervention_linked',
        interventionCardRef: input.card.cardRef,
        interventionLayerRef: input.interventionLayerRef as OwnerTruthRefV1,
        gateReceiptRef: input.gateReceiptRef as OwnerTruthRefV1,
      },
    };
  }

  const evidenceUnusable = input.attribution.verdict === 'insufficient' || input.attribution.verdict === 'incomparable';
  return {
    status: 'blocked',
    blockers,
    whyNotChange: blockers.map((entry) => entry.message),
    fallbackEvent: {
      type: 'observe_or_insufficient_recorded',
      result: evidenceUnusable ? 'insufficient' : 'observe',
      gateBlockers: [...new Map(blockers.map((entry) => [entry.code, entry])).values()].map((entry) => ({
        code: entry.code,
        ownerFeatureId: entry.ownerFeatureId,
      })),
    },
  };
}
