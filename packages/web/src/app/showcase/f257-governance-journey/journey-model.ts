import type { ActiveStage } from '@cat-cafe/shared';

export const CANDIDATE_ID = 'gc-EC-demo-001';
export const DEFAULT_REJECTION_REASON = '反例来自已退役工具别名；下一窗口按新工具目录重新评估。';
export const DEMO_WINDOW = {
  start: Date.UTC(2026, 7, 24, 12),
  end: Date.UTC(2026, 7, 31, 12),
} as const;

export const HUMAN_JOURNEY_STEPS = ['收集证据', '评估出结论', '系统建议干预', '你审批', '回到下一轮'] as const;

export type JourneyScenario = 'applied' | 'rejected';
export type JourneySceneId =
  | 'evidence-collected'
  | 'evaluation-complete'
  | 'governance-suggested'
  | 'operator-applied'
  | 'operator-rejected'
  | 'next-round';

export type JourneyTransitionOwner = 'tracing-runtime' | 'evaluation-runtime' | 'governance-worker' | 'operator';

export interface DemoEvaluationEvidence {
  snapshotId: string;
  contentRef: string;
  window: { start: number; end: number; frozen: true };
  sourceKind: 'InjectionTrace summary';
  sourceRefs: readonly string[];
  metrics: readonly {
    metricId: string;
    label: string;
    rule: 'counter-zero';
    measurement: string;
    decision: 'breach';
    reason: string;
  }[];
  verdict: 'retire-candidate';
}

export interface DemoNextEvaluationContext {
  rejectionNote: string;
  persistence: 'candidate-approval-note';
  evaluatorBridge: 'prototype-only';
}

export interface DemoCandidate {
  candidateId: string;
  status: 'proposed' | 'approved' | 'rejected';
  decisionMode: 'apply-reject' | 'none';
  operatorDecisionCount: number;
  decisionNote: string | null;
  proposedAction: {
    mechanism: 'override-content';
    createsVersion: 2;
    governanceBridge: 'prototype-only';
  };
}

export interface DemoVersionTransition {
  fromVersion: 1;
  toVersion: 2 | null;
  action: 'setContentOverride' | 'continue-observe';
  primitiveSupport: 'available' | 'not-needed';
  governanceBridge: 'prototype-only' | 'not-needed';
}

export interface JourneyScene {
  id: JourneySceneId;
  stepLabel: (typeof HUMAN_JOURNEY_STEPS)[number];
  eyebrow: string;
  title: string;
  explanation: string;
  activeVersion: 1 | 2;
  roundInUnit: 1 | 2;
  transitionOwner: JourneyTransitionOwner;
  operatorActionRequired: 'none' | 'apply-or-reject';
  activeStage: ActiveStage;
  selectedStage: 'tracing' | 'eval' | 'governance';
  verdict: 'retire-candidate' | null;
  evaluationEvidence: DemoEvaluationEvidence | null;
  candidate: DemoCandidate | null;
  versionTransition: DemoVersionTransition | null;
  nextEvaluationContext: DemoNextEvaluationContext | null;
  actionableCandidateCount: number;
  terminal: boolean;
}

export interface DemoLifelineRound {
  round: 1 | 2;
  isCurrent: boolean;
  currentStage: JourneyScene['selectedStage'] | null;
  governanceOutcome: 'approved' | 'rejected' | null;
}

export interface DemoLifelineVersion {
  version: 1 | 2;
  isActive: boolean;
  rounds: readonly DemoLifelineRound[];
}

const evaluationEvidence: DemoEvaluationEvidence = {
  snapshotId: 'snapshot-s13-schema-failure',
  contentRef: 'S13@v1',
  window: { ...DEMO_WINDOW, frozen: true },
  sourceKind: 'InjectionTrace summary',
  sourceRefs: ['turn_schema_failure_1', 'turn_schema_failure_2', 'turn_schema_failure_3'],
  metrics: [
    {
      metricId: 'tool-schema-failure-count',
      label: '工具名或 Schema 校验失败次数',
      rule: 'counter-zero',
      measurement: 'count = 3',
      decision: 'breach',
      reason: 'counter=3; zero required',
    },
  ],
  verdict: 'retire-candidate',
};

