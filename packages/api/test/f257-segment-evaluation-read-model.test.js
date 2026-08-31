import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { ObjectiveEvaluationRuntime } = await import(
  '../dist/infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js'
);
const { SegmentEvaluationReadModel } = await import(
  '../dist/infrastructure/harness-eval/evaluation/SegmentEvaluationReadModel.js'
);
const { resolveEvaluationWindow } = await import('../dist/routes/segment-evaluation.js');
const { TraceAnnotationStore } = await import(
  '../dist/infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.js'
);

class FakeRedis {
  constructor() {
    this.strings = new Map();
    this.sets = new Map();
    this.zsets = new Map();
  }
  async set(key, value, ...args) {
    if (args.includes('NX') && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return 'OK';
  }
  async get(key) {
    return this.strings.get(key) ?? null;
  }
  async del(key) {
    const had = this.strings.has(key) || this.sets.has(key) || this.zsets.has(key);
    this.strings.delete(key);
    this.sets.delete(key);
    this.zsets.delete(key);
    return had ? 1 : 0;
  }
  async incr(key) {
    const current = this.strings.has(key) ? Number(this.strings.get(key)) : 0;
    const next = current + 1;
    this.strings.set(key, String(next));
    return next;
  }
  async type(key) {
    if (this.strings.has(key)) return 'string';
    if (this.sets.has(key)) return 'set';
    if (this.zsets.has(key)) return 'zset';
    return 'none';
  }
  async sadd(key, ...members) {
    const values = this.sets.get(key) ?? new Set();
    for (const member of members) values.add(member);
    this.sets.set(key, values);
    return members.length;
  }
  async smembers(key) {
    return [...(this.sets.get(key) ?? [])];
  }
  async zadd(key, score, member) {
    const values = this.zsets.get(key) ?? new Map();
    values.set(member, Number(score));
    this.zsets.set(key, values);
    return 1;
  }
  async zrangebyscore(key, min, max) {
    const minExclusive = String(min).startsWith('(');
    const maxExclusive = String(max).startsWith('(');
    const minScore = Number(String(min).replace(/^\(/, ''));
    const maxScore = Number(String(max).replace(/^\(/, ''));
    return [...(this.zsets.get(key) ?? new Map()).entries()]
      .filter(([, score]) => {
        if (minExclusive ? score <= minScore : score < minScore) return false;
        if (maxExclusive ? score >= maxScore : score > maxScore) return false;
        return true;
      })
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .map(([member]) => member);
  }
  async zrevrange(key, start, end) {
    return [...(this.zsets.get(key) ?? new Map()).entries()]
      .sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))
      .slice(start, end + 1)
      .map(([member]) => member);
  }
}

const countMetric = {
  id: 'tool-schema-failure-count',
  label: '工具名或 Schema 校验失败次数',
  kind: 'counter',
  evaluator: { kind: 'code', ruleRef: 'tool-schema-failure' },
  trigger: { kind: 'distinct-counterexamples', threshold: 3 },
};
const semanticMetric = {
  id: 'tool-choice-correctness',
  label: '语义场景下工具选择与参数正确性',
  kind: 'semantic',
  evaluator: { kind: 'llm', ruleRef: 'tool-choice-correctness-semantic' },
  trigger: { kind: 'cadence', cadence: 'weekly' },
};

function annotation(index, polarity = 'counterexample', unitId = 'S13') {
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
    ruleId: 'tool-schema-failure',
    objectiveId: 'tool-access-correct-use',
    metricId: countMetric.id,
    unitRefs: [{ unitType: 'segment', unitId }],
    polarity,
    confidence: 1,
    incidentKey: `incident-${index}`,
    evidenceRefs: [`invocation://inv-${index}`],
    createdAt: 100 + index,
  };
}

function episode(index, unitId = 'S13') {
  return {
    summary: {
      turnId: `turn-${index}`,
      threadId: 'thread-1',
      catId: 'cat-1',
      timestamp: 90 + index,
      segments: [
        {
          segmentId: unitId,
          stage: 'per-turn',
          status: 'observed',
          contentHash: `hash-${index}`,
          charCount: 10,
          tokenEstimate: 3,
          pipelineStatus: 'fired',
        },
      ],
      delivery: [],
      totalCharCount: 10,
      totalTokenEstimate: 3,
      totalSegmentsObserved: 1,
      totalSegmentsAbsent: 0,
      durationMs: 1,
    },
    terminal: annotation(index, 'counterexample', unitId).episodeRef,
  };
}

