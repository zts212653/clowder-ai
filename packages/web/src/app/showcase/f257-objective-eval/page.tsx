'use client';

import type { SegmentEvaluationResponse, VersionEpoch } from '@cat-cafe/shared';
import { useMemo, useState } from 'react';
import { LifelineChainView, type SelectedStage } from '@/components/settings/LifelineChainView';
import { ObjectiveEvaluationPanel } from '@/components/settings/ObjectiveEvaluationPanel';
import { VersionContentPreview } from '@/components/settings/SegmentLifelineModal';
import { SegmentTraceTheater } from '@/components/settings/SegmentTraceTheater';

const WINDOW = {
  start: Date.UTC(2026, 6, 27, 12),
  end: Date.UTC(2026, 7, 3, 12),
};

const evaluation: SegmentEvaluationResponse = {
  segmentId: 'S13',
  window: WINDOW,
  tracing: {
    trigger: {
      traceCount: 146,
      traceRequired: 200,
      windowMs: 7 * 24 * 60 * 60 * 1000,
      counterexampleCount: 2,
      counterexampleRequired: 3,
      perObjective: [
        {
          objectiveId: 'tool-access-correct-use',
          traceCount: 146,
          traceRequired: 200,
          windowStartMs: WINDOW.start,
          windowEndMs: WINDOW.end,
          counterexampleCount: 2,
          counterexampleRequired: 3,
        },
      ],
    },
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
      },
    ],
    unclassifiedEpisodeCount: 42,
  },
  objectives: [
    {
      objectiveId: 'tool-access-correct-use',
      objectiveLabel: '工具可达与正确使用',
      evaluationModelId: 'em-tool-access-correct-use',
      evaluationModelLabel: '工具可达与正确使用评估',
      ruleVersion: 'v1',
      unitRefs: [{ unitType: 'segment', unitId: 'S13' }],
      latestJudgment: {
        judgmentId: 'judgment-s13-showcase',
        completion: 'complete',
        evaluatedAt: WINDOW.end,
        window: WINDOW,
        metricOutcomes: [
          { metricId: 'tool-schema-failure-count', status: 'evaluated' },
          { metricId: 'tool-discovery-success-rate', status: 'evaluated' },
          { metricId: 'tool-choice-correctness', status: 'evaluated' },
        ],
      },
      metrics: [
        {
          metricId: 'tool-schema-failure-count',
          label: '工具名或 Schema 校验失败次数',
          kind: 'counter',
          evaluatorKind: 'code',
          evaluatorRuleRef: 'tool-schema-failure',
          trigger: { kind: 'distinct-counterexamples', threshold: 3 },
          collection: {
            window: WINDOW,
            positive: 0,
            counterexamples: 3,
            candidates: 0,
            classifiedTotal: 3,
            pendingTowardTrigger: 3,
            required: 3,
          },
          latestEvaluation: {
            result: {
              resultId: 'result-s13-schema-failure',
              snapshotId: 'snapshot-s13-schema-failure',
              ownerUserId: 'showcase',
              objectiveId: 'tool-access-correct-use',
              metricId: 'tool-schema-failure-count',
              kind: 'counter',
              value: { kind: 'counter', count: 3, threshold: 3 },
              evaluatedAt: WINDOW.end,
            },
            window: WINDOW,
          },
        },
        {
          metricId: 'tool-discovery-success-rate',
          label: '明示工具检索后的成功调用率',
          kind: 'rate',
          evaluatorKind: 'code',
          evaluatorRuleRef: 'tool-discovery-success',
          trigger: { kind: 'minimum-sample', minimum: 10, windowMs: 604_800_000 },
          collection: {
            window: WINDOW,
            positive: 8,
            counterexamples: 2,
            candidates: 0,
            classifiedTotal: 10,
            pendingTowardTrigger: 10,
            required: 10,
          },
          latestEvaluation: {
            result: {
              resultId: 'result-s13-discovery',
              snapshotId: 'snapshot-s13-discovery',
              ownerUserId: 'showcase',
              objectiveId: 'tool-access-correct-use',
              metricId: 'tool-discovery-success-rate',
              kind: 'rate',
              value: { kind: 'rate', numerator: 8, denominator: 10, rate: 0.8 },
              evaluatedAt: WINDOW.end,
            },
            window: WINDOW,
          },
        },
        {
          metricId: 'tool-choice-correctness',
          label: '语义场景下工具选择与参数正确性',
          kind: 'semantic',
          evaluatorKind: 'llm',
          evaluatorRuleRef: 'tool-choice-correctness-semantic',
          trigger: { kind: 'cadence', cadence: 'weekly' },
          collection: {
            window: WINDOW,
            positive: 2,
            counterexamples: 1,
            candidates: 5,
            classifiedTotal: 3,
            pendingTowardTrigger: 0,
            required: null,
          },
          latestEvaluation: null,
        },
      ],
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
    origin: 'manifest',
    startedAt: WINDOW.start,
    status: 'tracing',
    isActive: true,
    tracing: {
      observationCount: observations.length,
      firedCount: observations.length,
      firstAt: observations[1].timestamp,
      lastAt: observations[0].timestamp,
    },
    eval: null,
    governance: null,
    events: [],
  },
];

export default function F257ObjectiveEvalShowcase() {
  const [selected, setSelected] = useState<SelectedStage>({ version: 1, stage: 'tracing' });
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
        selected={selected}
        onSelect={setSelected}
        activeStage="tracing"
        actionable={{ stage: null, candidateCount: 0, source: 'candidate-count' }}
      />

      {selected.stage === 'version' && <VersionContentPreview segmentId="S13" epoch={chain[0]} />}
      {selected.stage === 'tracing' && (
        <SegmentTraceTheater
          segmentId="S13"
          observations={versionObservations}
          total={observations.length}
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
