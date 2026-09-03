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
