import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { TraceAnnotationStore } = await import(
  '../dist/infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.js'
);
const { EvaluationSnapshotStore } = await import(
  '../dist/infrastructure/harness-eval/evaluation/EvaluationSnapshotStore.js'
);
const { MetricResultStore } = await import('../dist/infrastructure/harness-eval/evaluation/MetricResultStore.js');
const { EvaluationScheduler, evaluateCounterSnapshot, evaluateRateSnapshot } = await import(
  '../dist/infrastructure/harness-eval/evaluation/EvaluationScheduler.js'
);
const { ObjectiveEvaluationRuntime } = await import(
  '../dist/infrastructure/harness-eval/evaluation/ObjectiveEvaluationRuntime.js'
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
    const set = this.sets.get(key) ?? new Set();
    let added = 0;
    for (const member of members) {
      if (!set.has(member)) added++;
      set.add(member);
    }
    this.sets.set(key, set);
    return added;
  }

  async smembers(key) {
    return [...(this.sets.get(key) ?? new Set())];
  }

  async zadd(key, score, member) {
    const zset = this.zsets.get(key) ?? new Map();
    zset.set(member, Number(score));
    this.zsets.set(key, zset);
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

  async zcount(key, min, max) {
    return (await this.zrangebyscore(key, min, max)).length;
  }

  async zrevrange(key, start, end) {
    return [...(this.zsets.get(key) ?? new Map()).entries()]
      .sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))
      .slice(start, end + 1)
      .map(([member]) => member);
  }
}

function annotation(index, incidentKey = `incident-${index}`) {
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
    ruleId: 'tool-schema-error-v1',
    objectiveId: 'tool-access-correct-use',
    metricId: 'tool-schema-failure-count',
    unitRefs: [{ unitType: 'segment', unitId: 'S13' }],
    polarity: 'counterexample',
    confidence: 1,
    incidentKey,
    evidenceRefs: [`invocation://inv-${index}`],
    createdAt: 100 + index,
  };
}

const evaluationModel = {
  id: 'em-tool',
  label: 'Tool access evaluation model',
  ruleVersion: 'v1',
  metrics: [
    {
      id: 'tool-schema-failure-count',
      label: '工具名或 Schema 校验失败次数',
      kind: 'counter',
      evaluator: { kind: 'code', ruleRef: 'counter-distinct-episodes-v1' },
      trigger: { kind: 'distinct-counterexamples', threshold: 3 },
    },
  ],
};

const rateEvaluationModel = {
  id: 'em-tool',
  label: 'Tool access evaluation model',
  ruleVersion: 'v1',
  metrics: [
    {
      id: 'tool-discovery-success-rate',
      label: '明示工具检索后的成功调用率',
      kind: 'rate',
      evaluator: { kind: 'code', ruleRef: 'tool-discovery-success' },
      trigger: { kind: 'minimum-sample', minimum: 3, windowMs: 1000 },
    },
  ],
};

const unitRefs = [{ unitType: 'segment', unitId: 'S13' }];

