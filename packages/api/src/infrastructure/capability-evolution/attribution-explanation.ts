import {
  type AttributionDiagnosisV1,
  type EvolutionEvalReasonCodeV1,
  type EvolutionGateBlockerV1,
  type OwnerTruthRefV1,
  refIdentity,
} from '@cat-cafe/shared';
import { EVOLUTION_EVAL_REASON_TEXT } from './eval-reasons.js';
import { INTERVENTION_GATE_BLOCKER_TEXT, type InterventionGateVerdict } from './intervention-gate.js';
import {
  type AttributionAssessment,
  EVOLUTION_ATTRIBUTION_LAYERS,
  type EvolutionAttributionLayer,
  type MeasurementJoinAssessment,
  type MeasurementUncertaintyBasis,
  type RubricComparabilityAssessment,
} from './program-eval-bridge.js';

/**
 * F311 Phase 3 — the plain-language projection the F307 Workbench renders (AC-34).
 *
 * It carries owner refs and derived labels only: what evidence we stand on, which explanations are
 * competing, how confident the measurement plane says we can be, which layers nobody has looked at,
 * and — when nothing is changing — why not. No rubric text, no cohort rows, no verdict payload.
 */

export const EVOLUTION_LAYER_LABELS: Record<EvolutionAttributionLayer, string> = {
  execution: '执行层：被进化的对象自己（技能、提示、代码）',
  harness: 'Harness 层：承载它运行的环境与协作契约',
  rubric: '尺子层：评判口径本身（rubric / 评分标准）',
  observation: '眼睛层：打点缺失或信号不新鲜',
};

const CONFIDENCE_LABELS: Record<MeasurementUncertaintyBasis, string> = {
  interval: '有区间估计：这次结论带着可复核的置信区间。',
  power: '有判定力分析：样本够不够、能发现多大的差别，都写清楚了。',
  not_estimable: '不确定性无法估计：这次只能当作证据不足。',
};

const EVIDENCE_LABELS: Record<string, string> = {
  'measurement-certificate': '度量出生证',
  'measurement-result': '本轮度量结果',
  'measurement-baseline': '对照 baseline',
  'frozen-cohort': '冻结 cohort',
  'uncertainty-evidence': '不确定性证据',
  'exposure-proof': '未被优化过程看过的证明',
  'rejudge-result': '换尺 2×2 复判结果',
  inv: '真实调用记录',
  rubric: '尺子版本',
};

const HEADLINES: Record<AttributionAssessment['verdict'], string> = {
  attributed: '已经能指认问题出在哪一层了。',
  unresolved: '证据还不能确诊是哪一层出的问题。',
  insufficient: '这一轮的度量证据本身就不够，先不下结论。',
  incomparable: '旧尺和新尺没法比，这一轮的分数不能拼在一起看。',
};

export interface AttributionEvidenceEntry {
  label: string;
  ownerFeatureId: string;
  ownerStateRef: string;
  /** Version and asset identity are part of the evidence: rubric v3 and v4 are two things. */
  version?: string;
  assetKind?: string;
  assetId?: string;
  /** Stable, collision-free identity for rendering and for de-duplication. */
  identity: string;
}

export interface EvolutionAttributionExplanationV1 {
  schemaVersion: 1;
  verdict: AttributionAssessment['verdict'];
  headline: string;
  primaryLayer?: { layer: EvolutionAttributionLayer; label: string };
  evidence: AttributionEvidenceEntry[];
  competingAttributions: Array<{ layer: EvolutionAttributionLayer; label: string; discriminating: boolean }>;
  notAssessedLayers: Array<{ layer: EvolutionAttributionLayer; label: string }>;
  confidence: { basis: MeasurementUncertaintyBasis | 'unknown'; label: string; ownerStateRef?: string };
  comparability: { status: RubricComparabilityAssessment['comparability']; label: string };
  whyNotChange: string[];
  /**
   * Tri-state on purpose: an attribution with no gate evaluation yet is `pending`, never `ready`.
   * Only a canonical `intervention_linked` event makes Change Review actually open.
   */
  gate: {
    status: 'pending' | 'blocked' | 'ready';
    blockers: Array<{ code: string; label: string; ownerFeatureId: string }>;
  };
}

const COMPARABILITY_LABELS: Record<RubricComparabilityAssessment['mode'], string> = {
  unchanged: '尺子没换版，前后可以直接比。',
  two_by_two_rejudge: '尺子换版了，已在冻结 cohort 上跑满旧/新尺 × 旧/新候选的 2×2 复判。',
  baseline_rebuild: '尺子换版了，已用新尺重建 baseline 再比较。',
  none: '尺子换版了，还没有 2×2 复判也没有重建 baseline。',
};

/**
 * The mode alone would lie: a partial 2×2 is still "two_by_two_rejudge" mode but nothing about it
 * is comparable yet. Status wins whenever the two disagree.
 */