function runtimeFor(redis, annotations, episodes) {
  return new ObjectiveEvaluationRuntime(redis, catalog, annotations, {
    traceStore: {
      async queryUnitWindow(ownerUserId, unitRefs, startMs, endMs) {
        return episodes.filter(
          (item) =>
            item.terminal.ownerUserId === ownerUserId &&
            item.terminal.terminalAt >= startMs &&
            item.terminal.terminalAt < endMs &&
            item.summary.segments.some((segment) =>
              unitRefs.some((unitRef) => unitRef.unitType === 'segment' && unitRef.unitId === segment.segmentId),
            ),
        );
      },
      async countSegmentWindow(ownerUserId, segmentId, startMs, endMs) {
        return episodes.filter(
          (item) =>
            item.terminal.ownerUserId === ownerUserId &&
            item.terminal.terminalAt >= startMs &&
            item.terminal.terminalAt < endMs &&
            item.summary.segments.some((segment) => segment.segmentId === segmentId && segment.status === 'observed'),
        ).length;
      },
      async countUnclassified(_ownerUserId, _startMs, _endMs) {
        return 0;
      },
    },
    semanticEvaluator: {
      async evaluate({ retrieval }) {
        const inspected = retrieval.take(50);
        return {
          labels: { acceptable: inspected.episodes.length, counterexample: 0 },
          explanation: 'Deterministic read-model fixture inspected the frozen Unit corpus.',
        };
      },
    },
  });
}

const catalog = {
  registry: {
    registryVersion: 2,
    evaluationModels: [
      {
        id: 'em-tool-access-correct-use',
        label: '工具可达与正确使用评估',
        ruleVersion: 'v1',
        metrics: [countMetric, semanticMetric],
      },
    ],
    objectives: [
      {
        id: 'tool-access-correct-use',
        label: '工具能力可达与正确使用',
        statement: 'Use the right tool correctly',
        evaluationModelId: 'em-tool-access-correct-use',
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
        objectives: [{ objectiveId: 'tool-access-correct-use' }],
      },
      {
        unitId: 'D11',
        hookId: 'd11-skill-trigger',
        unitState: 'evaluable',
        objectives: [{ objectiveId: 'tool-access-correct-use' }],
      },
    ],
  },
};

