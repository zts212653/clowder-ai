'use client';

import type { ApprovalHubItem, SegmentCycleSummary, SegmentEvaluationResponse } from '@cat-cafe/shared';
import { useEffect, useMemo, useState } from 'react';
import { ApprovalDecisionCard } from '@/components/ApprovalDecisionCard';
import { GenericApprovalRecommendation } from '@/components/GenericApprovalRecommendation';
import { ObjectiveEvaluationPanel } from '@/components/settings/ObjectiveEvaluationPanel';
import {
  SettingsBadge,
  SettingsPrimaryButton,
  SettingsSecondaryButton,
  SettingsText,
} from '@/components/settings/primitives';
import {
  CANDIDATE_ID,
  DEFAULT_REJECTION_REASON,
  type DemoLifelineRound,
  type DemoLifelineVersion,
  type JourneyScenario,
  type JourneyScene,
  journeyFor,
  lifelineFor,
  DEMO_WINDOW as WINDOW,
} from './journey-model';

interface SelectedStage {
  version: number;
  stage: 'version' | 'tracing' | 'eval' | 'governance';
}

const CURRENT_CYCLE: SegmentCycleSummary = {
  cycleId: 'cycle-s13-demo',
  segmentVersion: 1,
  version: 'S13@1',
  versionContentRef: 'hook:S13@1',
  cycleStart: WINDOW.start,
  cycleEnd: WINDOW.end,
  evalStatus: 'written',
  windows: [WINDOW],
  triggeredBy: ['counterexamples'],
  evaluation: { overall: 'complete', writtenAt: WINDOW.end, by: 'cat-evaluator' },
  governance: {
    decision: 'evolve',
    reason: '修正工具名与参数约束，降低 Schema 失败',
    writtenAt: WINDOW.end,
    by: 'cat-evaluator',
  },
  governanceImpact: {
    changedUnitIds: ['S13'],
    selectedSegmentChanged: true,
    changes: [{ action: 'modify', unitId: 'S13', sourceVersion: 1, targetVersion: 2 }],
  },
  approval: { cardId: CANDIDATE_ID, state: 'pending', rejectCount: 0, at: WINDOW.end },
  rejectReasons: [],
  termination: null,
  closedAt: null,
};

const EVALUATION: SegmentEvaluationResponse = {
  segmentId: 'S13',
  window: WINDOW,
  tracing: {
    trigger: {
      objective: {
        objectiveId: 'tool-access-correct-use',
        evalStatus: 'written',
        lifecycle: 'active',
        health: 'healthy',
        policyChangeCount: 1,
        cycleStartMs: WINDOW.start,
        cycleEndMs: WINDOW.end,
        lastClosedAtMs: null,
        minimumIntervalMs: 7_200_000,
        triggeredBy: ['counterexamples'],
        cumulative: { count: 146, threshold: 200 },
        counterexamples: { count: 3, threshold: 3 },
        cadence: {
          elapsedMs: WINDOW.end - WINDOW.start,
          thresholdMs: 7 * 24 * 60 * 60 * 1000,
          eligible: true,
        },
      },
      segment: {
        segmentId: 'S13',
        observationCount: 146,
        injectionCount: 2,
        disabledCount: 0,
      },
    },
    injections: [],
    injectionsCapped: false,
    structuredCounterexamples: [
      {
        annotationId: 'annotation-s13-schema-failure',
        incidentKey: 'incident-s13-schema-failure',
        objectiveId: 'tool-access-correct-use',
        metricId: 'tool-schema-failure-count',
        source: 'structured-rule',
        createdAt: WINDOW.end - 60_000,
        rationale: '工具名不存在，调用在 Schema 校验前失败',
        threadId: 'thread_demo_f257',
        turnId: 'turn_schema_failure_3',
        catId: 'cat-reviewer',
        segmentIds: ['S13'],
      },
    ],
  },
  objectives: [
    {
      objectiveId: 'tool-access-correct-use',
      objectiveLabel: '工具可达与正确使用',
      objectiveStatement: '工具能力可发现、可调用，并在真实任务中正确使用。',
      evaluationModelId: 'em-tool-access-correct-use',
      evaluationModelLabel: '工具可达与正确使用评估',
      ruleVersion: 'v1',
      unitRefs: [{ unitType: 'segment', unitId: 'S13' }],
      metrics: [
        {
          metricId: 'tool-schema-failure-count',
          label: '工具名或 Schema 校验失败次数',
          kind: 'counter',
          evaluatorKind: 'code',
          evaluatorRuleRef: 'tool-schema-failure',
          verdictRule: { kind: 'counter-zero' },
          latestConclusion: { kind: 'count', value: 3, howCounted: '3 个去重 incident' },
          evidenceRefs: ['invocation://turn_schema_failure_3'],
        },
      ],
      selectedCycle: CURRENT_CYCLE,
      currentCycle: CURRENT_CYCLE,
      latestEvaluation: {
        cycleId: CURRENT_CYCLE.cycleId,
        overall: 'complete',
        writtenAt: WINDOW.end,
        by: 'cat-evaluator',
        windows: [WINDOW],
      },
      latestGovernance: {
        cycleId: CURRENT_CYCLE.cycleId,
        decision: 'evolve',
        reason: '修正工具名与参数约束，降低 Schema 失败',
        writtenAt: WINDOW.end,
        by: 'cat-evaluator',
        approval: CURRENT_CYCLE.approval,
        impact: CURRENT_CYCLE.governanceImpact,
      },
      versionChain: [CURRENT_CYCLE],
      versionChainCapped: false,
    },
  ],
};