const proposedCandidate: DemoCandidate = {
  candidateId: CANDIDATE_ID,
  status: 'proposed',
  decisionMode: 'apply-reject',
  operatorDecisionCount: 0,
  decisionNote: null,
  proposedAction: {
    mechanism: 'override-content',
    createsVersion: 2,
    governanceBridge: 'prototype-only',
  },
};

const approvedCandidate: DemoCandidate = {
  ...proposedCandidate,
  status: 'approved',
  decisionMode: 'none',
  operatorDecisionCount: 1,
  decisionNote: '批准修改内容并进入新版本',
};

const sharedOpening: readonly JourneyScene[] = [
  {
    id: 'evidence-collected',
    stepLabel: HUMAN_JOURNEY_STEPS[0],
    eyebrow: 'v1 · 第 1 轮',
    title: '收集到足够的结构化反例',
    explanation: 'S13 的工具 Schema 失败累计到 3 次；达到阈值只会触发评估，不会提前替评估下结论。',
    activeVersion: 1,
    roundInUnit: 1,
    transitionOwner: 'tracing-runtime',
    operatorActionRequired: 'none',
    activeStage: 'tracing',
    selectedStage: 'tracing',
    verdict: null,
    evaluationEvidence: null,
    candidate: null,
    versionTransition: null,
    nextEvaluationContext: null,
    actionableCandidateCount: 0,
    terminal: false,
  },
  {
    id: 'evaluation-complete',
    stepLabel: HUMAN_JOURNEY_STEPS[1],
    eyebrow: 'v1 · 第 1 轮 · 冻结窗口',
    title: '数据、指标与规则形成可追溯结论',
    explanation: '同一份内容、时间窗和来源数据被锁进 snapshot；指标规则判定 breach，结论为 retire-candidate。',
    activeVersion: 1,
    roundInUnit: 1,
    transitionOwner: 'evaluation-runtime',
    operatorActionRequired: 'none',
    activeStage: 'tracing',
    selectedStage: 'eval',
    verdict: 'retire-candidate',
    evaluationEvidence,
    candidate: null,
    versionTransition: null,
    nextEvaluationContext: null,
    actionableCandidateCount: 0,
    terminal: false,
  },
  {
    id: 'governance-suggested',
    stepLabel: HUMAN_JOURNEY_STEPS[2],
    eyebrow: 'v1 · 第 1 轮 · 系统自动',
    title: '系统把结论转成待审批的干预建议',
    explanation: '后台自动按目标、结论和 snapshot 创建唯一 Candidate；用户不用启动治理，只需在审批卡决定应用或拒绝。',
    activeVersion: 1,
    roundInUnit: 1,
    transitionOwner: 'governance-worker',
    operatorActionRequired: 'apply-or-reject',
    activeStage: 'governance',
    selectedStage: 'governance',
    verdict: 'retire-candidate',
    evaluationEvidence,
    candidate: proposedCandidate,
    versionTransition: null,
    nextEvaluationContext: null,
    actionableCandidateCount: 1,
    terminal: false,
  },
];

const appliedTransition: DemoVersionTransition = {
  fromVersion: 1,
  toVersion: 2,
  action: 'setContentOverride',
  primitiveSupport: 'available',
  governanceBridge: 'prototype-only',
};

const appliedJourney: readonly JourneyScene[] = [
  ...sharedOpening,
  {
    id: 'operator-applied',
    stepLabel: HUMAN_JOURNEY_STEPS[3],
    eyebrow: 'v1 · 第 1 轮 · 你的决定',
    title: '你批准了内容修改',
    explanation: '批准只发生一次；内容修改创建一个新版本，旧版本和审批依据继续保留。',
    activeVersion: 1,
    roundInUnit: 1,
    transitionOwner: 'operator',
    operatorActionRequired: 'none',
    activeStage: 'governance',
    selectedStage: 'governance',
    verdict: 'retire-candidate',
    evaluationEvidence,
    candidate: approvedCandidate,
    versionTransition: appliedTransition,
    nextEvaluationContext: null,
    actionableCandidateCount: 0,
    terminal: false,
  },
  {
    id: 'next-round',
    stepLabel: HUMAN_JOURNEY_STEPS[4],
    eyebrow: 'v2 · 第 1 轮',
    title: '新版本从 tracing 开始',
    explanation: '修改后的内容进入 v2；新窗口重新收集证据并再次评估，验证自然发生在下一轮。',
    activeVersion: 2,
    roundInUnit: 1,
    transitionOwner: 'tracing-runtime',
    operatorActionRequired: 'none',
    activeStage: 'tracing',
    selectedStage: 'tracing',
    verdict: null,
    evaluationEvidence: null,
    candidate: approvedCandidate,
    versionTransition: appliedTransition,
    nextEvaluationContext: null,
    actionableCandidateCount: 0,
    terminal: true,
  },
];