describe('F257 SegmentEvaluationReadModel', () => {
  test('S13 exposes its Objective, Evaluation Model, metrics, count progress and result window', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2), episode(3)]);
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    await runtime.append(annotation(3));

    const view = await new SegmentEvaluationReadModel(runtime).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: Date.now() + 1,
    });
    assert.equal(view.objectives.length, 1);
    assert.deepEqual(view.objectives[0].unitRefs, [
      { unitType: 'segment', unitId: 'S13' },
      { unitType: 'segment', unitId: 'D11' },
    ]);
    assert.deepEqual(
      {
        objectiveId: view.objectives[0].objectiveId,
        evaluationModelId: view.objectives[0].evaluationModelId,
        metricIds: view.objectives[0].metrics.map((metric) => metric.metricId),
      },
      {
        objectiveId: 'tool-access-correct-use',
        evaluationModelId: 'em-tool-access-correct-use',
        metricIds: ['tool-schema-failure-count', 'tool-choice-correctness'],
      },
    );
    const count = view.objectives[0].metrics[0];
    // Annotations were consumed by the Unit run; collection shows remaining pending
    // candidates only, while the committed result carries the historical count.
    assert.equal(count.collection.counterexamples, 0);
    assert.equal(count.collection.required, 3);
    assert.equal(count.collection.pendingTowardTrigger, 0);
    assert.deepEqual(count.latestEvaluation.result.value, { kind: 'counter', count: 3, threshold: 3 });
    assert.deepEqual(count.latestEvaluation.window, { start: 0, end: count.latestEvaluation.result.evaluatedAt });
    assert.equal(view.objectives[0].metrics[1].latestEvaluation.result.value.kind, 'semantic');
  });

  test('shares one Objective Unit result across all member segments while keeping annotation progress local', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2), episode(3), episode(4, 'D11')]);
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    await runtime.append(annotation(3));
    await runtime.append(annotation(4, 'counterexample', 'D11'));

    const d11 = await new SegmentEvaluationReadModel(runtime).read({
      ownerUserId: 'owner-1',
      segmentId: 'D11',
      startMs: 0,
      endMs: Date.now() + 1,
    });
    const metric = d11.objectives[0].metrics[0];
    // D11 has one local pending counterexample. The completed judgment is still
    // visible because S13 and D11 are members of one Objective Unit.
    assert.equal(metric.collection.counterexamples, 1);
    assert.equal(metric.collection.pendingTowardTrigger, 1);
    assert.deepEqual(metric.latestEvaluation.result.value, { kind: 'counter', count: 3, threshold: 3 });
  });

  test('exposes Unit tracing readiness and structured counterexamples without metric buckets', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = runtimeFor(redis, annotations, [episode(1), episode(2)]);
    await annotations.append(annotation(1));
    await annotations.append(annotation(2));

    const view = await new SegmentEvaluationReadModel(runtime).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 1000,
    });

    assert.deepEqual(view.tracing.trigger, {
      traceCount: 2,
      traceRequired: 200,
      // No prior evaluation → fallback window [max(0, 1000-7d), 1000) = [0, 1000)
      // Actual windowMs = endMs - windowStart = 1000 - 0 = 1000
      windowMs: 1000,
      counterexampleCount: 2,
      counterexampleRequired: 3,
      perObjective: [
        {
          objectiveId: 'tool-access-correct-use',
          traceCount: 2,
          traceRequired: 200,
          windowStartMs: 0,
          windowEndMs: 1000,
          counterexampleCount: 2,
          counterexampleRequired: 3,
        },
      ],
    });
    assert.equal(view.tracing.structuredCounterexamples.length, 2);
    assert.deepEqual(
      view.tracing.structuredCounterexamples.map(({ incidentKey, metricId }) => ({ incidentKey, metricId })),
      [
        { incidentKey: 'incident-1', metricId: countMetric.id },
        { incidentKey: 'incident-2', metricId: countMetric.id },
      ],
    );
    assert.equal(view.objectives[0].metrics[0].evaluatorRuleRef, 'tool-schema-failure');
  });

  test('multi-Objective segment uses per-Objective watermark, not Math.max', async () => {
    // S13 belongs to two Objectives with different completedWindowEnd values:
    // obj-A completed at t=500, obj-B completed at t=900.
    // Episodes exist at t=600, 700, 950. Using Math.max(500,900)=900 would
    // miss the t=600, 700 episodes. Per-Objective counting should give the
    // MAX count across Objectives (3 from obj-A, not 1 from obj-B).
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);

    const multiObjCatalog = {
      registry: {
        registryVersion: 2,
        evaluationModels: [
          {
            id: 'em-obj-a',
            label: 'Model A',
            ruleVersion: 'v1',
            metrics: [countMetric],
          },
          {
            id: 'em-obj-b',
            label: 'Model B',
            ruleVersion: 'v1',
            metrics: [semanticMetric],
          },
        ],
        objectives: [
          { id: 'obj-a', label: 'Objective A', statement: 'A', evaluationModelId: 'em-obj-a' },
          { id: 'obj-b', label: 'Objective B', statement: 'B', evaluationModelId: 'em-obj-b' },
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
            objectives: [{ objectiveId: 'obj-a' }, { objectiveId: 'obj-b' }],
          },
        ],
      },
    };

    const episodes = [episode(1, 'S13'), episode(2, 'S13'), episode(3, 'S13')];
    // Override terminalAt to t=600, 700, 950
    episodes[0].terminal.terminalAt = 600;
    episodes[1].terminal.terminalAt = 700;
    episodes[2].terminal.terminalAt = 950;

    const runtime = new ObjectiveEvaluationRuntime(redis, multiObjCatalog, annotations, {
      traceStore: {
        async queryUnitWindow(ownerUserId, unitRefs, startMs, endMs) {
          return episodes.filter(
            (item) =>
              item.terminal.ownerUserId === ownerUserId &&
              item.terminal.terminalAt >= startMs &&
              item.terminal.terminalAt < endMs &&
              item.summary.segments.some((seg) =>
                unitRefs.some((ref) => ref.unitType === 'segment' && ref.unitId === seg.segmentId),
              ),
          );
        },
        async countSegmentWindow(ownerUserId, segmentId, startMs, endMs) {
          return episodes.filter(
            (item) =>
              item.terminal.ownerUserId === ownerUserId &&
              item.terminal.terminalAt >= startMs &&
              item.terminal.terminalAt < endMs &&
              item.summary.segments.some((seg) => seg.segmentId === segmentId && seg.status === 'observed'),
          ).length;
        },
        async countUnclassified(_ownerUserId, _startMs, _endMs) {
          return 0;
        },
      },
      semanticEvaluator: {
        async evaluate({ retrieval }) {
          const inspected = retrieval.take(50);
          return {
            labels: { acceptable: inspected.episodes.length, counterexample: 0 },
            explanation: 'Multi-objective fixture.',
          };
        },
      },
    });

    // Set different completedWindowEnd for each Objective
    await redis.set('harness-unit-run-completed-window-end:owner-1:obj-a', '500');
    await redis.set('harness-unit-run-completed-window-end:owner-1:obj-b', '900');

    const view = await new SegmentEvaluationReadModel(runtime).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 1000,
    });

    // Per-Objective counting: obj-a counts from 500 → 3 episodes (600,700,950)
    // obj-b counts from 900 → 1 episode (950). MAX = 3.
    assert.equal(view.tracing.trigger.traceCount, 3);
    // windowMs reflects the most favorable window [500, 1000)
    assert.equal(view.tracing.trigger.windowMs, 500);
    // Per-Objective projection: each Objective has its own window and count
    assert.deepEqual(view.tracing.trigger.perObjective, [
      {
        objectiveId: 'obj-a',
        traceCount: 3,
        traceRequired: 200,
        windowStartMs: 500,
        windowEndMs: 1000,
        counterexampleCount: 0,
        counterexampleRequired: 3,
      },
      {
        objectiveId: 'obj-b',
        traceCount: 1,
        traceRequired: 200,
        windowStartMs: 900,
        windowEndMs: 1000,
        counterexampleCount: null,
        counterexampleRequired: null,
      },
    ]);
  });

  test('per-Objective counterexample: O1=2/3 + O2=2/5 does not inflate to union 4/3', async () => {
    // Adversarial regression: two Objectives with different counterexample
    // thresholds. Union counting would show 4/3 (looks ready); per-Objective
    // correctly shows O1=2/3 and O2=2/5 (neither ready).
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const adversarialCatalog = {
      registry: {
        registryVersion: 2,
        evaluationModels: [
          {
            id: 'em-o1',
            label: 'Model O1',
            ruleVersion: 'v1',
            metrics: [
              {
                id: 'cx-o1',
                label: 'CX O1',
                kind: 'counter',
                evaluator: { kind: 'code', ruleRef: 'cx-o1-rule' },
                trigger: { kind: 'distinct-counterexamples', threshold: 3 },
              },
            ],
          },
          {
            id: 'em-o2',
            label: 'Model O2',
            ruleVersion: 'v1',
            metrics: [
              {
                id: 'cx-o2',
                label: 'CX O2',
                kind: 'counter',
                evaluator: { kind: 'code', ruleRef: 'cx-o2-rule' },
                trigger: { kind: 'distinct-counterexamples', threshold: 5 },
              },
            ],
          },
        ],
        objectives: [
          { id: 'o1', label: 'Objective 1', statement: 'O1', evaluationModelId: 'em-o1' },
          { id: 'o2', label: 'Objective 2', statement: 'O2', evaluationModelId: 'em-o2' },
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
            objectives: [{ objectiveId: 'o1' }, { objectiveId: 'o2' }],
          },
        ],
      },
    };
    const episodes = [episode(1, 'S13'), episode(2, 'S13')];
    const runtime = new ObjectiveEvaluationRuntime(redis, adversarialCatalog, annotations, {
      traceStore: {
        async queryUnitWindow(ownerUserId, unitRefs, startMs, endMs) {
          return episodes.filter(
            (ep) =>
              ep.terminal.ownerUserId === ownerUserId &&
              ep.terminal.terminalAt >= startMs &&
              ep.terminal.terminalAt < endMs &&
              ep.summary.segments.some((seg) =>
                unitRefs.some((ref) => ref.unitType === 'segment' && ref.unitId === seg.segmentId),
              ),
          );
        },
        async countSegmentWindow(ownerUserId, segmentId, startMs, endMs) {
          return episodes.filter(
            (ep) =>
              ep.terminal.ownerUserId === ownerUserId &&
              ep.terminal.terminalAt >= startMs &&
              ep.terminal.terminalAt < endMs &&
              ep.summary.segments.some((seg) => seg.segmentId === segmentId && seg.status === 'observed'),
          ).length;
        },
        async countUnclassified(_ownerUserId, _startMs, _endMs) {
          return 0;
        },
      },
      semanticEvaluator: {
        async evaluate({ retrieval }) {
          const inspected = retrieval.take(50);
          return {
            labels: { acceptable: inspected.episodes.length, counterexample: 0 },
            explanation: 'Adversarial fixture.',
          };
        },
      },
    });
    // 2 counterexamples for O1 (threshold 3)
    await annotations.append({ ...annotation(1), objectiveId: 'o1', metricId: 'cx-o1', incidentKey: 'o1-inc-1' });
    await annotations.append({ ...annotation(2), objectiveId: 'o1', metricId: 'cx-o1', incidentKey: 'o1-inc-2' });
    // 2 counterexamples for O2 (threshold 5)
    await annotations.append({ ...annotation(3), objectiveId: 'o2', metricId: 'cx-o2', incidentKey: 'o2-inc-1' });
    await annotations.append({ ...annotation(4), objectiveId: 'o2', metricId: 'cx-o2', incidentKey: 'o2-inc-2' });

    const view = await new SegmentEvaluationReadModel(runtime).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 1000,
    });

    // Per-Objective: neither O1 (2/3) nor O2 (2/5) is ready
    assert.deepEqual(view.tracing.trigger.perObjective, [
      {
        objectiveId: 'o1',
        traceCount: 2,
        traceRequired: 200,
        windowStartMs: 0,
        windowEndMs: 1000,
        counterexampleCount: 2,
        counterexampleRequired: 3,
      },
      {
        objectiveId: 'o2',
        traceCount: 2,
        traceRequired: 200,
        windowStartMs: 0,
        windowEndMs: 1000,
        counterexampleCount: 2,
        counterexampleRequired: 5,
      },
    ]);
    // Summary uses MAX count / MIN threshold, NOT union count
    // Old code would show 4/3 (union of 4 distinct incidents >= 3). Wrong.
    // New code shows 2/3 (MAX per-Objective count). Correct.
    assert.equal(view.tracing.trigger.counterexampleCount, 2, 'summary must be MAX(2,2)=2, not union 4');
    assert.equal(view.tracing.trigger.counterexampleRequired, 3, 'summary must be MIN(3,5)=3');
  });

  test('counterexampleCount excludes consumed annotations (scheduler-aligned)', async () => {
    // Sol R4 probe: watermark=900, consumed annotation at t=500 → counterexampleCount=0
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const ep = episode(1, 'S13');
    ep.terminal.terminalAt = 950;
    const runtime = runtimeFor(redis, annotations, [ep]);
    // Annotation at t=500, consumed by prior evaluation run
    await annotations.append({ ...annotation(1), createdAt: 500 });
    // Mark ann-1 as consumed + set watermark at 900
    await redis.sadd('harness-evaluation-consumed-annotation:owner-1:tool-access-correct-use', 'ann-1');
    await redis.set('harness-unit-run-completed-window-end:owner-1:tool-access-correct-use', '900');

    const view = await new SegmentEvaluationReadModel(runtime).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 1000,
    });
    // Consumed annotation must not inflate counterexample count
    assert.equal(
      view.tracing.trigger.perObjective[0].counterexampleCount,
      0,
      'consumed annotation at t=500 must not count when watermark=900',
    );
    assert.equal(view.tracing.trigger.counterexampleCount, 0);
  });

  test('watermark=900 + unconsumed annotation t=500 → all three consumers return 0', async () => {
    // Sol R5 probe: annotation NOT consumed, but watermark=900 means the metric
    // window starts at 900. All three consumers (trigger, structured list, metric) must align.
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const ep = episode(1, 'S13');
    ep.terminal.terminalAt = 950;
    const runtime = runtimeFor(redis, annotations, [ep]);
    // Annotation at t=500 — NOT consumed, but before watermark
    await annotations.append({ ...annotation(1), createdAt: 500 });
    await redis.set('harness-unit-run-completed-window-end:owner-1:tool-access-correct-use', '900');

    const view = await new SegmentEvaluationReadModel(runtime).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 1000,
    });
    // 1) trigger perObjective counterexampleCount
    assert.equal(
      view.tracing.trigger.perObjective[0].counterexampleCount,
      0,
      'trigger: unconsumed t=500 before watermark=900 must not count',
    );
    // 2) structuredCounterexamples list
    assert.equal(view.tracing.structuredCounterexamples.length, 0, 'structured list: pre-watermark must not appear');
    // 3) readMetric collection
    assert.equal(
      view.objectives[0].metrics[0].collection.counterexamples,
      0,
      'metric collection: pre-watermark must not appear',
    );
  });

  test('first-window: readiness floor = max(0, end-7d) when no watermark', async () => {
    // Sol R6 probe: end=700000000, no watermark, annotation t=100.
    // READINESS_WINDOW = 604800000 (7d). Floor = max(0, 700000000-604800000) = 95200000.
    // Annotation at t=100 < 95200000 → all consumers must return 0.
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const runtime = runtimeFor(redis, annotations, []);
    await annotations.append({ ...annotation(1), createdAt: 100 });

    const view = await new SegmentEvaluationReadModel(runtime).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 700000000,
    });
    assert.equal(
      view.tracing.trigger.perObjective[0].counterexampleCount,
      0,
      'trigger: annotation t=100 before readiness floor',
    );
    assert.equal(
      view.tracing.structuredCounterexamples.length,
      0,
      'structured: annotation t=100 before readiness floor',
    );
    assert.equal(
      view.objectives[0].metrics[0].collection.counterexamples,
      0,
      'metric: annotation t=100 before readiness floor',
    );
  });

  test('annotationLists use readiness floor, not input.startMs', async () => {
    // Sol R6 probe: completed=100, input.start=500, annotation t=300, end=1000.
    // Readiness floor = completed = 100. Annotation t=300 in [100, 1000).
    // Old code: annotationLists queried with start=500, pre-filtering t=300 out.
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const ep = episode(1, 'S13');
    ep.terminal.terminalAt = 950;
    const runtime = runtimeFor(redis, annotations, [ep]);
    await annotations.append({ ...annotation(1), createdAt: 300 });
    await redis.set('harness-unit-run-completed-window-end:owner-1:tool-access-correct-use', '100');

    const view = await new SegmentEvaluationReadModel(runtime).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 500,
      endMs: 1000,
    });
    assert.equal(
      view.tracing.trigger.perObjective[0].counterexampleCount,
      1,
      'trigger: annotation t=300 in readiness [100, 1000)',
    );
    assert.equal(
      view.tracing.structuredCounterexamples.length,
      1,
      'structured: annotation t=300 in readiness [100, 1000)',
    );
    assert.equal(
      view.objectives[0].metrics[0].collection.counterexamples,
      1,
      'metric: annotation t=300 in readiness [100, 1000)',
    );
  });

  test('unclassifiedEpisodeCount reflects mock store value in readiness window', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const unclassifiedCount = 42;
    const runtime = new ObjectiveEvaluationRuntime(redis, catalog, annotations, {
      traceStore: {
        async queryUnitWindow() {
          return [];
        },
        async countSegmentWindow() {
          return 0;
        },
        async countUnclassified(_ownerUserId, _startMs, _endMs) {
          return unclassifiedCount;
        },
      },
      semanticEvaluator: {
        async evaluate({ retrieval }) {
          const inspected = retrieval.take(50);
          return {
            labels: { acceptable: inspected.episodes.length, counterexample: 0 },
            explanation: 'Unclassified count fixture.',
          };
        },
      },
    });

    const view = await new SegmentEvaluationReadModel(runtime).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 1000,
    });

    assert.equal(
      view.tracing.unclassifiedEpisodeCount,
      unclassifiedCount,
      'unclassifiedEpisodeCount must surface mock store value',
    );
  });

  test('resolves explicit version windows and rejects partial coordinates', () => {
    assert.deepEqual(resolveEvaluationWindow({ startMs: '100', endMs: '200' }, 999), { startMs: 100, endMs: 200 });
    assert.equal(resolveEvaluationWindow({ startMs: '100' }, 999), null);
    assert.equal(resolveEvaluationWindow({ startMs: '200', endMs: '100' }, 999), null);
  });
});
