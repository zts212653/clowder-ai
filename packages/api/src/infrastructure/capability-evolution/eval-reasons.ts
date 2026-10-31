import type { EvolutionEvalReasonCodeV1, OwnerTruthRefV1 } from '@cat-cafe/shared';

/** Single truth source: the closed vocabulary lives in shared, this is only its local alias. */
export type EvolutionEvalReasonCode = EvolutionEvalReasonCodeV1;

/**
 * F311 Phase 3 — the closed vocabulary the evaluation plane may use to say "no".
 *
 * Every reason names a code, a human sentence and the owner it belongs to. F311 never states a
 * conclusion it cannot point an owner ref at.
 */

export interface EvolutionEvalReason {
  code: EvolutionEvalReasonCode;
  message: string;
  ownerFeatureId: string;
  ownerStateRef?: string;
}

export const CONTROL_PLANE_FEATURE_ID = 'F311';

/**
 * Closed wording table. The live path and the restart/replay path both render from here, so a
 * persisted `reasonCode` always says the same sentence the cat saw when the decision was made.
 */
export const EVOLUTION_EVAL_REASON_TEXT: Record<EvolutionEvalReasonCode, string> = {
  f311_cannot_own_evidence: '这份证据必须由 owner 持有；F311 只能引用，不能自己保存证据。',
  owner_declared_insufficient: 'F267 已判定本轮证据 insufficient，Program 继续观察。',
  frozen_cohort_missing: '缺少冻结 cohort，归因与换尺复判都无法可比。',
  baseline_missing: '缺少 owner 侧 baseline，无法说明“比什么变好了”。',
  exposure_proof_missing: '缺少 optimizer exposure 证明，证据可能已被看过。',
  uncertainty_evidence_missing: '缺少区间/判定力证据，只有点估计不能驱动判断。',
  uncertainty_not_estimable: '本轮不确定性不可估计，按 F267 契约只能记 insufficient。',
  rubric_version_changed_without_rejudge: '尺子换版了，但既没有冻结 cohort 的 2×2 复判，也没有重建 baseline。',
  rubric_version_missing: '尺子没有版本号，无法判断它有没有换过。',
  rejudge_incomplete: '2×2 复判没跑满四格，不能拼接新旧分数。',
  rejudge_cell_reused: '同一份复判结果被当成多格用，2×2 实际没有跑满。',
  rejudge_duplicate_cell: '同一个坐标被填了多次，四格没有真正各跑一次。',
  rejudge_cohort_drift: '2×2 复判跑在另一个 cohort 上，不能证明旧/新尺可比。',
  attribution_candidate_without_evidence: '这一层没有 owner 证据，只能记“没看”，不能记“已排除”。',
  no_discriminating_evidence: '现有证据无法把任何一层与其他层区分开。',
  competing_layers_tied: '多层同时被证据支持，暂时无法确诊。',
  measurement_insufficient: '本轮度量证据不足，先不谈归因。',
  comparison_incomparable: '旧尺与新尺无法比较，拒绝拼接分数。',
};

export const evalReason = (
  code: EvolutionEvalReasonCode,
  ref?: OwnerTruthRefV1,
  detail?: string,
): EvolutionEvalReason => ({
  code,
  message: detail === undefined ? EVOLUTION_EVAL_REASON_TEXT[code] : `${EVOLUTION_EVAL_REASON_TEXT[code]}（${detail}）`,
  ownerFeatureId: ref?.ownerFeatureId ?? 'F267',
  ...(ref === undefined ? {} : { ownerStateRef: ref.ownerStateRef }),
});

/** F311 may reference evidence, never own it — this is where that boundary is enforced. */
export function collectForeignOwnership(entries: Array<[string, OwnerTruthRefV1 | undefined]>): EvolutionEvalReason[] {
  return entries
    .filter(([, ref]) => ref !== undefined && ref.ownerFeatureId === CONTROL_PLANE_FEATURE_ID)
    .map(([label, ref]) => evalReason('f311_cannot_own_evidence', ref, label));
}
