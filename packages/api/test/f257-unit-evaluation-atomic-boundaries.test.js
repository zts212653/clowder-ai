import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { FakeRedis } from './helpers/fake-redis.js';

const { TraceAnnotationStore } = await import(
  '../dist/infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.js'
);
const { ObjectiveEvaluationRuntime } = await import(
  '../dist/infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js'
);
const { SegmentEvaluationReadModel } = await import(
  '../dist/infrastructure/harness-eval/evaluation/SegmentEvaluationReadModel.js'
);

function annotation(index, metricId, polarity = 'counterexample', unitId = 'S13', incidentKey) {
  return {
    annotationId: `ann-${index}`,
    episodeRef: {
      traceTurnId: `turn-${index}`,
      invocationId: `inv-${index}`,
      ownerUserId: 'owner-1',
      threadId: 'thread-1',
      catId: 'cat-1',
      inputMessageId: `input-${index}`,
      outputMessageId: `output-${index}`,
      terminalAt: 100 + index,
      terminalKind: 'completed',
      toolCalls: [],
    },
    source: 'structured-rule',
    ruleId: 'rule-v1',
    objectiveId: 'mixed-objective',
    metricId,
    unitRefs: [{ unitType: 'segment', unitId }],
    polarity,
    confidence: 1,
    incidentKey: incidentKey ?? `incident-${metricId}-${index}`,
    evidenceRefs: [`invocation://inv-${index}`],
    createdAt: 100 + index,
  };
}

const countMetric = {
  id: 'tool-schema-failure-count',
  label: 'Count',
  kind: 'counter',
  evaluator: { kind: 'code', ruleRef: 'counter-distinct-episodes-v1' },
  trigger: { kind: 'distinct-counterexamples', threshold: 1 },
};

const secondaryCountMetric = {
  id: 'secondary-failure-count',
  label: 'Secondary count',
  kind: 'counter',
  evaluator: { kind: 'code', ruleRef: 'secondary-distinct-episodes-v1' },
  trigger: { kind: 'distinct-counterexamples', threshold: 3 },
};

const semanticMetric = {
  id: 'tool-choice-correctness',
  label: 'Semantic',
  kind: 'semantic',
  evaluator: { kind: 'llm', ruleRef: 'tool-choice-correctness-semantic' },
  trigger: { kind: 'cadence', cadence: 'daily' },
};

const rateMetric = {
  id: 'tool-discovery-success-rate',
  label: 'Rate',
  kind: 'rate',
  evaluator: { kind: 'code', ruleRef: 'tool-discovery-success' },
  trigger: { kind: 'minimum-sample', minimum: 3, windowMs: 1000 },
};

const mixedCatalog = {
  registry: {
    registryVersion: 2,
    evaluationModels: [
      {
        id: 'em-mixed',
        label: 'Mixed',
        ruleVersion: 'v1',
        metrics: [countMetric, semanticMetric],
      },
    ],
    objectives: [
      {
        id: 'mixed-objective',
        label: 'Mixed',
        statement: 'Mixed objective',
        evaluationModelId: 'em-mixed',
      },
    ],
  },
  manifest: {
    manifestVersion: 1,
    registryVersion: 2,
    units: [
      { unitId: 'S13', hookId: 's13-doc', unitState: 'evaluable', objectives: [{ objectiveId: 'mixed-objective' }] },
      { unitId: 'D11', hookId: 'd11-doc', unitState: 'evaluable', objectives: [{ objectiveId: 'mixed-objective' }] },
    ],
  },
};

const rateMixedCatalog = {
  registry: {
    registryVersion: 2,
    evaluationModels: [
      {
        id: 'em-rate-mixed',
        label: 'Rate Mixed',
        ruleVersion: 'v1',
        metrics: [rateMetric, semanticMetric],
      },
    ],
    objectives: [
      {
        id: 'rate-mixed-objective',
        label: 'Rate Mixed',
        statement: 'Rate mixed objective',
        evaluationModelId: 'em-rate-mixed',
      },
    ],
  },
  manifest: {
    manifestVersion: 1,
    registryVersion: 2,
    units: [
      {
        unitId: 'S13',
        hookId: 's13-doc',
        unitState: 'evaluable',
        objectives: [{ objectiveId: 'rate-mixed-objective' }],
      },
    ],
  },
};

