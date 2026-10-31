import type { EvolutionPreparationBodyV1, EvolutionPreparationSection } from '@cat-cafe/shared';
import { preparationDecisionLabel } from './EvolutionPreparationChoice';
import type {
  EvolutionPreparationSectionProjection,
  EvolutionPreparationSubmissionProjection,
} from './evolution-preparation-resource';

export const SECTION_META: Record<
  EvolutionPreparationSection,
  { label: string; hint: string; category: 'object' | 'rubric' | 'measurement' | 'diagnosis' }
> = {
  object_map: { label: '可进化对象', hint: '范围与可改边界', category: 'object' },
  success_contract: { label: '好坏规约', hint: '判法、反例与裁判', category: 'rubric' },
  measurement_plan: { label: '测量与实验准备', hint: 'GT 来源与实验条件', category: 'measurement' },
  baseline_diagnosis: { label: '基线与初步诊断', hint: '事实、未知与竞争解释', category: 'diagnosis' },
};

export function latestOpenActivity(section: EvolutionPreparationSectionProjection) {
  return section.activities.find((activity) => activity.state !== 'superseded_by_submission');
}

export function sectionState(section: EvolutionPreparationSectionProjection) {
  const status = section.current?.status;
  if (status === 'submitted') return { key: status, label: '已提交' };
  if (status === 'needs_update') return { key: status, label: '需更新' };
  if (status === 'materializing') return { key: status, label: '需恢复' };
  if (status === 'source_unavailable' || status === 'source_invalid') return { key: status, label: '需处理' };
  const activity = latestOpenActivity(section);
  if (activity?.state === 'active') return { key: 'working', label: '正在进行' };
  if (activity?.state === 'terminal') return { key: 'terminal', label: '运行已结束' };
  if (activity) return { key: activity.state, label: '活动待核实' };
  return { key: 'not_started', label: '待猫继续准备' };
}

export function preparationBodySummary(
  body: EvolutionPreparationBodyV1,
  submission?: EvolutionPreparationSubmissionProjection,
): string {
  if (body.kind === 'object_map') {
    const decisions = body.items.map((item) => preparationDecisionLabel(item, submission));
    const explore = decisions.filter((decision) => decision === '纳入探索').length;
    const fixed = decisions.filter((decision) => decision === '保持固定').length;
    return `${body.items.length} 个对象：${explore} 个纳入探索，${fixed} 个保持固定${body.items.length > explore + fixed ? '，其余决定见原文' : ''}。`;
  }
  if (body.kind === 'success_contract')
    return `${body.criteria.length} 条判法：${body.criteria.filter((criterion) => criterion.gtDomain === 'verifiable').length} 条可验证，${body.criteria.filter((criterion) => criterion.gtDomain === 'semi_verifiable').length} 条半可验证，${body.criteria.filter((criterion) => criterion.gtDomain === 'open_value').length} 条开放价值；适用范围见原文。`;
  if (body.kind === 'measurement_plan') return `${body.gtSources.length} 个真值来源；采集状态与可信性分别记录。`;
  return `${body.facts.length} 条事实，${body.competingExplanations.length} 条竞争解释；基线${body.baselineState === 'owner_verified' ? '已核验' : body.baselineState === 'draft' ? '是初步草案' : '仍未知'}。`;
}

export function preparationBoundarySummary(body: EvolutionPreparationBodyV1): string | undefined {
  if (body.kind !== 'object_map') return undefined;
  const modifiable = body.items.filter(
    (item) => item.modifiability.state === 'modifiable' || item.modifiability.state === 'partially_modifiable',
  ).length;
  const fixed = body.items.filter((item) => item.modifiability.state === 'not_modifiable_this_round').length;
  return `可改边界：${modifiable} 个可改或部分可改，${fixed} 个本轮不可改；其余边界见原文。`;
}
