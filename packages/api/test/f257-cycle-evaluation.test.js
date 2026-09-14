import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const { CycleEvaluationCoordinator, CYCLE_WRITEBACK_TIMEOUT_MS } = await import(
  '../dist/infrastructure/harness-eval/evaluation/CycleEvaluationCoordinator.js'
);
const { CycleRecordStore } = await import('../dist/infrastructure/harness-eval/evaluation/CycleRecordStore.js');
const { buildCycleAssignment, formatCycleAssignment } = await import(
  '../dist/infrastructure/harness-eval/evaluation/CycleEvaluationContent.js'
);

class FakeRedis {
  strings = new Map();
  sets = new Map();
  zsets = new Map();

  async get(key) {
    return this.strings.get(key) ?? null;
  }
  async set(key, value, mode) {
    if (mode === 'NX' && this.strings.has(key)) return null;
    this.strings.set(key, value);
    return 'OK';
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
  async zrevrange(key) {
    return [...(this.zsets.get(key) ?? new Map()).entries()]
      .sort((left, right) => right[1] - left[1])
      .map(([member]) => member);
  }
  async eval(
    _script,
    _keyCount,
    currentKey,
    historyKey,
    historyIndexKey,
    expectedCycleId,
    expectedStatus,
    replacement,
    mode,
    closedAt,
    next,
  ) {
    const current = JSON.parse(this.strings.get(currentKey) ?? 'null');
    if (current?.cycleId !== expectedCycleId || current.evalStatus !== expectedStatus) return 0;
    if (mode === 'advance') {
      this.strings.set(historyKey, replacement);
      await this.zadd(historyIndexKey, closedAt, expectedCycleId);
      this.strings.set(currentKey, next);
    } else {
      this.strings.set(currentKey, replacement);
    }
    return 1;
  }
}

class FakeThreadStore {
  threads = new Map();

