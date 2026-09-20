'use client';

import type { SegmentCycleSummary, SegmentEvaluationResponse, VersionEpoch } from '@cat-cafe/shared';
import { useMemo, useState } from 'react';
import { LifelineChainView, type SelectedStage } from '@/components/settings/LifelineChainView';
import { ObjectiveEvaluationPanel } from '@/components/settings/ObjectiveEvaluationPanel';
import { SegmentTraceTheater } from '@/components/settings/SegmentTraceTheater';
import { VersionContentPreview } from '@/components/settings/VersionContentPreview';

const WINDOW = {
  start: Date.UTC(2026, 6, 27, 12),
  end: Date.UTC(2026, 7, 3, 12),
};

const evaluation: SegmentEvaluationResponse = {
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
        cadence: { elapsedMs: WINDOW.end - WINDOW.start, thresholdMs: 604_800_000, eligible: true },
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
        createdAt: Date.UTC(2026, 7, 3, 10, 42),
        rationale: '工具名不存在，调用在 schema 校验前失败',
        threadId: 'thread_s13_showcase',
        turnId: 'turn_schema_failure',
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
          evidenceRefs: ['invocation://inv-s13-schema-failure'],
        },
        {
          metricId: 'tool-discovery-success-rate',
          label: '明示工具检索后的成功调用率',
          kind: 'rate',
          evaluatorKind: 'code',
          evaluatorRuleRef: 'tool-discovery-success',
          verdictRule: { kind: 'rate-minimum', minimum: 0.9 },
          latestConclusion: { kind: 'rate-badness', value: 0.2, howCounted: '2/10 次失败' },
          evidenceRefs: [],
        },
        {
          metricId: 'tool-choice-correctness',
          label: '语义场景下工具选择与参数正确性',
          kind: 'semantic',
          evaluatorKind: 'llm',
          evaluatorRuleRef: 'tool-choice-correctness-semantic',
          verdictRule: { kind: 'evidence-only' },
          latestConclusion: null,
          evidenceRefs: [],
        },
      ],
      selectedCycle: {
        cycleId: 'cycle-s13-showcase',
        segmentVersion: 1,
        version: 'S13@1',
        versionContentRef: 'hook:S13@1',
        cycleStart: WINDOW.start,
        cycleEnd: WINDOW.end,
        evalStatus: 'written',
        windows: [WINDOW],
        triggeredBy: ['counterexamples'],
        evaluation: { overall: 'complete', writtenAt: WINDOW.end, by: 'cat-evaluator' },
        governance: { decision: 'evolve', reason: '降低工具调用失败', writtenAt: WINDOW.end, by: 'cat-evaluator' },
        governanceImpact: {
          changedUnitIds: ['S13'],
          selectedSegmentChanged: true,
          changes: [{ action: 'modify', unitId: 'S13', sourceVersion: 1, targetVersion: 2 }],
        },
        approval: { cardId: 'HGP-showcase', state: 'pending', rejectCount: 0, at: WINDOW.end },
        rejectReasons: [],
        termination: null,
        closedAt: null,
      },
      currentCycle: {
        cycleId: 'cycle-s13-showcase',
        segmentVersion: 1,
        version: 'S13@1',
        versionContentRef: 'hook:S13@1',
        cycleStart: WINDOW.start,
        cycleEnd: WINDOW.end,
        evalStatus: 'written',
        windows: [WINDOW],
        triggeredBy: ['counterexamples'],
        evaluation: { overall: 'complete', writtenAt: WINDOW.end, by: 'cat-evaluator' },
        governance: { decision: 'evolve', reason: '降低工具调用失败', writtenAt: WINDOW.end, by: 'cat-evaluator' },
        governanceImpact: {
          changedUnitIds: ['S13'],
          selectedSegmentChanged: true,
          changes: [{ action: 'modify', unitId: 'S13', sourceVersion: 1, targetVersion: 2 }],
        },
        approval: { cardId: 'HGP-showcase', state: 'pending', rejectCount: 0, at: WINDOW.end },
        rejectReasons: [],
        termination: null,
        closedAt: null,
      },
      latestEvaluation: {
        cycleId: 'cycle-s13-showcase',
        overall: 'complete',
        writtenAt: WINDOW.end,
        by: 'cat-evaluator',
        windows: [WINDOW],
      },
      latestGovernance: {
        cycleId: 'cycle-s13-showcase',
        decision: 'evolve',
        reason: '降低工具调用失败',
        writtenAt: WINDOW.end,
        by: 'cat-evaluator',
        approval: { cardId: 'HGP-showcase', state: 'pending', rejectCount: 0, at: WINDOW.end },
        impact: {
          changedUnitIds: ['S13'],
          selectedSegmentChanged: true,
          changes: [{ action: 'modify', unitId: 'S13', sourceVersion: 1, targetVersion: 2 }],
        },
      },
      versionChain: [],
      versionChainCapped: false,
    },
  ],
};

