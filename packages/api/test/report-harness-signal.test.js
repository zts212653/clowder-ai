import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

class FakeRedis {
  constructor() {
    this.kv = new Map();
    this.sorted = new Map();
    this.sets = new Map();
    this.options = {};
  }
  async set(key, value, ...args) {
    if (args.includes('NX') && this.kv.has(key)) return null;
    this.kv.set(key, value);
    return 'OK';
  }
  async get(key) {
    return this.kv.get(key) ?? null;
  }
  async incr(key) {
    const current = this.kv.has(key) ? Number(this.kv.get(key)) : 0;
    if (!Number.isFinite(current)) throw new Error(`fake_redis_incr_not_integer:${key}`);
    const next = current + 1;
    this.kv.set(key, String(next));
    return next;
  }
  async zadd(key, score, member) {
    const values = this.sorted.get(key) ?? new Map();
    values.set(member, score);
    this.sorted.set(key, values);
    return 1;
  }
  async zrangebyscore(key, min, max) {
    const minExclusive = String(min).startsWith('(');
    const maxExclusive = String(max).startsWith('(');
    const minScore = Number(String(min).replace(/^\(/, ''));
    const maxScore = Number(String(max).replace(/^\(/, ''));
    return [...(this.sorted.get(key)?.entries() ?? [])]
      .filter(([, score]) => {
        if (minExclusive ? score <= minScore : score < minScore) return false;
        if (maxExclusive ? score >= maxScore : score > maxScore) return false;
        return true;
      })
      .map(([member]) => member);
  }
  async zrem(key, member) {
    return this.sorted.get(key)?.delete(member) ? 1 : 0;
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
  async scan() {
    return ['0', []];
  }
}

const terminal = {
  traceTurnId: 'turn-1',
  invocationId: 'inv-1',
  ownerUserId: 'owner-1',
  threadId: 'thread-1',
  catId: 'cat-1',
  inputMessageId: 'input-1',
  outputMessageId: 'output-1',
  terminalAt: 200,
  terminalKind: 'completed',
  toolCalls: [],
};

const summary = {
  turnId: 'turn-1',
  threadId: 'thread-1',
  catId: 'cat-1',
  timestamp: 100,
  segments: [],
  delivery: [],
  totalCharCount: 0,
  totalTokenEstimate: 0,
  totalSegmentsObserved: 0,
  totalSegmentsAbsent: 0,
  durationMs: 0,
};

const detail = {
  turnId: 'turn-1',
  threadId: 'thread-1',
  catId: 'cat-1',
  timestamp: 100,
  sessionContentHash: null,
  turnContentHash: null,
  sessionCharCount: 0,
  sessionTokenEstimate: 0,
  turnCharCount: 0,
  turnTokenEstimate: 0,
  segments: [],
};

const body = (overrides = {}) => ({
  objectiveId: 'tool-access-correct-use',
  metricId: 'tool-schema-failure-count',
  unitRefs: [{ unitType: 'segment', unitId: 'S13' }],
  polarity: 'counterexample',
  note: 'tool schema was guessed',
  ...overrides,
});

async function setup() {
  const redis = new FakeRedis();
  const [{ InjectionTraceStore }, { PendingTraceMarkerStore }, { TraceAnnotationStore }, handler] = await Promise.all([
    import('../dist/domains/prompt-hooks/InjectionTraceStore.js'),
    import('../dist/infrastructure/harness-eval/trace-annotation/PendingTraceMarkerStore.js'),
    import('../dist/infrastructure/harness-eval/trace-annotation/TraceAnnotationStore.js'),
    import('../dist/infrastructure/harness-eval/deviation/report-harness-signal.js'),
  ]);
  return {
    redis,
    handler,
    stores: {
      traceStore: new InjectionTraceStore(redis),
      markerStore: new PendingTraceMarkerStore(redis),
      annotationStore: new TraceAnnotationStore(redis),
    },
    principal: { invocationId: 'inv-1', threadId: 'thread-1', userId: 'owner-1', catId: 'cat-1' },
  };
}

describe('cat_cafe_report_harness_signal is a trace marker', () => {
  test('before terminal it creates a marker and no metric annotation', async () => {
    const { handler, stores, principal } = await setup();
    const res = await handler.handleReportHarnessSignal(stores, principal, body());

    assert.equal(res.status, 200);
    assert.equal(res.body.traceStatus, 'pending-terminal');
    assert.equal(res.body.annotationsResolved, 0);
    assert.equal((await stores.markerStore.listPending('inv-1')).length, 1);
    assert.equal(
      (
        await stores.annotationStore.queryMetricWindow(
          'owner-1',
          'tool-access-correct-use',
          'tool-schema-failure-count',
          0,
          1000,
        )
      ).length,
      0,
    );
  });

  test('terminal resolver binds marker to the exact episode and writes one annotation', async () => {
    const { handler, stores, principal } = await setup();
    await handler.handleReportHarnessSignal(stores, principal, body());
    await stores.traceStore.persist(summary, detail);
    await stores.traceStore.closeEpisode(terminal);
    const { resolvePendingTraceMarkers } = await import(
      '../dist/infrastructure/harness-eval/trace-annotation/resolve-pending-markers.js'
    );

    assert.deepEqual(await resolvePendingTraceMarkers({ invocationId: 'inv-1', ...stores }), {
      resolved: 1,
      waitingForTerminal: false,
      unitEvaluationReady: false,
    });
    const annotations = await stores.annotationStore.queryMetricWindow(
      'owner-1',
      'tool-access-correct-use',
      'tool-schema-failure-count',
      0,
      1000,
    );
    assert.equal(annotations.length, 1);
    assert.equal(annotations[0].episodeRef.invocationId, 'inv-1');
    assert.equal(annotations[0].episodeRef.traceTurnId, 'turn-1');
    assert.equal(annotations[0].source, 'mcp-marker');
    assert.equal((await stores.markerStore.listPending('inv-1')).length, 0);
  });

  test('candidate marker stays a candidate and leaves the episode available for coverage review', async () => {
    const { handler, stores, principal } = await setup();
    await handler.handleReportHarnessSignal(stores, principal, body({ polarity: 'candidate' }));
    await stores.traceStore.persist(summary, detail);
    await stores.traceStore.closeEpisode(terminal);
    const { resolvePendingTraceMarkers } = await import(
      '../dist/infrastructure/harness-eval/trace-annotation/resolve-pending-markers.js'
    );

    await resolvePendingTraceMarkers({ invocationId: 'inv-1', ...stores });
    const annotations = await stores.annotationStore.queryMetricWindow(
      'owner-1',
      'tool-access-correct-use',
      'tool-schema-failure-count',
      0,
      1000,
    );
    assert.equal(annotations.length, 1);
    assert.equal(annotations[0].polarity, 'candidate');
    assert.deepEqual(await stores.traceStore.listUnclassifiedInvocationIds('owner-1', 0, 1000), ['inv-1']);
  });

  test('network retry does not create a second marker or annotation', async () => {
    const { handler, stores, principal } = await setup();
    await stores.traceStore.persist(summary, detail);
    await stores.traceStore.closeEpisode(terminal);

    const first = await handler.handleReportHarnessSignal(stores, principal, body({ idempotencyKey: 'retry-1' }));
    const second = await handler.handleReportHarnessSignal(stores, principal, body({ idempotencyKey: 'retry-1' }));
    assert.equal(first.body.outcome, 'created');
    assert.equal(second.body.outcome, 'duplicate');
    const annotations = await stores.annotationStore.queryMetricWindow(
      'owner-1',
      'tool-access-correct-use',
      'tool-schema-failure-count',
      0,
      1000,
    );
    assert.equal(annotations.length, 1);
  });

  test('legacy direct-observation and identity-spoof fields are rejected', async () => {
    const { handler, stores, principal } = await setup();
    const res = await handler.handleReportHarnessSignal(stores, principal, {
      ...body(),
      subjectCatId: 'other-cat',
      sourceAnchor: { kind: 'thread_message', messageId: 'message-1' },
      recordedBy: 'imposter',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error, 'invalid_body');
  });
});