function approvalItemFor(): ApprovalHubItem {
  return {
    proposalId: CANDIDATE_ID,
    sourceFeatureId: 'F257',
    requesterCatId: 'harness-governance-worker',
    ownerUserId: 'demo-owner',
    resolution: 'open',
    materialization: { state: 'not_started' },
    summary: '修改内容后生成 v2',
    detail: {
      targetSegmentIds: ['S13'],
      objectiveId: 'tool-access-correct-use',
      proposedAction: { mechanism: 'override-content' },
      evidence: { summary: 'v1 counter-zero：3 个结构化反例，要求为 0' },
    },
    navigation: {
      state: 'anchored',
      originRef: { kind: 'event', anchor: 'judgment-s13-demo', summary: '评估结论：建议修改内容' },
      approvalCardRef: { threadId: 'thread_demo_f257', messageId: 'approval_demo_f257' },
    },
    inlineApprovable: true,
    decisionMode: 'approve-skip-reject',
    createdAt: WINDOW.end,
  };
}

export default function F257GovernanceJourneyDemo() {
  const [scenario, setScenario] = useState<JourneyScenario>('applied');
  const [stepIndex, setStepIndex] = useState(0);
  const [selected, setSelected] = useState<SelectedStage>({ version: 1, stage: 'tracing' });
  const [isRejecting, setIsRejecting] = useState(false);
  const [rejectionReason, setRejectionReason] = useState(DEFAULT_REJECTION_REASON);
  const journey = useMemo(() => journeyFor(scenario, rejectionReason), [rejectionReason, scenario]);
  const scene = journey[stepIndex] ?? journey[0];

  useEffect(() => {
    setSelected({ version: scene.activeVersion, stage: scene.selectedStage });
  }, [scene.activeVersion, scene.selectedStage]);

  const moveTo = (index: number) => {
    setIsRejecting(false);
    setStepIndex(Math.max(0, Math.min(journey.length - 1, index)));
  };

  const selectScenario = (next: JourneyScenario) => {
    setScenario(next);
    setStepIndex(0);
    setIsRejecting(false);
    setRejectionReason(DEFAULT_REJECTION_REASON);
  };

  const decide = (decision: JourneyScenario) => {
    const reason = rejectionReason.trim();
    if (decision === 'rejected' && !reason) return;
    const decidedJourney = journeyFor(decision, reason);
    const decidedId = decision === 'applied' ? 'operator-applied' : 'operator-rejected';
    setScenario(decision);
    setStepIndex(decidedJourney.findIndex((entry) => entry.id === decidedId));
    setIsRejecting(false);
  };

  return (
    <main className="mx-auto max-w-6xl space-y-5 p-6" data-testid="f257-governance-journey-demo">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <SettingsBadge tone="blue" size="xxs">
            F257 体验 Gate
          </SettingsBadge>
          <span data-testid="f257-journey-truth-label">
            <SettingsBadge tone="amber" size="xxs">
              功能原型 · 演示数据 · 不连接生产
            </SettingsBadge>
          </span>
        </div>
        <h1 className="text-2xl font-semibold text-cafe">一个 version 是一个可反复评估的治理单元</h1>
        <SettingsText as="p" variant="sm" tone="muted">
          系统负责收集、评估和提出干预；人只在审批卡应用或拒绝。两条决定都会回到下一轮。
        </SettingsText>
      </header>

      <section
        className="space-y-3 rounded-xl border border-dashed border-cafe-subtle bg-cafe-surface-elevated p-3"
        aria-label="演示控制"
      >
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={scenario === 'applied' ? activeControlClass : controlClass}
            onClick={() => selectScenario('applied')}
          >
            应用修改
          </button>
          <button
            type="button"
            className={scenario === 'rejected' ? activeControlClass : controlClass}
            onClick={() => selectScenario('rejected')}
          >
            拒绝修改
          </button>
          <span className="mx-1 h-4 w-px bg-cafe-border" aria-hidden="true" />
          <button
            type="button"
            className={controlClass}
            onClick={() => moveTo(stepIndex - 1)}
            disabled={stepIndex === 0}
          >
            上一步
          </button>
          <button
            type="button"
            className={controlClass}
            onClick={() => moveTo(stepIndex + 1)}
            disabled={stepIndex === journey.length - 1}
            data-testid="f257-journey-next"
          >
            下一步
          </button>
          <button type="button" className={controlClass} onClick={() => moveTo(0)}>
            重置
          </button>
        </div>
        <nav className="flex flex-wrap gap-1.5" aria-label="旅程场景">
          {journey.map((entry, index) => (
            <button
              key={entry.id}
              type="button"
              className={index === stepIndex ? activeStepClass : stepClass}
              onClick={() => moveTo(index)}
              aria-current={index === stepIndex ? 'step' : undefined}
            >
              {index + 1}. {entry.stepLabel}
            </button>
          ))}
        </nav>
      </section>

      <section className="rounded-2xl border border-cafe bg-cafe-surface p-4 shadow-sm" aria-live="polite">
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <SettingsText as="p" variant="xs" tone="muted">
              {scene.eyebrow}
            </SettingsText>
            <h2 className="mt-1 text-xl font-semibold text-cafe">{scene.title}</h2>
            <SettingsText as="p" variant="sm" tone="muted" className="mt-1 max-w-3xl">
              {scene.explanation}
            </SettingsText>
          </div>
          <div className="text-right">
            <SettingsBadge tone={scene.terminal ? 'emerald' : 'slate'} size="xxs">
              {scene.stepLabel}
            </SettingsBadge>
            <SettingsText as="p" variant="xs" tone="muted" className="mt-1">
              {stepIndex + 1} / {journey.length}
            </SettingsText>
          </div>
        </div>

        <JourneyRoundLifeline units={lifelineFor(scene)} selected={selected} onSelect={setSelected} />
        <VersionUnitModel scene={scene} />
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,0.65fr)]">
        <section className="rounded-2xl bg-[var(--console-panel-bg)] p-4" data-testid="f257-journey-stage-detail">
          <JourneyStageDetail
            selected={selected}
            scene={scene}
            isRejecting={isRejecting}
            rejectionReason={rejectionReason}
            onApprove={() => decide('applied')}
            onStartReject={() => setIsRejecting(true)}
            onChangeRejectionReason={setRejectionReason}
            onConfirmReject={() => decide('rejected')}
            onCancelReject={() => setIsRejecting(false)}
          />
        </section>

        <aside className="space-y-3">
          <ResponsibilityCard scene={scene} />
          <TruthBoundaryCard scene={scene} />
        </aside>
      </div>
    </main>
  );
}