const observations = [
  {
    threadId: 'thread_s13_showcase',
    turnId: 'turn_schema_failure',
    timestamp: Date.UTC(2026, 7, 3, 10, 42),
    catId: 'cat-reviewer',
    pipelineStatus: 'fired',
    version: 1,
    charCount: 1739,
  },
  {
    threadId: 'thread_s13_showcase',
    turnId: 'turn_discovery_success',
    timestamp: Date.UTC(2026, 7, 3, 9, 18),
    catId: 'cat-architect',
    pipelineStatus: 'fired',
    version: 1,
    charCount: 1264,
  },
];

const chain: VersionEpoch[] = [
  {
    version: 1,
    parentVersion: null,
    origin: 'manifest',
    startedAt: WINDOW.start,
    status: 'tracing',
    isActive: true,
    tracing: {
      observationCount: observations.length,
      firedCount: observations.length,
      disabledCount: 0,
      firstAt: observations[1].timestamp,
      lastAt: observations[0].timestamp,
    },
    eval: null,
    governance: null,
    events: [],
  },
];

const SHOWCASE_PRIOR_CYCLE = evaluation.objectives[0]?.currentCycle;
const SHOWCASE_CURRENT_CYCLE: SegmentCycleSummary | null = SHOWCASE_PRIOR_CYCLE
  ? {
      ...SHOWCASE_PRIOR_CYCLE,
      cycleId: 'cycle-s13-current',
      cycleStart: WINDOW.end,
      cycleEnd: null,
      evalStatus: 'idle',
      windows: [],
      triggeredBy: [],
      evaluation: null,
      governance: null,
      approval: null,
      closedAt: null,
      ordinal: 2,
    }
  : null;
const SHOWCASE_CYCLES = [SHOWCASE_PRIOR_CYCLE, SHOWCASE_CURRENT_CYCLE].filter(
  (cycle): cycle is SegmentCycleSummary => cycle !== null,
);

export default function F257ObjectiveEvalShowcase() {
  const [selected, setSelected] = useState<SelectedStage>({
    version: 1,
    stage: 'tracing',
    ...(SHOWCASE_CURRENT_CYCLE ? { cycleId: SHOWCASE_CURRENT_CYCLE.cycleId } : {}),
  });
  const versionObservations = useMemo(
    () => observations.filter((observation) => observation.version === selected.version),
    [selected.version],
  );
  return (
    <main className="mx-auto max-w-5xl space-y-6 p-6">
      <header>
        <p className="text-sm font-medium text-cafe-muted">S13 · MCP 工具文档</p>
        <h1 className="mt-1 text-2xl font-semibold text-cafe">版本生命线验收</h1>
        <p className="mt-2 text-sm text-cafe-secondary">
          先选择版本生命线阶段；Tracing 下选择某一场 TraceEpisode 才进入回放，Eval 下查看该版本窗口的指标。
        </p>
      </header>

      <LifelineChainView
        chain={chain}
        cycles={SHOWCASE_CYCLES}
        currentCycleId={SHOWCASE_CURRENT_CYCLE?.cycleId}
        selected={selected}
        onSelect={setSelected}
      />

      {selected.stage === 'version' && <VersionContentPreview segmentId="S13" epoch={chain[0]} />}
      {selected.stage === 'tracing' && (
        <SegmentTraceTheater
          segmentId="S13"
          observations={versionObservations}
          window={{ startMs: WINDOW.start, endMs: WINDOW.end }}
          readiness={evaluation.tracing}
        />
      )}
      {selected.stage === 'eval' && <ObjectiveEvaluationPanel data={evaluation} />}
      {selected.stage === 'governance' && (
        <section className="rounded-2xl bg-[var(--console-panel-bg)] p-4 text-sm text-cafe-muted">
          当前无治理候选；版本继续 tracing，不阻塞，也不会自动禁用。
        </section>
      )}
    </main>
  );
}
