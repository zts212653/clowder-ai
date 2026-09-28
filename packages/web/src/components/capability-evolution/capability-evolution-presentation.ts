import {
  type EvolutionProgramLifecycle,
  type EvolutionProgramOriginV1,
  type EvolutionProgramStage,
  type EvolutionProgramV1,
  evolutionProgramTitle,
} from '@cat-cafe/shared';
import { type EvolutionProgramProjection, parseProgramProjection } from './evolution-program-projection';
export type EvolutionProgramPresentationProjection = EvolutionProgramProjection;
export const parseEvolutionProgramProjection = parseProgramProjection;

const LIFECYCLE_LABELS: Record<EvolutionProgramLifecycle, string> = {
  active: '进行中',
  paused: '已暂停',
  needs_expert: '等待专家',
  terminal: '已结束',
};

const STAGE_LABELS: Record<EvolutionProgramStage, string> = {
  constituting: '建制中',
  instrumenting: '接入观测',
  observing: '观察中',
  evaluating: '评估中',
  attributing: '归因中',
  awaiting_intervention: '等待干预',
  awaiting_approval: '等待批准',
  writing_back: '写回中',
  revalidating: '复验中',
  deciding: '等待决策',
};

const BLOCKER_LABELS: Record<string, string> = {
  goal_certificate_missing: '明确要改进什么',
  measurement_certificate_missing: '约定怎样判断改进有效',
  economic_certificate_missing: '确认采用与停止条件',
  value_owner_missing: '确认结果负责人',
  observer_missing: '接好观测来源',
  domain_owner_missing: '确认能力负责人',
  consumer_missing: '确认谁会使用结论',
  calibrator_missing: '确认谁来校准评估',
  trajectory_ref_missing: '补充真实任务的执行记录',
  heterogeneous_owner_surfaces_missing: '补充不同来源的独立反馈',
  trigger_registration_missing: '设置自动检查条件',
  evidence_role_missing: '确认各项证据由谁提供',
  consumption_proof_missing: '证明结论会被真实使用',
  optimizer_exposure_proof_missing: '证明改进过程能读取结论',
  promotion_holdout_missing: '留出未参与选择的验证场景',
};

const OWNER_LABELS: Record<string, string> = {
  F153: '运行观测',
  F192: '自动检查',
  F267: '评估体系',
  F278: '体验反馈',
  F281: '人工反馈',
  F299: '运行轨迹',
  F311: '能力进化',
};

export interface EvolutionProgramProductStatus {
  label: string;
  description: string;
  face: 'setup' | 'journey' | 'lifecycle';
}

const ACTIVE_STAGE_STATUS: Record<EvolutionProgramStage, EvolutionProgramProductStatus> = {
  constituting: { label: '准备目标', description: '目标与评估方式已登记，等待确认。', face: 'setup' },
  instrumenting: { label: '准备评估', description: '目标已确定，等待接入可验证的评估证据。', face: 'setup' },
  observing: { label: '观测中', description: '正在收集本轮证据', face: 'journey' },
  evaluating: { label: '评估中', description: '正在核对这次变化是否真实成立', face: 'journey' },
  attributing: { label: '评估中', description: '正在核对这次变化是否真实成立', face: 'journey' },
  awaiting_intervention: { label: '待调整', description: '证据已形成，正在准备可验证的改动', face: 'journey' },
  awaiting_approval: { label: '待审阅', description: '本轮结论已形成，等待审阅', face: 'journey' },
  writing_back: { label: '应用中', description: '正在应用已批准的改进', face: 'journey' },
  revalidating: { label: '验证中', description: '正在用新的结果验证改进', face: 'journey' },
  deciding: { label: '待审阅', description: '本轮结论已形成，等待审阅', face: 'journey' },
};

export function evolutionProgramPresentation(
  program: EvolutionProgramV1,
  origin?: EvolutionProgramOriginV1,
): { eyebrow: string; title: string } {
  return { eyebrow: program.objectRef.ownerFeatureId, title: evolutionProgramTitle(program, origin) };
}

export function productStatus(projection: EvolutionProgramPresentationProjection): EvolutionProgramProductStatus {
  const { lifecycle, stage, terminalDisposition } = projection.program;
  const stageStatus = ACTIVE_STAGE_STATUS[stage];
  if (lifecycle === 'paused') {
    return { label: '已暂停', description: '这项能力已暂停，现有记录仍然保留。', face: 'lifecycle' };
  }
  if (lifecycle === 'needs_expert') {
    return { label: '等待专家', description: '需要专业判断，当前进度已挂起。', face: 'lifecycle' };
  }
  if (lifecycle === 'terminal') {
    const label = terminalDisposition === 'kept' ? '已采纳' : terminalDisposition === 'sunset' ? '已停止' : '已完成';
    return { label, description: '本轮已经结束，结论与证据已保留。', face: 'journey' };
  }
  const changeStatus = projection.lineage?.current?.status;
  if (changeStatus === 'rejected')
    return { label: '已拒绝', description: '这次候选已被拒绝，审阅记录仍然保留。', face: 'journey' };
  if (changeStatus === 'withdrawn')
    return { label: '已撤回', description: '这次候选已撤回，现有记录仍然保留。', face: 'journey' };
  if (changeStatus === 'target_drift' || changeStatus === 'superseded')
    return { label: '需要重新审阅', description: '目标或候选已经变化，需要重新确认这次改动。', face: 'journey' };
  if (changeStatus === 'no_change')
    return { label: '本次未改动', description: '执行方确认保持现状，后续判断继续以复验记录为准。', face: 'journey' };
  if (stageStatus.face === 'setup') {
    const gaps = preparationGaps(projection);
    const missing = gaps
      .slice(0, 2)
      .map((gap) => blockerLabel(gap.code))
      .join('、');
    return {
      label: stageStatus.label,
      description: gaps.length ? `还需要：${missing}${gaps.length > 2 ? '等' : ''}。` : stageStatus.description,
      face: 'setup',
    };
  }
  return stageStatus;
}

export function preparationGaps(projection: EvolutionProgramPresentationProjection) {
  const conditions =
    projection.program.stage === 'constituting'
      ? projection.blockers
      : [...projection.blockers, ...(projection.observation?.gaps ?? [])];
  return [
    ...new Map(conditions.map((gap) => [`${gap.code}:${gap.ownerFeatureId}:${gap.ownerStateRef ?? ''}`, gap])).values(),
  ];
}

export function blockerLabel(code: string): string {
  return BLOCKER_LABELS[code] ?? '补齐一项评估条件';
}

export function blockerOwnerLabel(ownerFeatureId: string): string {
  return OWNER_LABELS[ownerFeatureId] ?? '关联能力';
}

export function lifecycleLabel(lifecycle: EvolutionProgramLifecycle): string {
  return LIFECYCLE_LABELS[lifecycle];
}

export function stageLabel(stage: EvolutionProgramStage): string {
  return STAGE_LABELS[stage];
}