const aggregateCounterCatalog = {
  registry: {
    registryVersion: 2,
    evaluationModels: [
      {
        id: 'em-aggregate-counter',
        label: 'Aggregate counter',
        ruleVersion: 'v1',
        metrics: [
          { ...countMetric, trigger: { kind: 'distinct-counterexamples', threshold: 3 } },
          secondaryCountMetric,
        ],
      },
    ],
    objectives: [
      {
        id: 'mixed-objective',
        label: 'Aggregate counter',
        statement: 'Aggregate explicit counterexamples across the Unit',
        evaluationModelId: 'em-aggregate-counter',
      },
    ],
  },
  manifest: {
    manifestVersion: 1,
    registryVersion: 2,
    units: [
      { unitId: 'S13', hookId: 's13-doc', unitState: 'evaluable', objectives: [{ objectiveId: 'mixed-objective' }] },
    ],
  },
};

function runtimeWithSemanticEvaluator(redis, catalog, annotations) {
  return new ObjectiveEvaluationRuntime(redis, catalog, annotations, {
    // The production reader is classification-independent. This fixture derives
    // matching raw episodes from annotations solely to keep these atomic-boundary
    // tests focused on Unit windows/commits rather than trace persistence.
    traceStore: {
      async queryUnitWindow(ownerUserId, unitRefs, startMs, endMs) {
        const records = [];
        for (const objective of catalog.registry.objectives) {
          const model = catalog.registry.evaluationModels.find(
            (candidate) => candidate.id === objective.evaluationModelId,
          );
          if (!model) continue;
          for (const metric of model.metrics) {
            records.push(
              ...(await annotations.queryMetricWindow(ownerUserId, objective.id, metric.id, startMs, endMs)),
            );
          }
        }
        const byInvocation = new Map();
        for (const record of records) {
          if (
            !record.unitRefs.some((recordUnit) =>
              unitRefs.some(
                (unitRef) => unitRef.unitType === recordUnit.unitType && unitRef.unitId === recordUnit.unitId,
              ),
            )
          ) {
            continue;
          }
          byInvocation.set(record.episodeRef.invocationId, {
            summary: {
              turnId: record.episodeRef.traceTurnId,
              threadId: record.episodeRef.threadId,
              catId: record.episodeRef.catId,
              timestamp: record.createdAt,
              segments: record.unitRefs.map((unitRef) => ({
                segmentId: unitRef.unitId,
                stage: 'per-turn',
                status: 'observed',
                contentHash: `hash-${record.annotationId}`,
                charCount: 10,
                tokenEstimate: 3,
                pipelineStatus: 'fired',
              })),
              delivery: [],
              totalCharCount: 10,
              totalTokenEstimate: 3,
              totalSegmentsObserved: record.unitRefs.length,
              totalSegmentsAbsent: 0,
              durationMs: 1,
            },
            terminal: { ...record.episodeRef, terminalAt: record.createdAt },
          });
        }
        return [...byInvocation.values()].sort((left, right) => left.terminal.terminalAt - right.terminal.terminalAt);
      },
      async countSegmentWindow(_ownerUserId, _segmentId, _startMs, _endMs) {
        // Atomic-boundary tests derive corpus from annotations; return annotation
        // count as a reasonable proxy for per-segment episode count.
        let total = 0;
        for (const objective of catalog.registry.objectives) {
          const model = catalog.registry.evaluationModels.find((c) => c.id === objective.evaluationModelId);
          if (!model) continue;
          for (const metric of model.metrics) {
            const records = await annotations.queryMetricWindow(
              _ownerUserId,
              objective.id,
              metric.id,
              _startMs,
              _endMs,
            );
            total += records.filter((r) =>
              r.unitRefs.some((ref) => ref.unitType === 'segment' && ref.unitId === _segmentId),
            ).length;
          }
        }
        return total;
      },
      async countUnclassified() {
        return 0;
      },
    },
    semanticEvaluator: {
      async evaluate({ retrieval }) {
        const inspected = retrieval.take(50);
        return {
          labels: { acceptable: inspected.episodes.length, counterexample: 0 },
          explanation: 'Atomic-boundary fixture inspected the frozen raw Unit corpus.',
        };
      },
    },
  });
}

