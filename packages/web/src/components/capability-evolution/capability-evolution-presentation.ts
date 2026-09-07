import {
  type EvolutionCycleV1,
  type EvolutionProgramLifecycle,
  type EvolutionProgramStage,
  type EvolutionProgramV1,
  evolutionProgramStateV1Schema,
  type OwnerTruthRefV1,
} from '@cat-cafe/shared';

export interface EvolutionProgramPresentationProjection {
  program: EvolutionProgramV1;
  cycles: EvolutionCycleV1[];
  blockers: Array<{
    code: string;
    message: string;
    ownerFeatureId: string;
    ownerStateRef?: string;
  }>;
  nextAction: {
    code: string;
    label: string;
  };
}

const LEGACY_WORDS: Record<string, string> = {
  ability: '能力',
  capability: '能力',
  expression: '表达能力',
  investor: '投资人',
  roadshow: '路演',
};

const PRODUCT_TITLES: Record<string, string> = {
  'development-process-harness-effectiveness': '研发协作改进',
  'microduck-walking-stability': 'Microduck 行走稳定性',
  'investor-roadshow-expression': '投资人路演效果',
};

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
  goal_certificate_missing: '确认改进目标',
  measurement_certificate_missing: '接好评估方式',
  economic_certificate_missing: '确认采用与停止条件',
  value_owner_missing: '确认结果负责人',
  observer_missing: '接好观测来源',
  domain_owner_missing: '确认能力负责人',
  consumer_missing: '确认谁会使用结论',
  calibrator_missing: '确认谁来校准评估',
  trajectory_ref_missing: '接上运行轨迹',
  heterogeneous_owner_surfaces_missing: '接上第二个独立信号来源',
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
  constituting: { label: '配置中', description: '正在确认评估条件', face: 'setup' },
  instrumenting: { label: '配置中', description: '正在确认评估信号可用', face: 'setup' },
  observing: { label: '观测中', description: '正在收集本轮证据', face: 'journey' },
  evaluating: { label: '评估中', description: '正在核对这次变化是否真实成立', face: 'journey' },
  attributing: { label: '评估中', description: '正在核对这次变化是否真实成立', face: 'journey' },
  awaiting_intervention: { label: '待调整', description: '证据已形成，正在准备可验证的改动', face: 'journey' },
  awaiting_approval: { label: '待审阅', description: '本轮结论已形成，等待审阅', face: 'journey' },
  writing_back: { label: '应用中', description: '正在应用已批准的改进', face: 'journey' },
  revalidating: { label: '验证中', description: '正在用新的结果验证改进', face: 'journey' },
  deciding: { label: '待审阅', description: '本轮结论已形成，等待审阅', face: 'journey' },
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function decodeRefPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function titleCase(words: string[]): string {
  return words.map((word) => word.slice(0, 1).toLocaleUpperCase() + word.slice(1)).join(' ');
}

export function humanizeEvolutionTarget(ref: OwnerTruthRefV1): { eyebrow: string; title: string } {
  const separator = ref.ownerStateRef.indexOf(':');
  const rawId = separator >= 0 ? ref.ownerStateRef.slice(separator + 1) : ref.ownerStateRef;
  const decoded = decodeRefPart(rawId)
    .replace(/^f\d{2,4}[-_:]/i, '')
    .trim();
  const productTitle = PRODUCT_TITLES[decoded.toLocaleLowerCase()];
  if (productTitle) return { eyebrow: ref.ownerFeatureId, title: productTitle };
  if (/[\u3400-\u9fff]/u.test(decoded)) {
    return { eyebrow: ref.ownerFeatureId, title: decoded.replace(/[-_]+/g, ' ') };
  }
  const words = decoded.split(/[-_]+/).filter(Boolean);
  const translated = words.map((word) => LEGACY_WORDS[word.toLocaleLowerCase()]);
  const title = translated.every(Boolean) ? translated.join('') : titleCase(words);
  return {
    eyebrow: ref.ownerFeatureId,
    title: title || '未命名能力',
  };
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
  if (stageStatus.face === 'setup') {
    const missing = projection.blockers.length;
    return {
      label: '配置中',
      description: missing > 0 ? `${missing} 项评估条件待完成` : '正在确认评估信号可用',
      face: 'setup',
    };
  }
  return stageStatus;
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

export function parseEvolutionProgramProjection(value: unknown): EvolutionProgramPresentationProjection | null {
  const source = record(value);
  if (!source) return null;
  const state = evolutionProgramStateV1Schema.safeParse({ program: source.program, cycles: source.cycles });
  if (!state.success || !/^evolution-program:[0-9a-f]{32}$/.test(state.data.program.programId)) return null;
  if (!Array.isArray(source.blockers)) return null;
  const blockers = source.blockers.flatMap((candidate) => {
    const blocker = record(candidate);
    if (
      !blocker ||
      typeof blocker.code !== 'string' ||
      typeof blocker.message !== 'string' ||
      typeof blocker.ownerFeatureId !== 'string' ||
      (blocker.ownerStateRef !== undefined && typeof blocker.ownerStateRef !== 'string')
    ) {
      return [];
    }
    return [
      {
        code: blocker.code,
        message: blocker.message,
        ownerFeatureId: blocker.ownerFeatureId,
        ...(typeof blocker.ownerStateRef === 'string' ? { ownerStateRef: blocker.ownerStateRef } : {}),
      },
    ];
  });
  if (blockers.length !== source.blockers.length) return null;
  const nextAction = record(source.nextAction);
  if (!nextAction || typeof nextAction.code !== 'string' || typeof nextAction.label !== 'string') return null;
  return {
    program: state.data.program,
    cycles: state.data.cycles,
    blockers,
    nextAction: { code: nextAction.code, label: nextAction.label },
  };
}