function comparabilityView(
  mode: RubricComparabilityAssessment['mode'],
  status: RubricComparabilityAssessment['comparability'],
): EvolutionAttributionExplanationV1['comparability'] {
  if (status === 'comparable') return { status, label: COMPARABILITY_LABELS[mode] };
  return {
    status,
    label:
      mode === 'none' ? COMPARABILITY_LABELS.none : '尺子换版了，但这次复判/重建没有成立，暂时不可比，也不能拼接分数。',
  };
}

function evidenceLabel(ref: OwnerTruthRefV1): string {
  const kind = ref.ownerStateRef.split(':')[0] ?? ref.ownerStateRef;
  return EVIDENCE_LABELS[kind] ?? kind;
}

function dedupeEvidence(refs: readonly OwnerTruthRefV1[]): AttributionEvidenceEntry[] {
  const seen = new Set<string>();
  const entries: AttributionEvidenceEntry[] = [];
  for (const ref of refs) {
    const key = refIdentity(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    const asset = ref as OwnerTruthRefV1 & { assetKind?: string; assetId?: string };
    entries.push({
      label: evidenceLabel(ref),
      ownerFeatureId: ref.ownerFeatureId,
      ownerStateRef: ref.ownerStateRef,
      ...(ref.version === undefined ? {} : { version: ref.version }),
      ...(asset.assetKind === undefined ? {} : { assetKind: asset.assetKind }),
      ...(asset.assetId === undefined ? {} : { assetId: asset.assetId }),
      identity: key,
    });
  }
  return entries;
}

/**
 * An owner-declared `insufficient` measurement IS a result. Rendering it as "no evaluation yet"
 * would hide a real conclusion behind an empty state, which is the opposite of AC-34's honesty
 * requirement. There is no diagnosis to show — that is the point — so this is built directly from
 * the durable `measurement_linked` event.
 */
export function projectInsufficientMeasurementExplanation(input: {
  measurementResultRef: OwnerTruthRefV1;
  reasonCodes: readonly EvolutionEvalReasonCodeV1[];
  evidenceRefs: readonly OwnerTruthRefV1[];
  uncertaintyBasis: MeasurementUncertaintyBasis | 'unknown';
}): EvolutionAttributionExplanationV1 {
  const { measurementResultRef, reasonCodes, evidenceRefs, uncertaintyBasis } = input;
  return {
    schemaVersion: 1,
    verdict: 'insufficient',
    headline: HEADLINES.insufficient,
    evidence: dedupeEvidence([measurementResultRef, ...evidenceRefs]),
    competingAttributions: [],
    notAssessedLayers: EVOLUTION_ATTRIBUTION_LAYERS.map((layer) => ({
      layer,
      label: `${EVOLUTION_LAYER_LABELS[layer]}（证据不足，这一轮没有看任何一层）`,
    })),
    confidence: {
      basis: uncertaintyBasis,
      label:
        uncertaintyBasis === 'unknown' ? '证据不足，这一轮没有可用的置信边界。' : CONFIDENCE_LABELS[uncertaintyBasis],
    },
    comparability: { status: 'incomparable', label: '证据不足，本轮没有可比较的结论。' },
    // The real reasons, replayed from the event — never a guessed "the owner said so".
    whyNotChange:
      reasonCodes.length > 0
        ? reasonCodes.map((code) => EVOLUTION_EVAL_REASON_TEXT[code])
        : ['本轮度量证据不足，但事件没有记录具体原因。'],
    gate: {
      status: 'blocked',
      blockers: [
        {
          code: 'attribution_not_actionable',
          label: INTERVENTION_GATE_BLOCKER_TEXT.attribution_not_actionable,
          ownerFeatureId: 'F267',
        },
      ],
    },
  };
}

/**
 * Restart / replay path: rebuild the same explanation from the durable typed snapshot alone.
 * `notAssessedLayers` is derived here, never read from storage — the Program can say "nobody
 * looked at this layer" after a restart, and it still cannot say "we ruled it out".
 */
export function projectAttributionExplanation(input: {
  diagnosis: AttributionDiagnosisV1;
  gateBlockers?: readonly EvolutionGateBlockerV1[];
  /** Only a canonical `intervention_linked` event may report Change Review as open. */
  interventionLinked?: boolean;
}): EvolutionAttributionExplanationV1 {
  const { diagnosis } = input;
  const gateBlockers = input.gateBlockers ?? [];
  const assessed = new Set<EvolutionAttributionLayer>(diagnosis.assessedLayers);
  const blockerText = (code: string): string =>
    INTERVENTION_GATE_BLOCKER_TEXT[code as keyof typeof INTERVENTION_GATE_BLOCKER_TEXT] ?? code;
  // A diagnosis that is not `attributed` is not actionable, so the gate is blocked — not pending.
  // Pending would read as "add a card and you may proceed", which is false here.
  const notActionable = diagnosis.verdict !== 'attributed';
  const effectiveBlockers: readonly EvolutionGateBlockerV1[] =
    notActionable && gateBlockers.length === 0
      ? [{ code: 'attribution_not_actionable', ownerFeatureId: 'F311' }]
      : gateBlockers;
  const status: EvolutionAttributionExplanationV1['gate']['status'] =
    input.interventionLinked === true ? 'ready' : effectiveBlockers.length > 0 ? 'blocked' : 'pending';
  return {
    schemaVersion: 1,
    verdict: diagnosis.verdict,
    headline: HEADLINES[diagnosis.verdict],
    ...(diagnosis.primaryLayer === undefined
      ? {}
      : { primaryLayer: { layer: diagnosis.primaryLayer, label: EVOLUTION_LAYER_LABELS[diagnosis.primaryLayer] } }),
    evidence: dedupeEvidence(diagnosis.evidenceRefs),
    competingAttributions: diagnosis.assessedLayers.map((layer) => ({
      layer,
      label: EVOLUTION_LAYER_LABELS[layer],
      discriminating: diagnosis.competingLayers.includes(layer),
    })),
    notAssessedLayers: EVOLUTION_ATTRIBUTION_LAYERS.filter((layer) => !assessed.has(layer)).map((layer) => ({
      layer,
      label: `${EVOLUTION_LAYER_LABELS[layer]}（这一轮没有证据，只是没看，不等于已排除）`,
    })),
    confidence: {
      basis: diagnosis.uncertaintyBasis,
      label:
        diagnosis.uncertaintyBasis === 'unknown'
          ? '这一轮没有区间或判定力证据，置信边界未知。'
          : CONFIDENCE_LABELS[diagnosis.uncertaintyBasis],
    },
    // Persisted status, never guessed from the verdict: a partial 2x2 must not read as "跑满".
    comparability: comparabilityView(diagnosis.comparabilityMode, diagnosis.comparabilityStatus),
    whyNotChange:
      status === 'ready'
        ? []
        : [
            ...diagnosis.reasonCodes.map((code) => EVOLUTION_EVAL_REASON_TEXT[code] ?? code),
            ...effectiveBlockers.map((entry) => blockerText(entry.code)),
            ...(status === 'pending' ? ['干预门尚未评估：还没有 owner 侧 intervention card 或 gate 回执。'] : []),
          ],
    gate: {
      status,
      // Provenance comes from the event, not from an assumption that F311 owns every blocker.
      blockers: effectiveBlockers.map((entry) => ({
        code: entry.code,
        label: blockerText(entry.code),
        ownerFeatureId: entry.ownerFeatureId,
      })),
    },
  };
}

export interface AttributionExplanationInput {
  measurement: MeasurementJoinAssessment;
  comparability: RubricComparabilityAssessment;
  attribution: AttributionAssessment;
  gate: InterventionGateVerdict;
}

export function buildAttributionExplanation(input: AttributionExplanationInput): EvolutionAttributionExplanationV1 {
  const { attribution, comparability, measurement, gate } = input;
  const basis = measurement.uncertaintyBasis ?? 'unknown';
  return {
    schemaVersion: 1,
    verdict: attribution.verdict,
    headline: HEADLINES[attribution.verdict],
    ...(attribution.primaryLayer === undefined
      ? {}
      : { primaryLayer: { layer: attribution.primaryLayer, label: EVOLUTION_LAYER_LABELS[attribution.primaryLayer] } }),
    evidence: dedupeEvidence(attribution.evidenceRefs),
    competingAttributions: attribution.assessedLayers.map((layer) => ({
      layer,
      label: EVOLUTION_LAYER_LABELS[layer],
      discriminating: attribution.competingLayers.includes(layer),
    })),
    notAssessedLayers: attribution.notAssessedLayers.map((layer) => ({
      layer,
      label: `${EVOLUTION_LAYER_LABELS[layer]}（这一轮没有证据，只是没看，不等于已排除）`,
    })),
    confidence: {
      basis,
      label: basis === 'unknown' ? '这一轮没有区间或判定力证据，置信边界未知。' : CONFIDENCE_LABELS[basis],
      ...(measurement.uncertaintyEvidenceRef === undefined
        ? {}
        : { ownerStateRef: measurement.uncertaintyEvidenceRef.ownerStateRef }),
    },
    comparability: comparabilityView(comparability.mode, comparability.comparability),
    whyNotChange: gate.whyNotChange,
    gate: {
      status: gate.status,
      blockers: gate.blockers.map((entry) => ({
        code: entry.code,
        label: entry.message,
        ownerFeatureId: entry.ownerFeatureId,
      })),
    },
  };
}
