/**
 * F257 #6 slice 6b (rework per sol R1 + operator option B) — 判据①
 * activeStage / actionableStage read-model contract tests.
 *
 * Background (original incident, V2 thread msg 0001784469056616-000054):
 * Console rendered the SYNTHESIZED `governance.decision === 'pending'`
 * (produced from any alive/dormant verdict) as "待处理 / needs operator
 * decision" while NO governance Candidate existed — operator asked
 * "是要我审批吗 / 为什么看不到待审内容". The 固化 boundary (main thread msg
 * 0001784469935300-000115): the read model must distinguish
 *   - activeStage:     the loop's REAL stage (unmeasurable → tracing), and
 *   - actionableStage: derived ONLY from real pending Candidate count.
 * Candidate projection is not wired yet (option B) → the API must honestly
 * report source:'unavailable' instead of guessing from governance.pending.
 *
 * Covers sol R1 regressions:
 *   1. unmeasurable → active=tracing, actionable=null;
 *   2. governance lifecycle + 0 candidate → 无需动作;
 *   3. N candidate → actionable=governance + N;
 *   4. activeStage ≠ actionableStage is representable;
 *   5. no candidate provider → provenance gap (unavailable), never pending-derived.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';

// ── Minimal FakeRedis (InjectionTraceStore needs ZSET/SET/SCAN) ──
class FakeRedis {
  constructor() {
    this.kv = new Map();
    this.sorted = new Map();
    this.sets = new Map();
  }
  async set(key, value) {
    this.kv.set(key, value);
    return 'OK';
  }
  async get(key) {
    return this.kv.get(key) ?? null;
  }
  async del(key) {
    this.kv.delete(key);
    return 1;
  }
  async zadd(key, score, member) {
    const s = this.sorted.get(key) ?? new Map();
    s.set(member, score);
    this.sorted.set(key, s);
    return 1;
  }
  async zcard(key) {
    return this.sorted.get(key)?.size ?? 0;
  }
  async zrevrange(key, start, stop) {
    const s = this.sorted.get(key);
    if (!s) return [];
    return [...s.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(start, stop + 1)
      .map(([m]) => m);
  }
  async zrangebyscore(key, min, max) {
    const s = this.sorted.get(key);
    if (!s) return [];
    return [...s.entries()]
      .filter(([, sc]) => sc >= min && sc <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
  }
  async zrem(key, member) {
    return this.sorted.get(key)?.delete(member) ? 1 : 0;
  }
  async sadd(key, ...members) {
    const s = this.sets.get(key) ?? new Set();
    for (const m of members) s.add(m);
    this.sets.set(key, s);
    return members.length;
  }
  async smembers(key) {
    return [...(this.sets.get(key) ?? [])];
  }
  async scan(_c, ...args) {
    const i = args.indexOf('MATCH');
    const pat = i >= 0 ? args[i + 1] : '*';
    const rx = new RegExp(`^${pat.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&').replace(/\*/g, '.*')}$`);
    return ['0', [...new Set([...this.kv.keys(), ...this.sorted.keys()])].filter((k) => rx.test(k))];
  }
}

const SESSION_HEADERS = { 'x-test-session-user': 'test-user' };

function makeSummary(threadId, turnId, timestamp, catId, segments) {
  return {
    turnId,
    threadId,
    catId,
    timestamp,
    segments,
    delivery: [],
    totalCharCount: 100,
    totalTokenEstimate: 25,
    totalSegmentsObserved: segments.length,
    totalSegmentsAbsent: 0,
    durationMs: 5,
  };
}

function makeSegment(segmentId, opts = {}) {
  return {
    segmentId,
    stage: 'session-init',
    status: opts.status ?? 'observed',
    contentHash: 'hash-1',
    charCount: opts.charCount ?? 100,
    tokenEstimate: 25,
    version: opts.version ?? 1,
    pipelineStatus: opts.pipelineStatus ?? 'fired',
  };
}

function makeJudgment(segmentId, verdict, evaluatedAt) {
  return {
    segmentId,
    verdict,
    injectionCount: 10,
    violationCount: 1,
    correlationConfidence: 'high',
    evaluatedAt,
    runId: `run-${verdict}`,
    segmentVersion: 1,
  };
}

async function buildApp({ judgment = null, candidateCount, withProvider = false, providerFn } = {}) {
  const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
  const { segmentLifelineRoutes } = await import('../dist/routes/segment-lifeline.js');
  const redis = new FakeRedis();
  const traceStore = new InjectionTraceStore(redis);
  const now = Date.now();
  await traceStore.persist(makeSummary('thread-A', 'turn-1', now - 1000, 'opus', [makeSegment('S-x')]), {
    threadId: 'thread-A',
    turnId: 'turn-1',
    raw: '',
  });

  const opts = { traceStore };
  if (judgment) {
    opts.judgmentCache = { getHistory: async () => [judgment] };
  }
  if (providerFn) {
    opts.resolvePendingCandidateCount = providerFn;
  } else if (withProvider) {
    opts.resolvePendingCandidateCount = async () => candidateCount;
  }

  const app = Fastify({ logger: false });
  app.addHook('preHandler', async (request) => {
    const u = request.headers['x-test-session-user'];
    if (typeof u === 'string' && u.trim()) request.sessionUserId = u.trim();
  });
  await app.register(segmentLifelineRoutes, opts);
  await app.ready();
  return app;
}

async function getLifeline(app, segmentId = 'S-x') {
  const res = await app.inject({ method: 'GET', url: `/api/segment-lifeline/${segmentId}`, headers: SESSION_HEADERS });
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
  return JSON.parse(res.body);
}

// ── Unit: deriveActiveStage (loop model, not one-way pipeline) ──

describe('判据① deriveActiveStage — real loop stage', () => {
  let deriveActiveStage;
  const epoch = (verdict) => ({
    version: 1,
    origin: 'manifest',
    startedAt: 0,
    status: 'idle',
    isActive: true,
    tracing: null,
    eval: verdict === undefined ? null : { verdict, injectionCount: 10, violationCount: 1, evaluatedAt: 1000 },
    governance: null,
    events: [],
  });

  test('setup: import', async () => {
    ({ deriveActiveStage } = await import('../dist/routes/segment-lifeline-chain.js'));
    assert.equal(typeof deriveActiveStage, 'function');
  });

  test('unmeasurable → tracing (the 固化 core: active 回 tracing)', async () => {
    ({ deriveActiveStage } = await import('../dist/routes/segment-lifeline-chain.js'));
    assert.equal(deriveActiveStage(epoch('unmeasurable')), 'tracing');
  });

  test('observability-debt / needs-denominator → tracing (cannot conclude → keep collecting)', async () => {
    ({ deriveActiveStage } = await import('../dist/routes/segment-lifeline-chain.js'));
    assert.equal(deriveActiveStage(epoch('observability-debt')), 'tracing');
    assert.equal(deriveActiveStage(epoch('needs-denominator')), 'tracing');
  });

  test('retire-candidate → tracing (eval rejected → re-enter tracing)', async () => {
    ({ deriveActiveStage } = await import('../dist/routes/segment-lifeline-chain.js'));
    assert.equal(deriveActiveStage(epoch('retire-candidate')), 'tracing');
  });

  test('alive / dormant → governance (parked, informational)', async () => {
    ({ deriveActiveStage } = await import('../dist/routes/segment-lifeline-chain.js'));
    assert.equal(deriveActiveStage(epoch('alive')), 'governance');
    assert.equal(deriveActiveStage(epoch('dormant')), 'governance');
  });

  test('no eval yet → tracing; undefined epoch → tracing', async () => {
    ({ deriveActiveStage } = await import('../dist/routes/segment-lifeline-chain.js'));
    assert.equal(deriveActiveStage(epoch(undefined)), 'tracing');
    assert.equal(deriveActiveStage(undefined), 'tracing');
  });
});

// ── Route contract: activeStage + actionable in the response ──

describe('判据① route contract — activeStage / actionable', () => {
  test('R1-1: unmeasurable → activeStage=tracing, actionable null + unavailable', async () => {
    const app = await buildApp({ judgment: makeJudgment('S-x', 'unmeasurable', Date.now() - 500) });
    const body = await getLifeline(app);
    assert.equal(body.activeStage, 'tracing', 'unmeasurable must return the loop to tracing');
    assert.deepEqual(body.actionable, { stage: null, candidateCount: null, source: 'unavailable' });
    await app.close();
  });

  test('R1-2: alive (governance lifecycle) + no provider → honest gap, NOT pending-derived', async () => {
    const app = await buildApp({ judgment: makeJudgment('S-x', 'alive', Date.now() - 500) });
    const body = await getLifeline(app);
    assert.equal(body.activeStage, 'governance');
    // The synthesized governance.pending exists in the epoch data…
    const active = body.chain.find((e) => e.isActive);
    assert.equal(active.governance?.decision, 'pending', 'producer still records lifecycle stage');
    // …but actionable must NOT be inferred from it (original incident's false signal)
    assert.deepEqual(body.actionable, { stage: null, candidateCount: null, source: 'unavailable' });
    await app.close();
  });

  test('R1-3a: provider 0 candidates → 无需动作 (stage null, count 0)', async () => {
    const app = await buildApp({
      judgment: makeJudgment('S-x', 'alive', Date.now() - 500),
      withProvider: true,
      candidateCount: 0,
    });
    const body = await getLifeline(app);
    assert.deepEqual(body.actionable, { stage: null, candidateCount: 0, source: 'candidate-count' });
    await app.close();
  });

  test('R1-3b: provider N=2 candidates → actionable=governance + count', async () => {
    const app = await buildApp({
      judgment: makeJudgment('S-x', 'alive', Date.now() - 500),
      withProvider: true,
      candidateCount: 2,
    });
    const body = await getLifeline(app);
    assert.deepEqual(body.actionable, { stage: 'governance', candidateCount: 2, source: 'candidate-count' });
    await app.close();
  });

  test('R1-5: provider returns null → provenance gap (unavailable)', async () => {
    const app = await buildApp({
      judgment: makeJudgment('S-x', 'alive', Date.now() - 500),
      withProvider: true,
      candidateCount: null,
    });
    const body = await getLifeline(app);
    assert.deepEqual(body.actionable, { stage: null, candidateCount: null, source: 'unavailable' });
    await app.close();
  });

  test('R1-4: activeStage ≠ actionable.stage is representable (governance active, nothing actionable)', async () => {
    const app = await buildApp({
      judgment: makeJudgment('S-x', 'dormant', Date.now() - 500),
      withProvider: true,
      candidateCount: 0,
    });
    const body = await getLifeline(app);
    assert.equal(body.activeStage, 'governance');
    assert.equal(body.actionable.stage, null, 'active at governance does NOT imply actionable');
    await app.close();
  });

  test('no judgment at all → activeStage tracing + unavailable', async () => {
    const app = await buildApp({});
    const body = await getLifeline(app);
    assert.equal(body.activeStage, 'tracing');
    assert.deepEqual(body.actionable, { stage: null, candidateCount: null, source: 'unavailable' });
    await app.close();
  });

  // R2 P1-4: the decisive cross-state — active ≠ actionable, BOTH non-empty.
  test('R2 P1-4: retire-candidate + 2 real candidates → active=tracing AND actionable=governance(2)', async () => {
    const app = await buildApp({
      judgment: makeJudgment('S-x', 'retire-candidate', Date.now() - 500),
      withProvider: true,
      candidateCount: 2,
    });
    const body = await getLifeline(app);
    assert.equal(body.activeStage, 'tracing', 'retire-candidate loops back to tracing');
    assert.deepEqual(body.actionable, { stage: 'governance', candidateCount: 2, source: 'candidate-count' });
    const active = body.chain.find((e) => e.isActive);
    assert.equal(active.governance, null, 'no synthesized governance.pending for retire-candidate');
    await app.close();
  });
});

// ── R2 P2-3: provider seam fail-safe (fail-closed to honest gap) ──

describe('判据① provider fail-safe (R2 P2-3)', () => {
  const aliveJudgment = () => makeJudgment('S-x', 'alive', Date.now() - 500);

  test('provider throws → 200 + unavailable (endpoint must not 500)', async () => {
    const app = await buildApp({
      judgment: aliveJudgment(),
      providerFn: async () => {
        throw new Error('projection store down');
      },
    });
    const body = await getLifeline(app);
    assert.deepEqual(body.actionable, { stage: null, candidateCount: null, source: 'unavailable' });
    await app.close();
  });

  for (const [label, bad] of [
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
  ]) {
    test(`provider returns ${label} count → unavailable (never a guessed count)`, async () => {
      const app = await buildApp({ judgment: aliveJudgment(), providerFn: async () => bad });
      const body = await getLifeline(app);
      assert.deepEqual(
        body.actionable,
        { stage: null, candidateCount: null, source: 'unavailable' },
        `${label} count must degrade to the honest gap`,
      );
      await app.close();
    });
  }

  test('provider returning valid 3 still works after fail-safe guard', async () => {
    const app = await buildApp({ judgment: aliveJudgment(), providerFn: async () => 3 });
    const body = await getLifeline(app);
    assert.deepEqual(body.actionable, { stage: 'governance', candidateCount: 3, source: 'candidate-count' });
    await app.close();
  });
});