const LIFELINE_STAGES = ['tracing', 'eval', 'governance'] as const;
type LifelineStage = (typeof LIFELINE_STAGES)[number];
type RoundStageState = 'complete' | 'current' | 'pending';

function roundStageState(round: DemoLifelineRound, stage: LifelineStage): RoundStageState {
  if (!round.isCurrent) return 'complete';
  const currentIndex = round.currentStage ? LIFELINE_STAGES.indexOf(round.currentStage) : -1;
  const stageIndex = LIFELINE_STAGES.indexOf(stage);
  if (stageIndex < currentIndex) return 'complete';
  if (stageIndex === currentIndex) return 'current';
  return 'pending';
}

function stageClass(state: RoundStageState, outcome: DemoLifelineRound['governanceOutcome']): string {
  if (outcome === 'rejected') {
    return 'border-[var(--semantic-critical)] bg-cafe-surface text-[var(--semantic-critical)]';
  }
  if (outcome === 'approved') {
    return 'border-[var(--semantic-success)] bg-cafe-surface text-[var(--semantic-success)]';
  }
  if (state === 'current') return 'border-cafe-accent bg-cafe-accent text-[var(--cafe-accent-foreground)]';
  if (state === 'complete') return 'border-cafe-subtle bg-cafe-surface text-cafe';
  return 'border-cafe-subtle bg-cafe-surface text-cafe-muted';
}