describe('F257 Unit-scoped evaluation atomic boundaries', () => {
  test('Unit readiness aggregates distinct counterexamples across metrics', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = new ObjectiveEvaluationRuntime(redis, aggregateCounterCatalog, annotations);

    await runtime.append(annotation(1, countMetric.id));
    await runtime.append(annotation(2, countMetric.id));
    assert.equal(await runtime.judgments.latest('owner-1', 'mixed-objective'), null);

    await runtime.append(annotation(3, secondaryCountMetric.id));
    const judgment = await runtime.judgments.latest('owner-1', 'mixed-objective');
    assert.ok(judgment, 'the third Unit counterexample triggers even though neither metric reached three alone');
    assert.deepEqual(new Set(judgment.annotationIds), new Set(['ann-1', 'ann-2', 'ann-3']));
  });

  test('Unit readiness does not double-count one incident classified into multiple metrics', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = new ObjectiveEvaluationRuntime(redis, aggregateCounterCatalog, annotations);

    await runtime.append(annotation(10, countMetric.id, 'counterexample', 'S13', 'shared-incident'));
    await runtime.append(annotation(11, secondaryCountMetric.id, 'counterexample', 'S13', 'shared-incident'));
    await runtime.append(annotation(12, countMetric.id));
    assert.equal(await runtime.judgments.latest('owner-1', 'mixed-objective'), null);

    await runtime.append(annotation(13, secondaryCountMetric.id));
    assert.ok(
      await runtime.judgments.latest('owner-1', 'mixed-objective'),
      'only the third distinct Unit incident triggers evaluation',
    );
  });

  test('P1-1 mixed Unit does not starve cadence when event-driven metric is ready before cadence', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = runtimeWithSemanticEvaluator(redis, mixedCatalog, annotations);

    // Day 1: event-driven count triggers a Unit run.
    await runtime.append(annotation(1, countMetric.id));
    const judgment1 = await runtime.judgments.latest('owner-1', 'mixed-objective');
    assert.ok(judgment1);
    assert.equal(judgment1.completion, 'complete');
    assert.equal(judgment1.window.start, 0);
    assert.equal(judgment1.window.end, judgment1.evaluatedAt);

    // Day 1 + 1ms: a new semantic sample arrives. The cadence watermark is not
    // elapsed, but the event-driven count metric has no new samples in the new
    // window. The semantic cadence metric must NOT trigger because cadence has
    // not elapsed.
    const justAfter = judgment1.window.end + 1;
    await annotations.append({ ...annotation(2, semanticMetric.id, 'positive'), createdAt: justAfter });
    await runtime.runCadenceMetrics('owner-1', justAfter);
    const latest = await runtime.judgments.latest('owner-1', 'mixed-objective');
    assert.equal(latest.judgmentId, judgment1.judgmentId, 'cadence must not trigger before watermark');

    // Day + daily: cadence has elapsed. The same semantic sample should now
    // trigger a new Unit run.
    const nextDay = judgment1.window.end + 24 * 60 * 60 * 1000 + 1;
    await runtime.runCadenceMetrics('owner-1', nextDay);
    const judgment2 = await runtime.judgments.latest('owner-1', 'mixed-objective');
    assert.notEqual(judgment2.judgmentId, judgment1.judgmentId);
    // F257 R11: the semantic window is frozen at the previous completed run's
    // exclusive upper bound, not at the newest consumed sample timestamp.
    assert.equal(judgment2.window.start, judgment1.window.end);
    assert.equal(judgment2.window.end, nextDay);
    assert.equal(judgment2.metricOutcomes.length, 2);
    assert.equal(judgment2.metricOutcomes.find((o) => o.metricId === semanticMetric.id).status, 'evaluated');
  });

  test('P1-1 mixed Unit cadence can also force a run when watermark has elapsed', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = runtimeWithSemanticEvaluator(redis, mixedCatalog, annotations);

    await runtime.append(annotation(1, countMetric.id));
    const judgment1 = await runtime.judgments.latest('owner-1', 'mixed-objective');

    // After the cadence elapses, a new event-driven counter triggers the Unit
    // even though the semantic cadence metric has no samples.
    const nextDay = judgment1.window.end + 24 * 60 * 60 * 1000 + 1;
    await annotations.append({ ...annotation(2, countMetric.id), createdAt: nextDay });
    await runtime.append({ ...annotation(2, countMetric.id), createdAt: nextDay });
    const judgment2 = await runtime.judgments.latest('owner-1', 'mixed-objective');
    assert.notEqual(judgment2.judgmentId, judgment1.judgmentId);
    assert.equal(judgment2.window.start, judgment1.window.end);
  });

  test('P1-2 snapshot window freezes [lastCompleted.end, now) cohort, not per-metric rolling lookback', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = runtimeWithSemanticEvaluator(redis, mixedCatalog, annotations);

    // First run at t=1000 with one counterexample.
    await annotations.append(annotation(1, countMetric.id));
    await runtime.runCadenceMetrics('owner-1', 1000);
    const judgment1 = await runtime.judgments.latest('owner-1', 'mixed-objective');
    assert.equal(judgment1.window.start, 0);
    assert.equal(judgment1.window.end, 1000);

    // Second run at t=2000: an old annotation at t=50 must NOT be included
    // because it is before the last completed composite watermark (101), even
    // if a metric's lookback would have included it. The semantic cadence has
    // not elapsed, so use a fresh event-driven counterexample to trigger the
    // Unit run.
    await annotations.append({ ...annotation(2, countMetric.id), createdAt: 50 });
    await annotations.append({ ...annotation(3, countMetric.id), createdAt: 1500 });
    await runtime.append({ ...annotation(4, countMetric.id), createdAt: 2000 });
    const judgment2 = await runtime.judgments.latest('owner-1', 'mixed-objective');
    // F257 R11: the second window must start at the first run's exclusive upper
    // bound (1000), so the late arrival at t=50 is excluded even though it is
    // unconsumed and would have fit a per-metric rolling lookback.
    assert.equal(judgment2.window.start, 1000);
    assert.deepEqual(
      judgment2.annotationIds.sort(),
      [annotation(3, countMetric.id).annotationId, annotation(4, countMetric.id).annotationId].sort(),
    );
  });

  test('P1-3 insufficient evidence for rate metric returns terminal outcome instead of throwing', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = runtimeWithSemanticEvaluator(redis, rateMixedCatalog, annotations);

    // Only 2 samples within the rate lookback, but minimum is 3.
    await annotations.append({
      ...annotation(1, rateMetric.id, 'positive'),
      objectiveId: 'rate-mixed-objective',
      createdAt: 1500,
    });
    await annotations.append({
      ...annotation(2, rateMetric.id, 'counterexample'),
      objectiveId: 'rate-mixed-objective',
      createdAt: 1600,
    });

    // The cadence watermark has elapsed (no prior completed run). The semantic
    // metric has no samples and the rate metric is below minimum; both must
    // emit terminal insufficient_evidence outcomes instead of throwing.
    await runtime.runCadenceMetrics('owner-1', 1500 + 24 * 60 * 60 * 1000);
    const judgment = await runtime.judgments.latest('owner-1', 'rate-mixed-objective');
    assert.ok(judgment);
    assert.equal(judgment.completion, 'complete');
    assert.equal(judgment.metricResults.length, 1, 'semantic result is terminal while the rate is insufficient');
    assert.deepEqual(
      judgment.metricOutcomes.filter((o) => o.metricId === rateMetric.id),
      [{ metricId: rateMetric.id, status: 'insufficient_evidence', reason: 'insufficient_evidence' }],
    );
  });

  test('P1-4 commit is atomic: partial failure leaves no durable side effects', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = runtimeWithSemanticEvaluator(redis, mixedCatalog, annotations);

    await annotations.append(annotation(1, countMetric.id));

    // Sabotage the atomic Lua commit so the completed-snapshot write fails.
    // Partial failures must leave no durable side effects.
    const originalEval = redis.eval.bind(redis);
    redis.eval = async (script, ...args) => {
      if (String(script).includes('@fake-redis-handler: commitUnitRun')) {
        throw new Error('injected_commit_failure');
      }
      return originalEval(script, ...args);
    };

    // First attempt fails during the atomic commit. The deterministic snapshot is
    // the same on retry, so the stale pending key can resume the same Unit run.
    await runtime.runCadenceMetrics('owner-1', 1000);

    // The atomic commit should fail and leave no results or judgment visible.
    const results = await runtime.results.queryMetricWindow('owner-1', 'mixed-objective', countMetric.id, 0, 2000);
    assert.equal(results.length, 0);
    const judgment = await runtime.judgments.latest('owner-1', 'mixed-objective');
    assert.equal(judgment, null);

    // The annotation must remain unconsumed so the next attempt can retry.
    const consumed = await runtime.snapshots.consumedAnnotationIds('owner-1', 'mixed-objective');
    assert.equal(consumed.has(annotation(1, countMetric.id).annotationId), false);

    // Restore and retry: the same snapshot deterministically succeeds.
    redis.eval = originalEval;
    await runtime.runCadenceMetrics('owner-1', 1000);
    const retryResults = await runtime.results.queryMetricWindow('owner-1', 'mixed-objective', countMetric.id, 0, 2000);
    assert.equal(retryResults.length, 1);
    const retryJudgment = await runtime.judgments.latest('owner-1', 'mixed-objective');
    assert.ok(retryJudgment);
  });

  test('P1-5 Console read model exposes all metric results to every member of one Objective Unit', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = runtimeWithSemanticEvaluator(redis, mixedCatalog, annotations);

    // S13 contributes only a count counterexample; D11 contributes only a
    // semantic positive. They share the same objective but different segments.
    // Use annotations.append so the cadence-due sweep evaluates both metrics in
    // the same Unit run (no prior completed run, so the semantic cadence is due).
    await annotations.append(annotation(1, countMetric.id, 'counterexample', 'S13'));
    await annotations.append({ ...annotation(2, semanticMetric.id, 'positive', 'D11'), createdAt: 1999 });
    await runtime.runCadenceMetrics('owner-1', 2000);

    const s13 = await new SegmentEvaluationReadModel(runtime).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 3000,
    });
    const s13Count = s13.objectives[0].metrics.find((m) => m.metricId === countMetric.id);
    const s13Semantic = s13.objectives[0].metrics.find((m) => m.metricId === semanticMetric.id);
    assert.ok(s13Count.latestEvaluation);
    assert.ok(s13Semantic.latestEvaluation);

    const d11 = await new SegmentEvaluationReadModel(runtime).read({
      ownerUserId: 'owner-1',
      segmentId: 'D11',
      startMs: 0,
      endMs: 3000,
    });
    const d11Count = d11.objectives[0].metrics.find((m) => m.metricId === countMetric.id);
    const d11Semantic = d11.objectives[0].metrics.find((m) => m.metricId === semanticMetric.id);
    assert.ok(d11Count.latestEvaluation);
    assert.ok(d11Semantic.latestEvaluation);
  });

  test('P1-6 judgment carries metric outcome vector and completion, not hard-coded pass/fail', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = runtimeWithSemanticEvaluator(redis, mixedCatalog, annotations);

    await runtime.append(annotation(1, countMetric.id));
    const judgment = await runtime.judgments.latest('owner-1', 'mixed-objective');
    assert.ok(judgment);
    assert.equal('status' in judgment && ['passed', 'failed', 'partial'].includes(judgment.status), false);
    assert.equal(judgment.completion, 'complete');
    assert.equal(judgment.metricResults.length, 2);
    assert.deepEqual(judgment.metricResults[0].value, { kind: 'counter', count: 1, threshold: 1 });
    assert.deepEqual(judgment.metricOutcomes, [
      { metricId: countMetric.id, status: 'evaluated' },
      { metricId: semanticMetric.id, status: 'evaluated' },
    ]);
  });

  test('R10 cadence watermark uses Unit evaluatedAt, not last sample timestamp', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = runtimeWithSemanticEvaluator(redis, mixedCatalog, annotations);

    // The sample is ancient, but the Unit is evaluated at day 2.
    const day2 = 2 * 24 * 60 * 60 * 1000;
    await annotations.append({ ...annotation(1, semanticMetric.id, 'positive'), createdAt: 100 });
    await runtime.runCadenceMetrics('owner-1', day2);
    const judgment1 = await runtime.judgments.latest('owner-1', 'mixed-objective');
    assert.ok(judgment1);

    // Only 1ms has elapsed since the Unit completed; the cadence watermark must
    // be evaluatedAt, so the same daily semantic metric must not run again.
    await runtime.runCadenceMetrics('owner-1', day2 + 1);
    const latest = await runtime.judgments.latest('owner-1', 'mixed-objective');
    assert.equal(latest.judgmentId, judgment1.judgmentId, 'cadence must not trigger 1ms after completion');
  });

  test('R10 identical annotation append is idempotent and does not raise conflict', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const ann = annotation(1, countMetric.id);

    const first = await annotations.append(ann);
    assert.equal(first.outcome, 'created');

    const second = await annotations.append(ann);
    assert.equal(second.outcome, 'duplicate');
    assert.equal(second.annotationId, first.annotationId);

    const window = await annotations.queryMetricWindow('owner-1', 'mixed-objective', countMetric.id, 0, 200);
    assert.equal(window.length, 1);
  });

  test('R10 production-epoch same-ms annotations keep distinct sequence slots', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const now = Date.now();

    const ann1 = { ...annotation(1, countMetric.id), createdAt: now };
    const ann2 = { ...annotation(2, countMetric.id), createdAt: now, incidentKey: 'incident-r10-2' };
    await annotations.append(ann1);
    await annotations.append(ann2);

    const window = await annotations.queryMetricWindow('owner-1', 'mixed-objective', countMetric.id, now, now + 1);
    assert.equal(window.length, 2);

    const sequences = window.map((annotation) => annotation.sequence ?? 0).sort((left, right) => left - right);
    assert.ok(sequences[1] > sequences[0], 'same-ms annotations must receive distinct sequences');
  });

  test('R11 same annotationId with conflicting payload is rejected and rolls back incident claim', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const ann = annotation(1, countMetric.id);

    const first = await annotations.append(ann);
    assert.equal(first.outcome, 'created');

    // Same ID but a different incident payload must be a conflict, not a silent
    // duplicate, and the new incident claim must not be left behind.
    const conflicting = { ...ann, incidentKey: 'incident-conflicting' };
    await assert.rejects(annotations.append(conflicting), /trace_annotation_conflict:ann-1/);

    const window = await annotations.queryMetricWindow('owner-1', 'mixed-objective', countMetric.id, 0, 200);
    assert.equal(window.length, 1);
    assert.equal(window[0].incidentKey, ann.incidentKey);

    const duplicate = await annotations.append(ann);
    assert.equal(duplicate.outcome, 'duplicate');
    assert.equal(duplicate.annotationId, first.annotationId);
  });

  test('R11 late arrival before lastCompleted.end is excluded from the next window', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = runtimeWithSemanticEvaluator(redis, mixedCatalog, annotations);

    // First run completes at t=1000 with a sample at t=900.
    await annotations.append({ ...annotation(1, countMetric.id), createdAt: 900 });
    await runtime.runCadenceMetrics('owner-1', 1000);
    const judgment1 = await runtime.judgments.latest('owner-1', 'mixed-objective');
    assert.equal(judgment1.window.start, 0);
    assert.equal(judgment1.window.end, 1000);

    // A late arrival at t=500 (below the completed window end) plus a fresh
    // event at t=1500. Only the fresh event may be in the next window.
    await annotations.append({ ...annotation(2, countMetric.id), createdAt: 500 });
    await runtime.append({ ...annotation(3, countMetric.id), createdAt: 1500 });
    const judgment2 = await runtime.judgments.latest('owner-1', 'mixed-objective');
    assert.notEqual(judgment2.judgmentId, judgment1.judgmentId);
    assert.equal(judgment2.window.start, 1000);
    assert.deepEqual(judgment2.annotationIds, [annotation(3, countMetric.id).annotationId]);

    const consumed = await runtime.snapshots.consumedAnnotationIds('owner-1', 'mixed-objective');
    assert.equal(consumed.has(annotation(2, countMetric.id).annotationId), false);
  });

  test('R13 incident alias is authoritative for different annotationId', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const ann = annotation(1, countMetric.id);

    const first = await annotations.append(ann);
    assert.equal(first.outcome, 'created');

    const sameIncident = { ...annotation(2, countMetric.id), incidentKey: ann.incidentKey, annotationId: 'ann-2' };
    const second = await annotations.append(sameIncident);
    assert.equal(second.outcome, 'duplicate');
    assert.equal(second.annotationId, ann.annotationId);

    const window = await annotations.queryMetricWindow('owner-1', 'mixed-objective', countMetric.id, 0, 200);
    assert.equal(window.length, 1);
    assert.equal(window[0].annotationId, ann.annotationId);
  });

  test('R13 persisted annotation retry is a stable duplicate', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const ann = annotation(1, countMetric.id);

    const first = await annotations.append(ann);
    assert.equal(first.outcome, 'created');

    const persisted = await annotations.get(ann.annotationId);
    assert.ok(persisted);

    const retry = await annotations.append(persisted);
    assert.equal(retry.outcome, 'duplicate');
    assert.equal(retry.annotationId, ann.annotationId);

    const after = await annotations.get(ann.annotationId);
    assert.equal(after.sequence, persisted.sequence);

    const window = await annotations.queryMetricWindow('owner-1', 'mixed-objective', countMetric.id, 0, 200);
    assert.equal(window.length, 1);
  });
});