function traceEpisode(index) {
  const terminal = annotation(index).episodeRef;
  return {
    summary: {
      turnId: terminal.traceTurnId,
      threadId: terminal.threadId,
      catId: terminal.catId,
      timestamp: terminal.terminalAt - 1,
      segments: [
        {
          segmentId: 'S13',
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
    terminal,
  };
}

function scheduleInput(evaluationModel, now = 1000) {
  return {
    ownerUserId: 'owner-1',
    objectiveId: 'tool-access-correct-use',
    evaluationModel,
    unitRefs,
    now,
  };
}

describe('F257 Unit EvaluationScheduler', () => {
  test('three distinct counterexample episodes trigger one count result without a denominator', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const snapshots = new EvaluationSnapshotStore(redis);
    const results = new MetricResultStore(redis);
    const raw = [traceEpisode(1), traceEpisode(2), traceEpisode(3)];
    const scheduler = new EvaluationScheduler({
      annotations,
      snapshots,
      traces: {
        queryUnitWindow: async (_ownerUserId, _unitRefs, startMs, endMs) =>
          raw.filter((item) => item.terminal.terminalAt >= startMs && item.terminal.terminalAt < endMs),
        countSegmentWindow: async (_ownerUserId, _segmentId, startMs, endMs) =>
          raw.filter((item) => item.terminal.terminalAt >= startMs && item.terminal.terminalAt < endMs).length,
      },
    });

    await annotations.append(annotation(1));
    assert.deepEqual(await scheduler.schedule(scheduleInput(evaluationModel)), {
      status: 'not-ready',
      observed: 1,
      required: 3,
    });

    await annotations.append(annotation(2));
    // A second producer naming the same incident must not change readiness.
    await annotations.append({ ...annotation(20, 'incident-2'), annotationId: 'ann-duplicate-producer' });
    assert.deepEqual(await scheduler.schedule(scheduleInput(evaluationModel)), {
      status: 'not-ready',
      observed: 2,
      required: 3,
    });

    await annotations.append(annotation(3));
    const scheduled = await scheduler.schedule(scheduleInput(evaluationModel));
    assert.equal(scheduled.status, 'queued');
    assert.equal(scheduled.snapshot.annotationIds.length, 3);
    assert.equal(new Set(scheduled.snapshot.episodeRefs.map((ref) => ref.invocationId)).size, 3);
    assert.deepEqual(scheduled.snapshot.metricDefinitions, evaluationModel.metrics);
    assert.deepEqual(scheduled.snapshot.unitRefs, unitRefs);

    const result = evaluateCounterSnapshot(scheduled.snapshot, evaluationModel.metrics[0], 1100);
    assert.deepEqual(result.value, { kind: 'counter', count: 3, threshold: 3 });
    assert.equal('denominator' in result.value, false);
    assert.equal('rate' in result.value, false);
    assert.equal((await results.append(result)).outcome, 'created');
    await snapshots.markAnnotationsConsumed(scheduled.snapshot);
    await snapshots.markCompleted(scheduled.snapshot, 1_100);

    assert.deepEqual(await scheduler.schedule(scheduleInput(evaluationModel, 1200)), {
      status: 'not-ready',
      observed: 0,
      required: 3,
    });
  });

  test('concurrent schedulers converge on the same immutable snapshot', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const snapshots = new EvaluationSnapshotStore(redis);
    const scheduler = new EvaluationScheduler({ annotations, snapshots });
    await Promise.all([1, 2, 3].map((index) => annotations.append(annotation(index))));

    const input = scheduleInput(evaluationModel);
    const [left, right] = await Promise.all([scheduler.schedule(input), scheduler.schedule(input)]);
    assert.equal(left.status, 'queued');
    assert.equal(right.status, 'queued');
    assert.equal(left.snapshot.snapshotId, right.snapshot.snapshotId);
    assert.equal((await snapshots.get(left.snapshot.snapshotId)).snapshotId, left.snapshot.snapshotId);
  });

  test('minimum-sample rate freezes positive and counterexample inputs before evaluation', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const snapshots = new EvaluationSnapshotStore(redis);
    const scheduler = new EvaluationScheduler({ annotations, snapshots });

    await annotations.append({
      ...annotation(1),
      metricId: 'tool-discovery-success-rate',
      polarity: 'positive',
    });
    await annotations.append({
      ...annotation(2),
      metricId: 'tool-discovery-success-rate',
      polarity: 'candidate',
    });
    await annotations.append({
      ...annotation(3),
      metricId: 'tool-discovery-success-rate',
      polarity: 'counterexample',
    });
    assert.deepEqual(await scheduler.schedule(scheduleInput(rateEvaluationModel)), {
      status: 'not-ready',
      observed: 2,
      required: 3,
    });

    await annotations.append({
      ...annotation(4),
      metricId: 'tool-discovery-success-rate',
      polarity: 'positive',
    });
    const scheduled = await scheduler.schedule(scheduleInput(rateEvaluationModel));
    assert.equal(scheduled.status, 'queued');
    assert.deepEqual(
      scheduled.snapshot.samples.map(({ annotationId, polarity }) => ({ annotationId, polarity })),
      [
        { annotationId: 'ann-1', polarity: 'positive' },
        { annotationId: 'ann-3', polarity: 'counterexample' },
        { annotationId: 'ann-4', polarity: 'positive' },
      ],
    );
    assert.deepEqual(evaluateRateSnapshot(scheduled.snapshot, rateEvaluationModel.metrics[0], 1100).value, {
      kind: 'rate',
      numerator: 2,
      denominator: 3,
      rate: 2 / 3,
    });
  });

  test('EvaluationIndexer validates coordinates and runtime auto-writes the threshold result', async () => {
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const catalog = {
      registry: {
        registryVersion: 2,
        evaluationModels: [evaluationModel],
        objectives: [
          {
            id: 'tool-access-correct-use',
            label: 'Tool',
            statement: 'Use tools correctly',
            evaluationModelId: 'em-tool',
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
        ],
      },
    };
    const runtime = new ObjectiveEvaluationRuntime(redis, catalog, annotations);

    await assert.rejects(
      runtime.append({ ...annotation(9), metricId: 'invented-metric' }),
      /invalid_evaluation_coordinate/,
    );
    await runtime.append(annotation(1));
    await runtime.append(annotation(2));
    assert.equal(
      (
        await runtime.results.queryMetricWindow(
          'owner-1',
          'tool-access-correct-use',
          'tool-schema-failure-count',
          0,
          2000,
        )
      ).length,
      0,
    );
    await runtime.append(annotation(3));
    const metricResults = await runtime.results.queryMetricWindow(
      'owner-1',
      'tool-access-correct-use',
      'tool-schema-failure-count',
      0,
      Date.now() + 1,
    );
    assert.equal(metricResults.length, 1);
    assert.deepEqual(metricResults[0].value, { kind: 'counter', count: 3, threshold: 3 });

    const judgment = await runtime.judgments.latest('owner-1', 'tool-access-correct-use');
    assert.ok(judgment);
    assert.equal(judgment.metricResults.length, 1);
    assert.deepEqual(judgment.metricResults[0].value, { kind: 'counter', count: 3, threshold: 3 });
    assert.equal(judgment.completion, 'complete');
    assert.deepEqual(judgment.metricOutcomes, [{ metricId: 'tool-schema-failure-count', status: 'evaluated' }]);
  });

  test('per-segment readiness naturally fails when corpus is empty', async () => {
    // When queryUnitWindow returns [] (segment never fired), the per-segment
    // readiness count is 0 because no episodes match the segment, so readiness
    // naturally fails without needing a separate owner-wide guard.
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const snapshots = new EvaluationSnapshotStore(redis);
    const VOLUME_THRESHOLD = (await import('@cat-cafe/shared')).EVALUATION_TRACE_VOLUME_THRESHOLD;

    const scheduler = new EvaluationScheduler({
      annotations,
      snapshots,
      traces: {
        // Segment-filtered corpus is empty (hook never fired)
        queryUnitWindow: async () => [],
        countSegmentWindow: async () => 0,
      },
    });

    const result = await scheduler.schedule(scheduleInput(evaluationModel));
    assert.equal(result.status, 'not-ready', 'should not queue when corpus is empty');
    assert.equal(result.observed, 0);
    // With per-segment readiness, the required count reflects the most
    // constrained event-driven metric (counter threshold=3), not the volume
    // threshold. The volume threshold is an independent trigger path.
    assert.equal(result.required, 3);
  });

  test('volume threshold triggers when any segment reaches 200, even if another has 0', async () => {
    // D7 has 200 observed episodes but D20 has 0. The volume threshold should
    // fire because ANY segment reaching the threshold is sufficient — D20's
    // absence is negative evidence for the evaluator, not a readiness blocker.
    const redis = new FakeRedis();
    const annotations = new TraceAnnotationStore(redis);
    const snapshots = new EvaluationSnapshotStore(redis);
    const VOLUME_THRESHOLD = (await import('@cat-cafe/shared')).EVALUATION_TRACE_VOLUME_THRESHOLD;

    const d7Episodes = Array.from({ length: VOLUME_THRESHOLD }, (_, index) => ({
      summary: {
        turnId: `turn-${index}`,
        threadId: 'thread-1',
        catId: 'cat-1',
        timestamp: 99 + index,
        segments: [
          {
            segmentId: 'D7',
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
      terminal: {
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
    }));

    const multiSegmentUnitRefs = [
      { unitType: 'segment', unitId: 'D7' },
      { unitType: 'segment', unitId: 'D20' },
    ];
    const scheduler = new EvaluationScheduler({
      annotations,
      snapshots,
      traces: {
        queryUnitWindow: async () => d7Episodes,
        countSegmentWindow: async (_o, segmentId) => (segmentId === 'D7' ? VOLUME_THRESHOLD : 0),
      },
    });

    const result = await scheduler.schedule({
      ownerUserId: 'owner-1',
      objectiveId: 'tool-access-correct-use',
      evaluationModel: evaluationModel,
      unitRefs: multiSegmentUnitRefs,
      now: 1000,
    });

    assert.equal(result.status, 'queued', 'D7=200/D20=0 should still trigger volume threshold');
    assert.equal(result.snapshot.traceCorpus.length, VOLUME_THRESHOLD);
  });
});
