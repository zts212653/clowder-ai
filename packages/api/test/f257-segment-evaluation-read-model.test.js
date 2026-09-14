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
    const existed = this.strings.delete(key) || this.sets.delete(key) || this.zsets.delete(key);
    return existed ? 1 : 0;
  }
  async incr(key) {
    const next = Number(this.strings.get(key) ?? 0) + 1;
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
  async zcount(key, min, max) {
    return [...(this.zsets.get(key) ?? new Map()).values()].filter(
      (score) => score >= Number(min) && score <= Number(max),
    ).length;
  }
  async zcard(key) {
    return (this.zsets.get(key) ?? new Map()).size;
  }
  async zrange(key, start, end, withScores) {
    const rows = this.sorted(key);
    const selected = rows.slice(start, end < 0 ? undefined : end + 1);
    return withScores === 'WITHSCORES'
      ? selected.flatMap(([member, score]) => [member, String(score)])
      : selected.map(([member]) => member);
  }
  async zrangebyscore(key, min, max) {
    const lower = Number(String(min).replace(/^\(/, ''));
    const upper = Number(String(max).replace(/^\(/, ''));
    const lowerOpen = String(min).startsWith('(');
    const upperOpen = String(max).startsWith('(');
    return this.sorted(key)
      .filter(
        ([, score]) => (lowerOpen ? score > lower : score >= lower) && (upperOpen ? score < upper : score <= upper),
      )
      .map(([member]) => member);
  }
  async zrevrange(key, start, end) {
    const rows = this.sorted(key).reverse();
    return rows.slice(start, end < 0 ? undefined : end + 1).map(([member]) => member);
  }
  sorted(key) {
    return [...(this.zsets.get(key) ?? new Map()).entries()].sort(
      (left, right) => left[1] - right[1] || left[0].localeCompare(right[0]),
    );
  }
}

const metrics = [
  {
    id: 'failure-count',
    label: '工具调用失败',
    kind: 'counter',
    evaluator: { kind: 'code', ruleRef: 'tool-failure' },
    trigger: { kind: 'distinct-counterexamples', threshold: 3 },
    verdictRule: { kind: 'counter-zero' },
  },
  {
    id: 'choice-quality',
    label: '工具选择正确性',
    kind: 'semantic',
    evaluator: { kind: 'llm', ruleRef: 'choice-quality' },
    trigger: { kind: 'cadence', cadence: 'weekly' },
    verdictRule: { kind: 'evidence-only' },
  },
];
const catalog = {
  registry: {
    registryVersion: 2,
    evaluationModels: [
      {
        id: 'em-tool-access',
        label: '工具能力评估',
        ruleVersion: 'v4',
        cycleTrigger: {
          cumulativeThreshold: 200,
          counterexampleThreshold: 3,
          cadenceDays: 7,
          minimumIntervalMs: 7_200_000,
        },
        metrics,
      },
    ],
    objectives: [
      {
        id: 'tool-access',
        label: '工具能力可达',
        statement: 'Use the right tool correctly',
        evaluationModelId: 'em-tool-access',
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
        objectives: [{ objectiveId: 'tool-access' }],
      },
      {
        unitId: 'C1',
        hookId: 'c1-doc',
        unitState: 'evaluable',
        objectives: [{ objectiveId: 'tool-access' }],
      },
    ],
  },
};

function episode(index, terminalAt) {
  return {
    summary: {
      turnId: `turn-${index}`,
      threadId: 'thread-1',
      catId: 'cat-1',
      timestamp: terminalAt,
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
    terminal: {
      traceTurnId: `turn-${index}`,
      invocationId: `inv-${index}`,
      ownerUserId: 'owner-1',
      threadId: 'thread-1',
      catId: 'cat-1',
      inputMessageId: `input-${index}`,
      outputMessageId: `output-${index}`,
      terminalAt,
      terminalKind: 'completed',
      toolCalls: [],
    },
  };
}

function annotation(index, createdAt, incidentKey = `incident-${index}`) {
  return {
    annotationId: `ann-${index}`,
    episodeRef: episode(index, createdAt).terminal,
    source: 'structured-rule',
    ruleId: 'tool-failure',
    objectiveId: 'tool-access',
    metricId: 'failure-count',
    unitRefs: [{ unitType: 'segment', unitId: 'S13' }],
    polarity: 'counterexample',
    confidence: 1,
    incidentKey,
    evidenceRefs: [`invocation://inv-${index}`],
    createdAt,
  };
}

function currentCycle(overrides = {}) {
  return {
    schemaVersion: 1,
    cycleId: 'cycle-current',
    ownerUserId: 'owner-1',
    objectiveId: 'tool-access',
    version: 'S13@2',
    versionContentRef: 'hook:S13@2',
    cycleStart: 100,
    evalStatus: 'idle',
    windows: [],
    ...overrides,
  };
}

function runtimeFor(redis, episodes) {
  const annotations = new TraceAnnotationStore(redis);
  const runtime = new ObjectiveEvaluationRuntime(redis, catalog, annotations, {
    traceStore: {
      async countOwnerWindow(ownerUserId, startMs, endMs) {
        return episodes.filter(
          (item) =>
            item.terminal.ownerUserId === ownerUserId &&
            item.terminal.terminalAt >= startMs &&
            item.terminal.terminalAt < endMs,
        ).length;
      },
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
    },
  });
  return { annotations, runtime };
}

async function seedCurrent(redis, cycle) {
  await redis.set('harness-cycle-current:owner-1:tool-access', JSON.stringify(cycle));
}

async function seedHistory(redis, cycle) {
  await redis.set(`harness-cycle-history:owner-1:tool-access:${cycle.cycleId}`, JSON.stringify(cycle));
  await redis.zadd('harness-cycle-history-index:owner-1:tool-access', cycle.closedAt, cycle.cycleId);
}

describe('F257 SegmentEvaluationReadModel', () => {
  test('projects two tracing groups and all three per-Objective trigger lanes from CycleRecord', async () => {
    const redis = new FakeRedis();
    const { annotations, runtime } = runtimeFor(redis, [episode(1, 50), episode(2, 150), episode(3, 250)]);
    await seedCurrent(redis, currentCycle());
    await annotations.append(annotation(2, 150, 'same-incident'));
    await annotations.append(annotation(3, 250, 'same-incident'));

    const view = await new SegmentEvaluationReadModel(runtime, () => 300).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 300,
    });

    assert.deepEqual(Object.keys(view.tracing).sort(), [
      'injections',
      'injectionsCapped',
      'structuredCounterexamples',
      'trigger',
    ]);
    assert.deepEqual(view.tracing.trigger.objective, {
      objectiveId: 'tool-access',
      evalStatus: 'idle',
      lifecycle: 'active',
      health: 'healthy',
      policyChangeCount: 0,
      cycleStartMs: 100,
      cycleEndMs: null,
      lastClosedAtMs: null,
      minimumIntervalMs: 7_200_000,
      triggeredBy: [],
      cumulative: { count: 2, threshold: 200 },
      counterexamples: { count: 1, threshold: 3 },
      cadence: { elapsedMs: 200, thresholdMs: 604_800_000, eligible: true },
    });
    assert.deepEqual(view.tracing.trigger.segment, {
      segmentId: 'S13',
      observationCount: 2,
      injectionCount: 2,
      disabledCount: 0,
    });
    assert.equal(view.tracing.structuredCounterexamples.length, 1);
    assert.equal('unclassifiedEpisodeCount' in view.tracing, false);
  });

  test('treats an empty freshly switched tracing cycle as healthy', async () => {
    const redis = new FakeRedis();
    const { runtime } = runtimeFor(redis, []);
    await seedCurrent(redis, currentCycle({ cycleStart: 300 }));

    const view = await new SegmentEvaluationReadModel(runtime, () => 300).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 300,
    });

    assert.equal(view.tracing.trigger.objective.health, 'healthy');
    assert.equal(view.tracing.trigger.objective.cumulative.count, 0);
    assert.equal(view.tracing.trigger.segment.observationCount, 0);
  });

  test('uses the Objective cycle window for the segment injection numerator', async () => {
    const beforeCycle = episode(1, 50);
    const fired = episode(2, 150);
    const disabled = episode(3, 200);
    disabled.summary.segments[0].status = 'absent';
    disabled.summary.segments[0].pipelineStatus = 'disabled';
    const observedOnly = episode(4, 250);
    observedOnly.summary.segments[0].pipelineStatus = 'observed';
    const redis = new FakeRedis();
    const { runtime } = runtimeFor(redis, [beforeCycle, fired, disabled, observedOnly]);
    await seedCurrent(redis, currentCycle());

    const view = await new SegmentEvaluationReadModel(runtime, () => 300).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 300,
    });

    assert.equal(view.tracing.trigger.objective.cumulative.count, 3);
    assert.deepEqual(view.tracing.trigger.segment, {
      segmentId: 'S13',
      observationCount: 3,
      injectionCount: 1,
      disabledCount: 1,
    });
  });

  test('uses frozen cycleEnd and surfaces metric catalog, latest verdict, governance, and version chain', async () => {
    const redis = new FakeRedis();
    const { runtime } = runtimeFor(redis, [episode(1, 150), episode(2, 250)]);
    const evaluated = currentCycle({
      cycleEnd: 200,
      evalStatus: 'written',
      windows: [{ start: 100, end: 200 }],
      triggeredBy: ['cumulative'],
      evaluation: {
        overall: 'complete',
        writtenAt: 220,
        by: 'cat-eval',
        coverageAssessment: {
          status: 'gaps_found',
          rationale: 'One detector gap remains.',
          findings: [
            {
              kind: 'detector_gap',
              basis: 'evaluator-observation',
              metricId: 'failure-count',
              rationale: 'The rule did not prioritize this episode.',
              evidenceRefs: ['inv-1'],
            },
          ],
        },
        metrics: [
          {
            id: 'failure-count',
            conclusion: { kind: 'count', value: 1, howCounted: 'one incident' },
            evidenceRefs: ['invocation://inv-1'],
          },
        ],
      },
      governance: { decision: 'evolve', reason: 'tighten wording', writtenAt: 230, by: 'cat-eval' },
      approval: { cardId: 'HGP-1', state: 'pending', rejectCount: 0, at: 231 },
    });
    await seedCurrent(redis, evaluated);
    const prior = { ...currentCycle(), cycleId: 'cycle-prior', version: 'S13@1', closedAt: 90 };
    await redis.set('harness-cycle-history:owner-1:tool-access:cycle-prior', JSON.stringify(prior));
    await redis.zadd('harness-cycle-history-index:owner-1:tool-access', 90, 'cycle-prior');

    const view = await new SegmentEvaluationReadModel(runtime).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 300,
    });
    const objective = view.objectives[0];

    assert.equal(view.tracing.trigger.objective.cumulative.count, 1, 'trace after frozen cycleEnd is excluded');
    assert.equal(objective.objectiveStatement, 'Use the right tool correctly');
    assert.equal(objective.metrics.length, 2, 'metric catalog is always visible');
    assert.equal(objective.metrics[0].latestConclusion.value, 1);
    assert.deepEqual(objective.metrics[0].evidenceRefs, ['invocation://inv-1']);
    assert.equal(objective.latestEvaluation.overall, 'complete');
    assert.equal(objective.latestEvaluation.coverageAssessment.status, 'gaps_found');
    assert.equal(objective.latestGovernance.decision, 'evolve');
    assert.equal(objective.latestGovernance.by, 'cat-eval');
    assert.equal(objective.latestGovernance.approval.cardId, 'HGP-1');
    assert.deepEqual(
      objective.versionChain.map((cycle) => [cycle.version, cycle.ordinal]),
      [
        ['S13@1', 1],
        ['S13@2', 2],
      ],
    );
  });

  test('projects the selected cycle without leaking a previous verdict into the current tracing cycle', async () => {
    const redis = new FakeRedis();
    const { runtime } = runtimeFor(redis, [episode(1, 150), episode(2, 250), episode(3, 350)]);
    const prior = currentCycle({
      cycleId: 'cycle-prior',
      version: 'S13@1',
      cycleStart: 100,
      cycleEnd: 200,
      evalStatus: 'written',
      windows: [{ start: 100, end: 200 }],
      triggeredBy: ['counterexamples'],
      evaluation: {
        overall: 'complete',
        writtenAt: 210,
        by: 'cat-eval',
        metrics: [
          {
            id: 'failure-count',
            conclusion: { kind: 'count', value: 1, howCounted: 'one incident' },
            evidenceRefs: ['invocation://inv-1'],
          },
        ],
      },
      governance: { decision: 'keep', reason: 'stable', writtenAt: 220, by: 'cat-eval' },
      closedAt: 200,
    });
    await seedHistory(redis, prior);
    await seedCurrent(redis, currentCycle({ cycleStart: 200 }));

    const currentView = await new SegmentEvaluationReadModel(runtime, () => 400).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 400,
      cycleId: 'cycle-current',
    });
    const currentObjective = currentView.objectives[0];
    assert.equal(currentObjective.selectedCycle.cycleId, 'cycle-current');
    assert.equal(currentObjective.latestEvaluation, null);
    assert.equal(currentObjective.latestGovernance, null);
    assert.equal(currentObjective.metrics[0].latestConclusion, null);
    assert.deepEqual(currentView.window, { start: 200, end: 400 });
    assert.equal(currentView.tracing.trigger.objective.cumulative.count, 2);
    assert.deepEqual(
      currentView.tracing.injections.map((row) => row.turnId),
      ['turn-3', 'turn-2'],
    );

    const priorView = await new SegmentEvaluationReadModel(runtime, () => 400).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 400,
      cycleId: 'cycle-prior',
    });
    const priorObjective = priorView.objectives[0];
    assert.equal(priorObjective.selectedCycle.cycleId, 'cycle-prior');
    assert.equal(priorObjective.latestEvaluation.cycleId, 'cycle-prior');
    assert.equal(priorObjective.latestGovernance.cycleId, 'cycle-prior');
    assert.equal(priorObjective.metrics[0].latestConclusion.value, 1);
    assert.deepEqual(priorView.window, { start: 100, end: 200 });
    assert.equal(priorView.tracing.trigger.objective.cumulative.count, 1);
    assert.deepEqual(
      priorView.tracing.injections.map((row) => row.turnId),
      ['turn-1'],
    );
  });

  test('fails closed when an explicit cycle coordinate does not exist', async () => {
    const redis = new FakeRedis();
    const { runtime } = runtimeFor(redis, []);
    await seedCurrent(redis, currentCycle());

    await assert.rejects(
      new SegmentEvaluationReadModel(runtime).read({
        ownerUserId: 'owner-1',
        segmentId: 'S13',
        startMs: 0,
        endMs: 300,
        cycleId: 'cycle-missing',
      }),
      /segment_evaluation_cycle_not_found:cycle-missing/,
    );
  });

  test('attributes the first post-evolve cycle to its frozen segment version instead of the earlier cycleStart activation', async () => {
    const redis = new FakeRedis();
    const { runtime } = runtimeFor(redis, []);
    const prior = currentCycle({
      cycleId: 'cycle-prior',
      version: 'objective-old',
      versionContentRef: 'hook-versions:S13@1',
      cycleStart: 100,
      cycleEnd: 200,
      closedAt: 230,
    });
    await seedHistory(redis, prior);
    await seedCurrent(
      redis,
      currentCycle({
        cycleStart: 200,
        version: 'objective-new',
        versionContentRef: 'hook-versions:S13@2',
      }),
    );

    const view = await new SegmentEvaluationReadModel(runtime, () => 300).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 300,
    });

    assert.deepEqual(
      view.objectives[0].versionChain.map((cycle) => [cycle.cycleId, cycle.segmentVersion]),
      [
        ['cycle-prior', 1],
        ['cycle-current', 2],
      ],
    );
  });

  test('resolves the segment version from an immutable Objective snapshot', async () => {
    const redis = new FakeRedis();
    const { runtime } = runtimeFor(redis, []);
    const ref = 'harness-objective-version:tool-access:digest-v2';
    await redis.set(
      ref,
      JSON.stringify({
        schemaVersion: 1,
        objective: { id: 'tool-access' },
        units: [
          { unitId: 'S13', activeContentVersion: 2 },
          { unitId: 'C1', activeContentVersion: 4 },
        ],
      }),
    );
    await seedCurrent(redis, currentCycle({ version: 'objective-digest-v2', versionContentRef: ref }));

    const view = await new SegmentEvaluationReadModel(runtime, () => 300).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 300,
    });

    assert.equal(view.objectives[0].currentCycle.segmentVersion, 2);
  });

  test('projects which proposal units changed and whether the selected segment stayed unchanged', async () => {
    const redis = new FakeRedis();
    const { runtime } = runtimeFor(redis, []);
    await seedHistory(
      redis,
      currentCycle({
        cycleId: 'cycle-sibling-evolve',
        versionContentRef: 'hooks:S13@1,C1@1,L5@2',
        cycleEnd: 200,
        evalStatus: 'written',
        evaluation: { overall: 'complete', writtenAt: 220, by: 'cat-eval', metrics: [] },
        governance: { decision: 'evolve', reason: 'tighten sibling guidance', writtenAt: 230, by: 'cat-eval' },
        approval: { cardId: 'HGP-sibling', state: 'approved', rejectCount: 0, at: 240 },
        closedAt: 240,
      }),
    );
    await seedCurrent(
      redis,
      currentCycle({ cycleStart: 200, version: 'objective-v2', versionContentRef: 'hooks:S13@1,C1@2,L5@2' }),
    );
    const proposals = {
      async get(proposalId) {
        assert.equal(proposalId, 'HGP-sibling');
        return {
          changes: [
            { action: 'modify', unitId: 'C1', sourceVersion: 1 },
            { action: 'disable', unitId: 'L5' },
          ],
        };
      },
    };

    const view = await new SegmentEvaluationReadModel(runtime, () => 300, proposals).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 300,
      cycleId: 'cycle-sibling-evolve',
    });

    assert.deepEqual(view.objectives[0].selectedCycle.governanceImpact, {
      changedUnitIds: ['C1', 'L5'],
      selectedSegmentChanged: false,
      changes: [
        { action: 'modify', unitId: 'C1', sourceVersion: 1, targetVersion: 2 },
        { action: 'disable', unitId: 'L5', sourceVersion: 2, targetVersion: 2 },
      ],
    });
    assert.deepEqual(view.objectives[0].latestGovernance.impact, {
      changedUnitIds: ['C1', 'L5'],
      selectedSegmentChanged: false,
      changes: [
        { action: 'modify', unitId: 'C1', sourceVersion: 1, targetVersion: 2 },
        { action: 'disable', unitId: 'L5', sourceVersion: 2, targetVersion: 2 },
      ],
    });
    assert.equal(view.tracing.trigger.objective.lastClosedAtMs, null, 'historical selection has no earlier cycle');
    assert.equal(view.tracing.trigger.objective.minimumIntervalMs, 7_200_000);

    const currentView = await new SegmentEvaluationReadModel(runtime, () => 300, proposals).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 300,
    });
    assert.equal(currentView.tracing.trigger.objective.lastClosedAtMs, 240);
  });

  test('projects every cycle of an older version instead of truncating the chain to the newest few', async () => {
    // Regression: the chain drives the per-version cycle selector, and the tree
    // filters `cycle.segmentVersion === epoch.version`. A short projection made
    // every cycle of the older versions render as an empty version node, which
    // reads as "the data is gone" instead of "the chain was cut".
    const redis = new FakeRedis();
    const { runtime } = runtimeFor(redis, []);
    for (let index = 0; index < 12; index++) {
      await seedHistory(redis, {
        ...currentCycle(),
        cycleId: `cycle-h${String(index).padStart(2, '0')}`,
        version: index < 6 ? 'S13@1' : 'S13@2',
        versionContentRef: index < 6 ? 'hook:S13@1' : 'hook:S13@2',
        cycleStart: index,
        closedAt: index + 1,
      });
    }
    await seedCurrent(redis, currentCycle({ cycleStart: 100 }));

    const view = await new SegmentEvaluationReadModel(runtime, () => 300).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 300,
    });
    const objective = view.objectives[0];

    assert.equal(objective.versionChain.length, 13, '12 history cycles plus the live cycle');
    assert.equal(
      objective.versionChain.filter((cycle) => cycle.segmentVersion === 1).length,
      6,
      'the oldest version keeps all of its cycles',
    );
    assert.deepEqual(
      objective.versionChain.map((cycle) => cycle.ordinal),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13],
      'ordinals stay chronological across the whole chain',
    );
    assert.equal(objective.versionChainCapped, false, 'nothing was withheld');
  });

  test('reports truncation instead of silently dropping cycles beyond the projection bound', async () => {
    const redis = new FakeRedis();
    const { runtime } = runtimeFor(redis, []);
    for (let index = 0; index < 105; index++) {
      await seedHistory(redis, {
        ...currentCycle(),
        cycleId: `cycle-h${String(index).padStart(3, '0')}`,
        cycleStart: index,
        closedAt: index + 1,
      });
    }
    await seedCurrent(redis, currentCycle({ cycleStart: 200 }));

    const view = await new SegmentEvaluationReadModel(runtime, () => 300).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 300,
    });
    const objective = view.objectives[0];

    assert.equal(objective.versionChain.length, 101, '100 projected history cycles plus the live cycle');
    assert.equal(objective.versionChainCapped, true, 'the operator is told the chain was cut');
    assert.equal(objective.versionChain[0].ordinal, 6, 'ordinals still count from the true cycle total');
  });

  test('merges every attribution behind one wake key instead of keeping the first', async () => {
    // Reachable only across metrics. `traceMetricIncidentKey` derives from
    // owner + invocation + objective + metric + polarity, and the annotation
    // store dedupes on it, so two markers sharing an invocation collide into
    // one wake key ONLY when they carry different metrics. The key collapses
    // the trigger signal; attribution is not part of that collapse, and
    // dropping the second segment hides the one the operator must open.
    const { traceMetricIncidentKey } = await import(
      '../dist/infrastructure/harness-eval/trace-annotation/trace-incident-key.js'
    );
    const redis = new FakeRedis();
    const { annotations, runtime } = runtimeFor(redis, [episode(1, 150), episode(2, 250)]);
    await seedCurrent(redis, currentCycle());
    // One invocation means one terminal: the resolver hands every marker from a
    // turn the same episode.terminal, so the fixture shares it instead of
    // inventing a second traceTurnId that production could not produce.
    const sharedTerminal = { ...episode(1, 150).terminal, invocationId: 'inv-shared' };
    const marker = (index, createdAt, metricId, unitId) => {
      const episodeRef = sharedTerminal;
      return {
        ...annotation(index, createdAt),
        source: 'mcp-marker',
        metricId,
        episodeRef,
        // Production key, not a hand-written one: a literal would let the test
        // assert a collision the store would never allow.
        incidentKey: traceMetricIncidentKey({
          ownerUserId: episodeRef.ownerUserId,
          invocationId: episodeRef.invocationId,
          objectiveId: 'tool-access',
          metricId,
          polarity: 'counterexample',
        }),
        unitRefs: [{ unitType: 'segment', unitId }],
      };
    };
    await annotations.append(marker(1, 150, 'failure-count', 'S13'));
    await annotations.append(marker(2, 250, 'choice-quality', 'C1'));

    const view = await new SegmentEvaluationReadModel(runtime, () => 300).read({
      ownerUserId: 'owner-1',
      segmentId: 'C1',
      startMs: 0,
      endMs: 300,
    });

    assert.equal(view.tracing.structuredCounterexamples.length, 1, 'one wake key stays one row');
    assert.equal(view.tracing.trigger.objective.counterexamples.count, 1, 'the trigger count is unchanged');
    assert.deepEqual(
      view.tracing.structuredCounterexamples[0].segmentIds,
      ['C1', 'S13'],
      'the row carries every segment behind the key, deduped and stably ordered',
    );
  });

  test('shows a sibling segment counterexample rather than claiming the cycle has none', async () => {
    // Regression: C1 and S13 share one Objective, and the trigger counts
    // counterexamples per Objective. The list used to be narrowed to the
    // requested segment, so C1 rendered "no counterexample in this cycle"
    // directly under a counter that already read 2/3 and had fired.
    const redis = new FakeRedis();
    const { annotations, runtime } = runtimeFor(redis, [episode(1, 150), episode(2, 250)]);
    await seedCurrent(redis, currentCycle());
    await annotations.append(annotation(1, 150, 'incident-a'));
    await annotations.append(annotation(2, 250, 'incident-b'));

    const view = await new SegmentEvaluationReadModel(runtime, () => 300).read({
      ownerUserId: 'owner-1',
      segmentId: 'C1',
      startMs: 0,
      endMs: 300,
    });

    assert.equal(
      view.tracing.trigger.objective.counterexamples.count,
      2,
      'the trigger counts both counterexamples of the shared Objective',
    );
    assert.equal(
      view.tracing.structuredCounterexamples.length,
      view.tracing.trigger.objective.counterexamples.count,
      'the list never disagrees with the counter above it',
    );
    assert.deepEqual(
      view.tracing.structuredCounterexamples.map((row) => row.segmentIds),
      [['S13'], ['S13']],
      'each row states the segment it is attributed to',
    );
  });

  test('keeps the counter and the list on one filter when the segment owns the counterexample', async () => {
    const redis = new FakeRedis();
    const { annotations, runtime } = runtimeFor(redis, [episode(1, 150)]);
    await seedCurrent(redis, currentCycle());
    await annotations.append(annotation(1, 150, 'incident-a'));
    // Low confidence never reaches the trigger, so it must not reach the list.
    await annotations.append({ ...annotation(2, 200, 'incident-low'), confidence: 0.4 });

    const view = await new SegmentEvaluationReadModel(runtime, () => 300).read({
      ownerUserId: 'owner-1',
      segmentId: 'S13',
      startMs: 0,
      endMs: 300,
    });

    assert.equal(view.tracing.trigger.objective.counterexamples.count, 1);
    assert.equal(view.tracing.structuredCounterexamples.length, 1, 'the list applies the same confidence gate');
    assert.deepEqual(view.tracing.structuredCounterexamples[0].segmentIds, ['S13']);
  });

  test('resolves explicit version windows and rejects partial coordinates', () => {
    assert.deepEqual(resolveEvaluationWindow({ startMs: '100', endMs: '200' }, 999), { startMs: 100, endMs: 200 });
    assert.equal(resolveEvaluationWindow({ startMs: '100' }, 999), null);
    assert.equal(resolveEvaluationWindow({ startMs: '200', endMs: '100' }, 999), null);
  });
});