function rejectedJourney(reason: string): readonly JourneyScene[] {
  const rejectedCandidate: DemoCandidate = {
    ...proposedCandidate,
    status: 'rejected',
    decisionMode: 'none',
    operatorDecisionCount: 1,
    decisionNote: reason,
  };
  const rejectedTransition: DemoVersionTransition = {
    fromVersion: 1,
    toVersion: null,
    action: 'continue-observe',
    primitiveSupport: 'not-needed',
    governanceBridge: 'not-needed',
  };
  return [
    ...sharedOpening,
    {
      id: 'operator-rejected',
      stepLabel: HUMAN_JOURNEY_STEPS[3],
      eyebrow: 'v1 · 第 1 轮 · 你的决定',
      title: '你拒绝了本次修改',
      explanation: '拒绝理由写入 Candidate.approval.note；内容保持不变，不生成新版本。',
      activeVersion: 1,
      roundInUnit: 1,
      transitionOwner: 'operator',
      operatorActionRequired: 'none',
      activeStage: 'governance',
      selectedStage: 'governance',
      verdict: 'retire-candidate',
      evaluationEvidence,
      candidate: rejectedCandidate,
      versionTransition: rejectedTransition,
      nextEvaluationContext: null,
      actionableCandidateCount: 0,
      terminal: false,
    },
    {
      id: 'next-round',
      stepLabel: HUMAN_JOURNEY_STEPS[4],
      eyebrow: 'v1 · 第 2 轮',
      title: '同一版本继续收集证据',
      explanation: '内容没有改变，因此仍在 v1；下一窗口从 tracing 重新开始，并保留上一轮的拒绝理由。',
      activeVersion: 1,
      roundInUnit: 2,
      transitionOwner: 'tracing-runtime',
      operatorActionRequired: 'none',
      activeStage: 'tracing',
      selectedStage: 'tracing',
      verdict: null,
      evaluationEvidence: null,
      candidate: rejectedCandidate,
      versionTransition: rejectedTransition,
      nextEvaluationContext: {
        rejectionNote: reason,
        persistence: 'candidate-approval-note',
        evaluatorBridge: 'prototype-only',
      },
      actionableCandidateCount: 0,
      terminal: true,
    },
  ];
}

export function journeyFor(
  scenario: JourneyScenario,
  rejectionReason = DEFAULT_REJECTION_REASON,
): readonly JourneyScene[] {
  return scenario === 'applied' ? appliedJourney : rejectedJourney(rejectionReason);
}

function governanceOutcomeFor(scene: JourneyScene): DemoLifelineRound['governanceOutcome'] {
  if (scene.candidate?.status === 'approved') return 'approved';
  if (scene.candidate?.status === 'rejected') return 'rejected';
  return null;
}

export function lifelineFor(scene: JourneyScene): readonly DemoLifelineVersion[] {
  const governanceOutcome = governanceOutcomeFor(scene);
  if (scene.activeVersion === 2) {
    return [
      {
        version: 1,
        isActive: false,
        rounds: [{ round: 1, isCurrent: false, currentStage: null, governanceOutcome: 'approved' }],
      },
      {
        version: 2,
        isActive: true,
        rounds: [{ round: 1, isCurrent: true, currentStage: 'tracing', governanceOutcome: null }],
      },
    ];
  }

  const rounds: DemoLifelineRound[] = [];
  if (scene.roundInUnit === 2) {
    rounds.push({ round: 1, isCurrent: false, currentStage: null, governanceOutcome });
  }
  rounds.push({
    round: scene.roundInUnit,
    isCurrent: true,
    currentStage: scene.selectedStage,
    governanceOutcome: scene.roundInUnit === 1 ? governanceOutcome : null,
  });
  return [{ version: 1, isActive: true, rounds }];
}