  async get(id) {
    return this.threads.get(id) ?? null;
  }
  async ensureThread(id, title) {
    if (!this.threads.has(id)) this.threads.set(id, { id, title, participants: [], preferredCats: [] });
    return this.threads.get(id);
  }
  async updateSystemKind(id, systemKind) {
    this.threads.get(id).systemKind = systemKind;
  }
  async indexForUser() {}
  async updateTitle(id, title) {
    this.threads.get(id).title = title;
  }
  async restore(id) {
    delete this.threads.get(id).deletedAt;
  }
  async updatePreferredCats(id, cats) {
    this.threads.get(id).preferredCats = cats;
  }
  async addParticipants(id, cats) {
    this.threads.get(id).participants = [...new Set([...this.threads.get(id).participants, ...cats])];
  }
}

const catalog = {
  registry: {
    registryVersion: 2,
    evaluationModels: [
      {
        id: 'model-1',
        label: 'Model',
        ruleVersion: 'v1',
        cycleTrigger: { cumulativeThreshold: 3, counterexampleThreshold: 2, cadenceDays: 7, minimumIntervalMs: 1 },
        metrics: [
          {
            id: 'metric-a',
            label: 'Metric A',
            kind: 'counter',
            evaluator: { kind: 'code', ruleRef: 'rule-a' },
            trigger: { kind: 'distinct-counterexamples', threshold: 2 },
            verdictRule: { kind: 'counter-zero' },
          },
        ],
      },
    ],
    objectives: [
      { id: 'obj', label: 'Objective', statement: 'Keep the behavior sound.', evaluationModelId: 'model-1' },
    ],
  },
  manifest: {
    manifestVersion: 1,
    registryVersion: 2,
    units: [{ unitId: 'D1', hookId: 'd1-test', unitState: 'evaluable', objectives: [{ objectiveId: 'obj' }] }],
  },
};

function trace(invocationId, terminalAt, inputMessageId = null, status = 'observed') {
  return {
    terminal: {
      invocationId,
      terminalAt,
      ownerUserId: 'owner-1',
      threadId: 'source-thread',
      catId: 'cat-a',
      terminalKind: 'completed',
      inputMessageId,
      outputMessageId: null,
      toolCalls: [{ toolName: 'example_tool', outcome: 'ok' }],
    },
    summary: {
      segments: [
        {
          segmentId: 'D1',
          status,
          contentHash: 'sha256:x',
          ...(status === 'absent' ? { pipelineStatus: 'disabled', reasonCode: 'disabled_by_override' } : {}),
        },
      ],
    },
  };
}

async function harness({ now = 1_500, traces = [trace('inv-1', 500)], annotations = [] } = {}) {
  const redis = new FakeRedis();
  const cycles = new CycleRecordStore(redis);
  const idle = await cycles.initialize('owner-1', 'obj', 0, { version: 'v1', versionContentRef: 'hooks:d1@1' });
  const requested = { ...idle, cycleEnd: 1_000, evalStatus: 'requested', windows: [{ start: 0, end: 1_000 }] };
  assert.equal(await cycles.request(idle, requested), true);
  const threadStore = new FakeThreadStore();
  const deliveries = [];
  const deliveredByKey = new Map();
  const wakes = [];
  const runtime = {
    catalog,
    cycles,
    annotations: {
      async queryMetricWindow() {
        return annotations;
      },
    },
    traces: {
      async ownerInvocationIds() {
        return traces.map((episode) => episode.terminal.invocationId);
      },
      async getEpisodeByInvocationId(id) {
        return traces.find((episode) => episode.terminal.invocationId === id) ?? null;
      },
    },
    cycleChecker: {
      setRequestedHandler(handler) {
        this.handler = handler;
      },
    },
  };
  const messages = new Map([
    ['input-1', { id: 'input-1', userId: 'owner-1', threadId: 'source-thread', content: 'source input' }],
  ]);
  const coordinator = new CycleEvaluationCoordinator({
    runtime,
    threadStore,
    messageStore: {
      async getByIds(ids) {
        return ids.flatMap((id) => (messages.has(id) ? [messages.get(id)] : []));
      },
    },
    async deliver(input) {
      const existing = deliveredByKey.get(input.idempotencyKey);
      if (existing) return existing;
      const id = `message-${deliveries.length + 1}`;
      deliveries.push({ id, ...input });
      deliveredByKey.set(input.idempotencyKey, id);
      return id;
    },
    getInvokeTrigger: () => ({
      async trigger(...args) {
        wakes.push(args);
        return 'dispatched';
      },
    }),
    getDefaultCatId: () => 'cat-default',
    now: () => now,
  });
  return { redis, cycles, requested, coordinator, threadStore, deliveries, wakes };
}

const principal = { userId: 'owner-1', catId: 'cat-default', threadId: 'thread_eval_f257_obj' };
const submission = {
  objectiveId: 'obj',
  metrics: [
    { id: 'metric-a', conclusion: { kind: 'count', value: 0, howCounted: 'inspected page' }, evidenceRefs: [] },
  ],
  overall: 'complete',
  counterexampleRootCauses: { eventCount: 0, rootCauseCount: 0, howGrouped: 'No counterexamples.' },
  coverageAssessment: {
    status: 'adequate',
    rationale: 'The inspected window is covered by the declared metrics and detectors.',
    findings: [],
  },
};

describe('F257 cycle evaluation delivery and writeback', () => {
  test('keeps manual-switch evidence provenance separate from insufficient-evidence carry-forward', async () => {
    const record = {
      schemaVersion: 1,
      cycleId: 'cycle-after-switch',
      ownerUserId: 'owner-1',
      objectiveId: 'obj',
      version: 'objective-v2',
      versionContentRef: 'hooks:d1@2',
      cycleStart: 1_000,
      cycleEnd: 2_000,
      evalStatus: 'requested',
      windows: [
        {
          start: 0,
          end: 1_000,
          provenance: {
            kind: 'manual-version-switch',
            sourceCycleId: 'cycle-before-switch',
            sourceVersion: 'objective-v3',
            sourceVersionContentRef: 'hooks:d1@3',
            sourceSegmentId: 'D1',
            sourceSegmentVersion: 3,
          },
        },
        { start: 1_000, end: 2_000 },
      ],
    };
    const assignment = await buildCycleAssignment(
      {
        catalog,
        annotations: {
          async queryMetricWindow() {
            return [];
          },
        },
        history: [
          {
            ...record,
            cycleId: 'cycle-before-switch',
            cycleStart: 0,
            cycleEnd: 1_000,
            evalStatus: 'idle',
            windows: [],
            termination: {
              kind: 'manual-version-switch',
              segmentId: 'D1',
              fromVersion: 3,
              toVersion: 2,
              at: 1_000,
              by: 'owner-1',
              reason: 'switch current version',
            },
            closedAt: 1_000,
          },
        ],
      },
      record,
    );

    assert.equal(assignment.priorSkipReasons, undefined);
    assert.equal(assignment.windows[0].provenance.sourceSegmentVersion, 3);
    assert.match(formatCycleAssignment(record, assignment), /supplementary unconsumed evidence/);
  });

  test('ensures a discoverable Objective thread and bounded reference-only assignment', async () => {
    const context = await harness();
    await context.coordinator.ensureAssignment(context.requested);

    const thread = context.threadStore.threads.get('thread_eval_f257_obj');
    assert.equal(thread.systemKind, 'eval_domain');
    assert.deepEqual(thread.preferredCats, ['cat-default']);
    assert.deepEqual(thread.participants, ['cat-default']);
    assert.equal(context.deliveries.length, 1);
    assert.equal(context.deliveries[0].userId, 'owner-1');
    assert.ok(Buffer.byteLength(context.deliveries[0].content) <= 32 * 1024);
    assert.match(context.deliveries[0].content, /"statement":"Keep the behavior sound\."/);
    assert.match(context.deliveries[0].content, /cat_cafe_read_cycle_traces/);
    assert.doesNotMatch(context.deliveries[0].content, /source input|traceCorpus/);
    assert.equal(context.wakes.length, 1);
    assert.equal((await context.cycles.current('owner-1', 'obj')).assignmentThreadId, 'thread_eval_f257_obj');
  });

  test('reads counterexamples first and hydrates only owned message excerpts', async () => {
    const episodes = [trace('ordinary', 400), trace('priority', 500, 'input-1')];
    const annotations = [
      {
        annotationId: 'annotation-1',
        polarity: 'counterexample',
        source: 'structured-rule',
        confidence: 1,
        incidentKey: 'incident-1',
        createdAt: 600,
        objectiveId: 'obj',
        metricId: 'metric-a',
        episodeRef: { invocationId: 'priority' },
      },
    ];
    const context = await harness({ traces: episodes, annotations });
    const page = await context.coordinator.readTraces(principal, {
      objectiveId: 'obj',
      cycleId: context.requested.cycleId,
      cursor: 0,
      limit: 1,
    });
    assert.equal(page.total, 2);
    assert.equal(page.nextCursor, 1);
    assert.equal(page.episodes[0].invocationId, 'priority');
    assert.equal(page.episodes[0].priority, 'counterexample');
    assert.equal(page.episodes[0].input.text, 'source input');
  });

  test('prioritizes MCP candidate hints without treating them as counterexamples', async () => {
    const episodes = [trace('ordinary', 400), trace('candidate', 500)];
    const context = await harness({
      traces: episodes,
      annotations: [
        {
          annotationId: 'candidate-1',
          polarity: 'candidate',
          source: 'mcp-marker',
          confidence: 0.6,
          incidentKey: 'candidate-incident',
          createdAt: 600,
          objectiveId: 'obj',
          metricId: 'metric-a',
          episodeRef: { invocationId: 'candidate' },
        },
      ],
    });
    const page = await context.coordinator.readTraces(principal, {
      objectiveId: 'obj',
      cycleId: context.requested.cycleId,
      cursor: 0,
      limit: 1,
    });
    assert.equal(page.episodes[0].invocationId, 'candidate');
    assert.equal(page.episodes[0].priority, 'hint');
    assert.equal(page.episodes[0].signals[0].polarity, 'candidate');
    assert.equal(page.episodes[0].incidentKeys, undefined);
  });

  test('keeps disabled segment facts visible and accepts them as owner-pool evidence', async () => {
    const context = await harness({ traces: [trace('disabled', 500, null, 'absent')] });
    const page = await context.coordinator.readTraces(principal, {
      objectiveId: 'obj',
      cycleId: context.requested.cycleId,
      cursor: 0,
      limit: 10,
    });
    assert.deepEqual(page.episodes[0].segments, [
      { segmentId: 'D1', status: 'absent', pipelineStatus: 'disabled', reasonCode: 'disabled_by_override' },
    ]);
    const input = {
      ...submission,
      cycleId: context.requested.cycleId,
      metrics: [{ ...submission.metrics[0], evidenceRefs: ['disabled'] }],
    };
    assert.equal((await context.coordinator.submitEvaluation(principal, input)).outcome, 'written');
  });

  test('writes a complete evaluation once and makes an exact retry idempotent', async () => {
    const context = await harness();
    const input = { ...submission, cycleId: context.requested.cycleId };
    assert.equal((await context.coordinator.submitEvaluation(principal, input)).outcome, 'written');
    const stored = await context.cycles.current('owner-1', 'obj');
    assert.equal(stored.evalStatus, 'written');
    assert.deepEqual(stored.evaluation.coverageAssessment, input.coverageAssessment);
    assert.equal((await context.coordinator.submitEvaluation(principal, input)).outcome, 'already_written');
  });

  test('accepts an evidence-bound detector gap and rejects an invented hard marker basis', async () => {
    const marker = {
      annotationId: 'marker-1',
      episodeRef: { invocationId: 'inv-1' },
      source: 'mcp-marker',
      ruleId: 'mcp-marker',
      objectiveId: 'obj',
      metricId: 'metric-a',
      unitRefs: [],
      polarity: 'candidate',
      confidence: 0.6,
      incidentKey: 'marker-incident',
      evidenceRefs: [],
      createdAt: 600,
    };
    const accepted = await harness({ annotations: [marker] });
    const coverageAssessment = {
      status: 'gaps_found',
      rationale: 'The self marker was not covered by a replayable detector.',
      findings: [
        {
          kind: 'detector_gap',
          basis: 'mcp-marker',
          metricId: 'metric-a',
          rationale: 'No structured rule matched this marked invocation.',
          evidenceRefs: ['inv-1'],
        },
      ],
    };
    assert.equal(
      (
        await accepted.coordinator.submitEvaluation(principal, {
          ...submission,
          cycleId: accepted.requested.cycleId,
          coverageAssessment,
        })
      ).outcome,
      'written',
    );

    const rejected = await harness();
    await assert.rejects(
      rejected.coordinator.submitEvaluation(principal, {
        ...submission,
        cycleId: rejected.requested.cycleId,
        coverageAssessment,
      }),
      /cycle_evaluation_coverage_marker_basis:/,
    );

    const alreadyCovered = await harness({
      annotations: [
        marker,
        {
          ...marker,
          annotationId: 'structured-1',
          source: 'structured-rule',
          ruleId: 'rule-1',
          polarity: 'counterexample',
          confidence: 1,
          incidentKey: 'structured-incident',
        },
      ],
    });
    await assert.rejects(
      alreadyCovered.coordinator.submitEvaluation(principal, {
        ...submission,
        cycleId: alreadyCovered.requested.cycleId,
        counterexampleRootCauses: {
          eventCount: 1,
          rootCauseCount: 1,
          howGrouped: 'One replayable event.',
        },
        coverageAssessment,
      }),
      /cycle_evaluation_coverage_detector_present:metric-a/,
    );
  });

  test('refuses an evaluation that would exceed the CycleRecord size ceiling', async () => {
    const context = await harness();
    const input = {
      ...submission,
      cycleId: context.requested.cycleId,
      metrics: [
        {
          ...submission.metrics[0],
          conclusion: { ...submission.metrics[0].conclusion, howCounted: 'x'.repeat(70_000) },
        },
      ],
    };
    await assert.rejects(context.coordinator.submitEvaluation(principal, input), /cycle_record_too_large:/);
    assert.equal((await context.cycles.current('owner-1', 'obj')).evalStatus, 'requested');
  });

  test('archives insufficient evidence and starts the next cycle at the prior end', async () => {
    const context = await harness();
    const input = { ...submission, cycleId: context.requested.cycleId, overall: 'insufficient_evidence' };
    const result = await context.coordinator.submitEvaluation(principal, input);
    const current = await context.cycles.current('owner-1', 'obj');
    const archived = await context.cycles.historyCycle('owner-1', 'obj', context.requested.cycleId);
    assert.equal(result.outcome, 'written');
    assert.equal(current.evalStatus, 'idle');
    assert.equal(current.cycleStart, 1_000);
    assert.equal(archived.evaluation.overall, 'insufficient_evidence');
  });

  test('emits one 30-minute retrigger, then one stalled alert, with no further retry', async () => {
    const context = await harness();
    const active = await context.cycles.current('owner-1', 'obj');
    assert.equal(
      await context.cycles.transition(active, { ...active, assignedAt: 100, assignmentMessageId: 'assignment' }),
      true,
    );

    await context.coordinator.reconcileKnownCycles(100 + CYCLE_WRITEBACK_TIMEOUT_MS - 1);
    assert.equal(context.deliveries.length, 0);
    await context.coordinator.reconcileKnownCycles(100 + CYCLE_WRITEBACK_TIMEOUT_MS);
    assert.equal(context.deliveries.filter((item) => item.content.includes('Retrigger')).length, 1);
    const retriggered = await context.cycles.current('owner-1', 'obj');
    assert.equal(retriggered.evalStatus, 'retriggered');

    await context.coordinator.reconcileKnownCycles(retriggered.retriggeredAt + CYCLE_WRITEBACK_TIMEOUT_MS);
    await context.coordinator.reconcileKnownCycles(retriggered.retriggeredAt + 2 * CYCLE_WRITEBACK_TIMEOUT_MS);
    assert.equal(context.deliveries.filter((item) => item.content.includes('Stalled')).length, 1);
    assert.equal(context.deliveries.filter((item) => item.content.includes('Retrigger')).length, 1);
    assert.equal((await context.cycles.current('owner-1', 'obj')).evalStatus, 'stalled');
  });
});