function JourneyRoundLifeline({
  units,
  selected,
  onSelect,
}: {
  units: readonly DemoLifelineVersion[];
  selected: SelectedStage;
  onSelect: (stage: SelectedStage) => void;
}) {
  return (
    <section
      className="overflow-x-auto rounded-2xl bg-[var(--console-panel-bg)] p-4"
      data-testid="f257-journey-round-lifeline"
      aria-label="版本生命线：按轮次展开"
    >
      <SettingsText as="h3" variant="sm" tone="default" className="mb-3 font-semibold">
        版本生命线
      </SettingsText>
      <div className="flex min-w-max items-center gap-2 pb-1">
        {units.map((unit, unitIndex) => (
          <div key={unit.version} className="flex items-center gap-2">
            {unitIndex > 0 && (
              <span className="px-1 text-lg font-semibold text-cafe-muted">
                <span aria-hidden="true">⇒</span>
                <span className="sr-only">生成下一版本</span>
              </span>
            )}
            <div
              className="flex items-center gap-2"
              data-testid={`f257-lifeline-version-${unit.version}`}
              data-version={unit.version}
            >
              <button
                type="button"
                className={unit.isActive ? activeVersionClass : versionClass}
                onClick={() => onSelect({ version: unit.version, stage: 'version' })}
                aria-pressed={selected.version === unit.version && selected.stage === 'version'}
              >
                v{unit.version} {unit.isActive ? '●' : ''}
              </button>
              {unit.rounds.map((round) => (
                <div key={round.round} className="flex items-center gap-2">
                  <span className="text-cafe-muted" aria-hidden="true">
                    →
                  </span>
                  <RoundNode unit={unit} round={round} selected={selected} onSelect={onSelect} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function RoundNode({
  unit,
  round,
  selected,
  onSelect,
}: {
  unit: DemoLifelineVersion;
  round: DemoLifelineRound;
  selected: SelectedStage;
  onSelect: (stage: SelectedStage) => void;
}) {
  return (
    <article
      className="rounded-xl border border-cafe-subtle bg-cafe-surface-elevated p-2"
      data-testid={`f257-lifeline-round-${unit.version}-${round.round}`}
      data-version={unit.version}
      data-round={round.round}
    >
      <div className="mb-1.5 flex items-center gap-2">
        {round.isCurrent && (
          <SettingsBadge tone="blue" size="xxs">
            当前
          </SettingsBadge>
        )}
        {round.governanceOutcome && (
          <SettingsBadge tone={round.governanceOutcome === 'approved' ? 'emerald' : 'red'} size="xxs">
            {round.governanceOutcome}
          </SettingsBadge>
        )}
      </div>
      <div className="flex items-center gap-1">
        {LIFELINE_STAGES.map((stage, index) => (
          <div key={stage} className="flex items-center gap-1">
            {index > 0 && (
              <span className="text-cafe-muted" aria-hidden="true">
                →
              </span>
            )}
            <RoundStage version={unit.version} round={round} stage={stage} selected={selected} onSelect={onSelect} />
          </div>
        ))}
      </div>
    </article>
  );
}

function RoundStage({
  version,
  round,
  stage,
  selected,
  onSelect,
}: {
  version: number;
  round: DemoLifelineRound;
  stage: LifelineStage;
  selected: SelectedStage;
  onSelect: (stage: SelectedStage) => void;
}) {
  const state = roundStageState(round, stage);
  const outcome = stage === 'governance' ? round.governanceOutcome : null;
  const className = `rounded-md border px-2 py-1 text-micro font-medium ${stageClass(state, outcome)}`;
  const label = outcome ? `${stage} · ${outcome}` : stage;
  if (!round.isCurrent) return <span className={className}>{label}</span>;
  return (
    <button
      type="button"
      className={className}
      onClick={() => onSelect({ version, stage })}
      aria-pressed={selected.version === version && selected.stage === stage}
    >
      {label}
    </button>
  );
}

function VersionUnitModel({ scene }: { scene: JourneyScene }) {
  let title = '当前在 v1';
  let detail = '一个 version 是一个 unit；unit 内可以经历多轮 tracing → eval → governance。';
  if (scene.versionTransition?.toVersion === 2) {
    title = 'v1 → v2';
    detail = '应用内容修改才创建 v2；v2 从自己的第 1 轮 tracing 开始。';
  } else if (scene.candidate?.status === 'rejected') {
    title = '仍在 v1';
    detail = `内容未改，不创建新版本；当前进入 v1 的第 ${scene.roundInUnit} 轮。`;
  }
  return (
    <section
      className="mt-3 rounded-xl border border-cafe-subtle bg-cafe-surface-elevated px-3 py-2"
      data-testid="f257-version-unit-model"
    >
      <div className="flex flex-wrap items-center gap-2">
        <SettingsBadge tone="blue" size="xxs">
          version = unit
        </SettingsBadge>
        <strong className="text-sm text-cafe">{title}</strong>
      </div>
      <SettingsText as="p" variant="xs" tone="muted" className="mt-1">
        {detail}
      </SettingsText>
    </section>
  );
}

function JourneyStageDetail({
  selected,
  scene,
  ...decisionProps
}: {
  selected: SelectedStage;
  scene: JourneyScene;
  isRejecting: boolean;
  rejectionReason: string;
  onApprove: () => void;
  onStartReject: () => void;
  onChangeRejectionReason: (reason: string) => void;
  onConfirmReject: () => void;
  onCancelReject: () => void;
}) {
  if (selected.stage === 'eval') {
    return (
      <div className="space-y-4">
        <EvaluationEvidenceChain scene={scene} />
        <ObjectiveEvaluationPanel data={EVALUATION} />
      </div>
    );
  }
  if (selected.stage === 'governance') return <GovernanceSurface scene={scene} {...decisionProps} />;
  if (selected.stage === 'version') return <VersionDetail selected={selected} scene={scene} />;
  return <TracingEvidence scene={scene} />;
}

function EvaluationEvidenceChain({ scene }: { scene: JourneyScene }) {
  const evidence = scene.evaluationEvidence;
  if (!evidence) {
    return (
      <SettingsText as="p" variant="sm" tone="muted">
        当前轮还在收集证据，尚未冻结评估窗口。
      </SettingsText>
    );
  }
  return (
    <section className="space-y-3" data-testid="f257-journey-evaluation-evidence">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-cafe">评估证据链</h3>
        <SettingsBadge tone="blue" size="xxs">
          窗口已锁定
        </SettingsBadge>
      </div>
      <dl className="grid gap-2 rounded-xl border border-cafe-subtle bg-cafe-surface p-3 text-xs sm:grid-cols-2">
        <EvidenceRow label="评估内容" value={evidence.contentRef} />
        <EvidenceRow label="snapshot" value={evidence.snapshotId} />
        <EvidenceRow
          label="时间窗"
          value={`${new Date(evidence.window.start).toISOString()} → ${new Date(evidence.window.end).toISOString()}`}
        />
        <EvidenceRow label="数据来源" value={`${evidence.sourceKind} · ${evidence.sourceRefs.join(' · ')}`} />
      </dl>
      {evidence.metrics.map((metric) => (
        <article key={metric.metricId} className="rounded-xl border border-cafe-subtle bg-cafe-surface p-3">
          <div className="grid gap-2 text-xs sm:grid-cols-2">
            <EvidenceRow label="指标" value={`${metric.label} · ${metric.metricId}`} />
            <EvidenceRow label="规则" value={metric.rule} />
            <EvidenceRow label="measurement" value={metric.measurement} />
            <EvidenceRow label="判定" value={`${metric.decision} · ${metric.reason}`} />
          </div>
        </article>
      ))}
      <div className="rounded-xl bg-[var(--console-elevated-bg)] p-3 text-sm text-cafe">
        结论：<strong>{evidence.verdict}</strong>
      </div>
    </section>
  );
}

function EvidenceRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-cafe-muted">{label}</dt>
      <dd className="break-words font-mono text-cafe-secondary">{value}</dd>
    </div>
  );
}

function GovernanceSurface({
  scene,
  isRejecting,
  rejectionReason,
  onApprove,
  onStartReject,
  onChangeRejectionReason,
  onConfirmReject,
  onCancelReject,
}: {
  scene: JourneyScene;
  isRejecting: boolean;
  rejectionReason: string;
  onApprove: () => void;
  onStartReject: () => void;
  onChangeRejectionReason: (reason: string) => void;
  onConfirmReject: () => void;
  onCancelReject: () => void;
}) {
  const candidate = scene.candidate;
  if (!candidate) {
    return (
      <SettingsText as="p" variant="sm" tone="muted">
        评估尚未完成；系统不会提前创建干预建议。
      </SettingsText>
    );
  }
  if (candidate.status === 'approved') {
    return (
      <div className="space-y-3" data-testid="f257-journey-applied">
        <SettingsBadge tone="emerald" size="xxs">
          你批准了内容修改
        </SettingsBadge>
        <SettingsText as="p" variant="sm" tone="muted">
          底层 <code>setContentOverride</code> 已支持生成单调递增的内容版本。
        </SettingsText>
        <div className="rounded-xl border border-cafe-subtle bg-cafe-surface p-3">
          <strong className="text-sm text-cafe">审批接线待补</strong>
          <SettingsText as="p" variant="xs" tone="muted" className="mt-1">
            当前 Candidate 执行器尚未把内容修改审批接到该底层能力；这里是概念编排，不冒充已接通。
          </SettingsText>
        </div>
      </div>
    );
  }
  if (candidate.status === 'rejected') {
    return (
      <div className="space-y-3" data-testid="f257-journey-rejected">
        <SettingsBadge tone="slate" size="xxs">
          你拒绝了本次修改
        </SettingsBadge>
        <SettingsText as="p" variant="sm" tone="muted">
          内容保持不变，不生成新版本。理由已写入 Candidate.approval.note。
        </SettingsText>
        <blockquote className="rounded-xl border border-cafe-subtle bg-cafe-surface p-3 text-sm text-cafe">
          {candidate.decisionNote}
        </blockquote>
      </div>
    );
  }
  return (
    <div className="space-y-3" data-testid="f257-journey-approval-card">
      <div className="flex flex-wrap items-center gap-2">
        <SettingsBadge tone="emerald" size="xxs">
          系统自动创建
        </SettingsBadge>
        <SettingsText as="span" variant="xs" tone="muted">
          用户无需触发 governance；此处只做审批。
        </SettingsText>
      </div>
      <ApprovalDecisionCard
        testId="f257-journey-decision-card"
        title="修改内容后生成 v2"
        actionReason="评估结论已形成，系统建议修改 S13 内容。"
        recommendation={
          <GenericApprovalRecommendation
            item={approvalItemFor()}
            f193TargetThreadId=""
            sourceThreadTitle="F257 demo"
            targetThreadTitle={null}
            resolveCatName={(catId) => catId}
          />
        }
        currentDecision={
          isRejecting ? (
            <div className="space-y-2">
              <label className="block text-xs font-medium text-cafe" htmlFor="f257-reject-reason">
                拒绝理由（会保留给下一轮）
              </label>
              <textarea
                id="f257-reject-reason"
                data-testid="f257-journey-reject-reason"
                className="min-h-20 w-full rounded-lg border border-cafe-subtle bg-cafe-surface p-2 text-sm text-cafe"
                value={rejectionReason}
                onChange={(event) => onChangeRejectionReason(event.target.value)}
              />
              <div className="flex gap-2">
                <span data-testid="f257-journey-confirm-reject">
                  <SettingsPrimaryButton onClick={onConfirmReject} disabled={rejectionReason.trim().length === 0}>
                    确认拒绝
                  </SettingsPrimaryButton>
                </span>
                <SettingsSecondaryButton onClick={onCancelReject}>取消</SettingsSecondaryButton>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <span data-testid="f257-journey-apply">
                <SettingsPrimaryButton onClick={onApprove}>应用修改</SettingsPrimaryButton>
              </span>
              <span data-testid="f257-journey-reject">
                <SettingsSecondaryButton onClick={onStartReject}>拒绝并说明理由</SettingsSecondaryButton>
              </span>
            </div>
          )
        }
      />
    </div>
  );
}

function TracingEvidence({ scene }: { scene: JourneyScene }) {
  if (scene.id === 'next-round') {
    return (
      <div className="space-y-3">
        <h3 className="text-sm font-semibold text-cafe">新窗口从 tracing 开始</h3>
        <SettingsText as="p" variant="sm" tone="muted">
          本轮 observation set 为空；新证据到来后，再按同样的指标和治理循环评估。
        </SettingsText>
        {scene.nextEvaluationContext && (
          <section className="space-y-2 rounded-xl border border-cafe-subtle bg-cafe-surface p-3">
            <div className="flex flex-wrap items-center gap-2">
              <SettingsBadge tone="blue" size="xxs">
                Candidate.approval.note 已持久化
              </SettingsBadge>
              <SettingsBadge tone="amber" size="xxs">
                需要后端触点
              </SettingsBadge>
            </div>
            <SettingsText as="p" variant="xs" tone="muted">
              演示把拒绝理由带入下一轮上下文；生产端尚未自动桥接为 evaluator 输入。
            </SettingsText>
            <blockquote className="rounded-lg bg-cafe-surface-elevated p-2 text-sm text-cafe">
              {scene.nextEvaluationContext.rejectionNote}
            </blockquote>
          </section>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-cafe">结构化信号</h3>
      <div className="grid gap-2 sm:grid-cols-3">
        {['turn_schema_failure_1', 'turn_schema_failure_2', 'turn_schema_failure_3'].map((turnId, index) => (
          <article key={turnId} className="rounded-xl border border-cafe-subtle bg-cafe-surface p-3">
            <SettingsBadge tone="red" size="xxs">
              反例 {index + 1}/3
            </SettingsBadge>
            <p className="mt-2 font-mono text-micro text-cafe-secondary">{turnId}</p>
          </article>
        ))}
      </div>
      <SettingsText as="p" variant="xs" tone="muted">
        触发阈值只决定何时评估；指标规则才决定结论。
      </SettingsText>
    </div>
  );
}

function VersionDetail({ selected, scene }: { selected: SelectedStage; scene: JourneyScene }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-cafe">S13 · v{selected.version}</h3>
      <SettingsText as="p" variant="xs" tone="muted">
        这个 unit 当前在第 {scene.roundInUnit} 轮；内容、评估窗口和治理决定按版本保留，可向前后版本追溯。
      </SettingsText>
    </div>
  );
}

function ResponsibilityCard({ scene }: { scene: JourneyScene }) {
  const ownerLabels: Record<JourneyScene['transitionOwner'], string> = {
    'tracing-runtime': '系统收集证据',
    'evaluation-runtime': '系统执行评估',
    'governance-worker': '系统生成建议',
    operator: '你作出审批决定',
  };
  return (
    <section className="rounded-xl border border-cafe-subtle bg-cafe-surface p-3">
      <h3 className="text-sm font-semibold text-cafe">这一小步由谁负责</h3>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-micro">
        <dt className="text-cafe-muted">步骤</dt>
        <dd>{scene.stepLabel}</dd>
        <dt className="text-cafe-muted">责任</dt>
        <dd>{ownerLabels[scene.transitionOwner]}</dd>
        <dt className="text-cafe-muted">当前版本</dt>
        <dd>v{scene.activeVersion}</dd>
        <dt className="text-cafe-muted">版本内轮次</dt>
        <dd>第 {scene.roundInUnit} 轮</dd>
        <dt className="text-cafe-muted">需要你点击</dt>
        <dd>{scene.operatorActionRequired === 'apply-or-reject' ? '应用或拒绝' : '不需要'}</dd>
      </dl>
    </section>
  );
}

function TruthBoundaryCard({ scene }: { scene: JourneyScene }) {
  return (
    <section className="rounded-xl border border-cafe-subtle bg-cafe-surface p-3">
      <h3 className="text-sm font-semibold text-cafe">功能边界</h3>
      <div className="mt-2 space-y-2">
        <SettingsBadge tone="emerald" size="xxs">
          内容版本底层能力可用
        </SettingsBadge>
        <SettingsText as="p" variant="xs" tone="muted">
          内容写入会生成单调递增版本；版本生命线来自现有产品组件。
        </SettingsText>
        {scene.candidate?.status === 'approved' && (
          <SettingsText as="p" variant="xs" tone="muted">
            Candidate 审批到内容写入的自动接线尚未完成，本 Demo 明示为概念编排。
          </SettingsText>
        )}
        {scene.nextEvaluationContext && (
          <SettingsText as="p" variant="xs" tone="muted">
            拒绝理由的持久化已存在；自动进入下一轮 evaluator 仍需要后端触点。
          </SettingsText>
        )}
      </div>
    </section>
  );
}

const controlClass =
  'rounded-full border border-cafe-subtle bg-cafe-surface px-3 py-1 text-xs font-medium text-cafe transition hover:bg-cafe-muted disabled:cursor-not-allowed disabled:opacity-40';
const activeControlClass =
  'rounded-full border border-cafe-accent bg-cafe-accent px-3 py-1 text-xs font-semibold text-[var(--cafe-accent-foreground)]';
const stepClass =
  'rounded-md border border-cafe-subtle bg-cafe-surface px-2 py-1 text-micro text-cafe-muted transition hover:text-cafe';
const activeStepClass =
  'rounded-md border border-cafe-accent bg-cafe-accent px-2 py-1 text-micro font-semibold text-[var(--cafe-accent-foreground)]';
const versionClass =
  'rounded-md border border-cafe-subtle bg-cafe-surface px-2.5 py-1.5 text-xs font-semibold text-cafe';
const activeVersionClass =
  'rounded-md border border-cafe-accent bg-cafe-accent px-2.5 py-1.5 text-xs font-semibold text-[var(--cafe-accent-foreground)]';
