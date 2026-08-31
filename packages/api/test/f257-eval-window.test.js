/**
 * F257 #6 slice 6c — 判据② eval window / denominator provenance contract tests.
 *
 * Root cause (static call chain, sol proposal): the lifeline endpoint's
 * `window` is the CURRENT QUERY window; `SegmentJudgment` had the precise
 * eval `window + denominatorKind`, but `CachedJudgment` persisted only
 * counts + `evaluatedAt` — so the UI projected incomparable metrics
 * (tracing(18) from the query window vs eval injectionCount=0 from a
 * historical eval window) into the same context as if contradictory.
 *
 * Contract (sol, source thread 2026-07-22):
 *   - producer-written CachedJudgment MUST carry window + denominatorKind;
 *   - only legacy Redis JSON reads may lack them → explicit null (fail-visible);
 *   - window semantics [startMs, endMs) — evaluatedAt is NOT a window;
 *   - the judgment's OWN eval window must never be replaced by the query window.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';

// ── Minimal FakeRedis (InjectionTraceStore needs ZSET/SET/SCAN; SegmentJudgmentCache needs HASH) ──
class FakeRedis {
  constructor() {
    this.kv = new Map();
    this.sorted = new Map();
    this.sets = new Map();
    this.hashes = new Map();
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
  async hset(key, field, value) {
    const h = this.hashes.get(key) ?? new Map();
    h.set(field, value);
    this.hashes.set(key, h);
    return 1;
  }
  async hget(key, field) {
    return this.hashes.get(key)?.get(field) ?? null;
  }
  pipeline() {
    const ops = [];
    const self = this;
    const pipe = {
      hset(key, field, value) {
        ops.push({ op: 'hset', key, field, value });
        return pipe;
      },
      hget(key, field) {
        ops.push({ op: 'hget', key, field });
        return pipe;
      },
      zadd(key, score, member) {
        ops.push({ op: 'zadd', key, score, member });
        return pipe;
      },
      async exec() {
        const results = [];
        for (const op of ops) {
          if (op.op === 'hset') {
            await self.hset(op.key, op.field, op.value);
            results.push([null, 1]);
          } else if (op.op === 'hget') {
            results.push([null, await self.hget(op.key, op.field)]);
          } else if (op.op === 'zadd') {
            await self.zadd(op.key, op.score, op.member);
            results.push([null, 1]);
          }
        }
        return results;
      },
    };
    return pipe;
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
    const minN = min === '-inf' ? -Infinity : Number(min);
    const maxN = max === '+inf' ? Infinity : Number(max);
    return [...s.entries()]
      .filter(([, sc]) => sc >= minN && sc <= maxN)
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

/** CachedJudgment shape AFTER slice 6c — producer writes carry window + denominatorKind. */
function makeJudgment(segmentId, verdict, evaluatedAt, overrides = {}) {
  return {
    segmentId,
    verdict,
    injectionCount: 10,
    violationCount: 1,
    correlationConfidence: 'window',
    evaluatedAt,
    runId: `run-${verdict}`,
    segmentVersion: 1,
    window: { startMs: evaluatedAt - 86_400_000, endMs: evaluatedAt }, // judgment's OWN 1d eval window
    denominatorKind: 'fired-count',
    ...overrides,
  };
}

async function buildApp({
  judgment = null,
  segments = null,
  turns = null,
  overrideEvents = null,
  overrideState = null,
  rawCacheEntries = null,
} = {}) {
  const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
  const { segmentLifelineRoutes } = await import('../dist/routes/segment-lifeline.js');
  const redis = new FakeRedis();
  const traceStore = new InjectionTraceStore(redis);
  const now = Date.now();
  if (turns) {
    // Caller-controlled turn set (e.g. >MAX_OBSERVATIONS cap regression).
    for (const turn of turns) {
      const threadId = turn.threadId ?? 'thread-A';
      await traceStore.persist(makeSummary(threadId, turn.turnId, turn.timestamp, 'opus', turn.segments), {
        threadId,
        turnId: turn.turnId,
        raw: '',
      });
    }
  } else {
    await traceStore.persist(makeSummary('thread-A', 'turn-1', now - 1000, 'opus', segments ?? [makeSegment('S-x')]), {
      threadId: 'thread-A',
      turnId: 'turn-1',
      raw: '',
    });
  }

  const opts = { traceStore };
  if (rawCacheEntries) {
    // Real cache seam (sol R6 P2): seed raw JSON so normalization actually runs.
    const { SegmentJudgmentCache } = await import('../dist/domains/prompt-hooks/SegmentJudgmentCache.js');
    for (const e of rawCacheEntries) {
      await redis.hset('segment-judgment-latest', e.segmentId, e.json);
      await redis.zadd(`segment-judgment-history:${e.segmentId}`, e.evaluatedAt, e.json);
    }
    opts.judgmentCache = new SegmentJudgmentCache(redis);
  } else if (judgment) {
    opts.judgmentCache = { getHistory: async () => [judgment] };
  }
  if (overrideEvents || overrideState) {
    opts.overrideStore = {
      listEvents: async () => overrideEvents ?? [],
      listOverrides: async () => (overrideState ? [overrideState] : []),
      listVersions: async () => [],
    };
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

// ── Unit: buildVersionChain judgment attribution ──

describe('判据② chain builder — eval window/denominator attribution', () => {
  async function buildChainWith(judgment) {
    const { buildVersionChain } = await import('../dist/routes/segment-lifeline-chain.js');
    return buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [],
      observations: [],
      judgmentHistory: [judgment],
      currentContentVersion: null,
    });
  }

  test('epoch.eval carries the judgment OWN window + denominatorKind', async () => {
    const j = makeJudgment('S-x', 'alive', 9_000_000);
    const { chain } = await buildChainWith(j);
    const ev = chain[0].eval;
    assert.ok(ev, 'eval stage should be attached');
    assert.deepEqual(ev.evalWindow, { startMs: 9_000_000 - 86_400_000, endMs: 9_000_000 });
    assert.equal(ev.denominatorKind, 'fired-count');
    assert.equal(ev.evaluatedAt, 9_000_000, 'evaluatedAt preserved as point-in-time, not a window');
  });

  test('legacy judgment (window/denominatorKind undefined) → explicit null, never guessed', async () => {
    const legacy = makeJudgment('S-x', 'alive', 9_000_000);
    delete legacy.window;
    delete legacy.denominatorKind;
    const { chain } = await buildChainWith(legacy);
    const ev = chain[0].eval;
    assert.ok(ev);
    assert.equal(ev.evalWindow, null, 'missing window must surface as null, not derived from evaluatedAt');
    assert.equal(ev.denominatorKind, null, 'missing denominatorKind must surface as null');
  });

  test('per-version attribution: two judgments keep their own windows on their own epochs', async () => {
    const { buildVersionChain } = await import('../dist/routes/segment-lifeline-chain.js');
    const v1Judgment = makeJudgment('S-x', 'dormant', 5_000_000, { segmentVersion: 1 });
    const v2Judgment = makeJudgment('S-x', 'alive', 9_000_000, {
      segmentVersion: 2,
      window: { startMs: 9_000_000 - 3_600_000, endMs: 9_000_000 }, // v2 used a 1h eval window
    });
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [
        {
          eventId: 'e1',
          hookId: 'S-x',
          action: 'content-set',
          timestamp: 6_000_000,
          actorId: 'system',
          source: 'system',
          epochVersion: 2,
          contentVersion: 2,
        },
      ],
      observations: [],
      judgmentHistory: [v1Judgment, v2Judgment],
      currentContentVersion: 2,
    });
    const v1 = chain.find((e) => e.version === 1);
    const v2 = chain.find((e) => e.version === 2);
    assert.deepEqual(v1.eval.evalWindow, { startMs: 5_000_000 - 86_400_000, endMs: 5_000_000 });
    assert.deepEqual(v2.eval.evalWindow, { startMs: 9_000_000 - 3_600_000, endMs: 9_000_000 });
  });
});

// ── Route contract: eval window ≠ query window ──

describe('判据② route contract — eval window vs query window', () => {
  test('response.window stays the QUERY window; epoch eval carries the judgment OWN window', async () => {
    const now = Date.now();
    // Judgment evaluated 10 days ago over a 1-day eval window — OUTSIDE the default 7d query window.
    const judgment = makeJudgment('S-x', 'alive', now - 10 * 86_400_000);
    const app = await buildApp({ judgment });
    const body = await getLifeline(app);

    // Query window ≈ [now-7d, now]
    assert.ok(Math.abs(body.window.endMs - now) < 5000, 'response.window.endMs is the query end (~now)');
    assert.ok(body.window.startMs > now - 8 * 86_400_000, 'response.window.startMs is ~7d back');

    const epoch = body.chain.find((e) => e.version === 1);
    assert.ok(epoch.eval, 'eval stage present');
    assert.deepEqual(
      epoch.eval.evalWindow,
      { startMs: now - 11 * 86_400_000, endMs: now - 10 * 86_400_000 },
      'eval window must be the judgment OWN historical window, not the query window',
    );
    assert.equal(epoch.eval.denominatorKind, 'fired-count');
  });

  test('legacy cached judgment → API exposes explicit null provenance gap (fail-visible)', async () => {
    const now = Date.now();
    const legacy = makeJudgment('S-x', 'alive', now - 1000);
    delete legacy.window;
    delete legacy.denominatorKind;
    const app = await buildApp({ judgment: legacy });
    const body = await getLifeline(app);

    const epoch = body.chain.find((e) => e.version === 1);
    assert.ok(epoch.eval);
    assert.equal(epoch.eval.evalWindow, null, 'API must surface the provenance gap, not guess');
    assert.equal(epoch.eval.denominatorKind, null);
  });
});

// ── P1 (sol R6): completeness matrix — aggregate counts are EXACT full-window
// scans; only the DETAIL row list is capped at MAX_OBSERVATIONS. An unsampled
// epoch must never pose as zero-data (the R5 lower-bound model is superseded:
// counts carry no cap at all, the response carries observationsCapped for the
// detail list alone).
//
// Matrix: {<100, =100, >100} × {single-epoch, multi-epoch} × {fired, mixed
// fired/observe-only} — every cell asserts exact counts + detail cap flag.

describe('P1 (sol R6) route contract — exact aggregate counts + detail-list completeness', () => {
  const firedTurn = (turnId, timestamp, threadId) => ({ turnId, timestamp, threadId, segments: [makeSegment('S-x')] });
  const observedTurn = (turnId, timestamp, threadId) => ({
    turnId,
    timestamp,
    threadId,
    segments: [makeSegment('S-x', { pipelineStatus: 'observed' })],
  });

  test('<100 single-epoch all-fired → exact counts, no cap', async () => {
    const now = Date.now();
    const turns = [firedTurn('t1', now - 3000), firedTurn('t2', now - 2000), firedTurn('t3', now - 1000)];
    const body = await getLifeline(await buildApp({ turns }));
    const epoch = body.chain.find((e) => e.version === 1);
    assert.equal(epoch.tracing.observationCount, 3);
    assert.equal(epoch.tracing.firedCount, 3);
    assert.equal(body.observations.length, 3);
    assert.equal(body.observationsCapped, false);
  });

  test('<100 single-epoch observe-only → observation, NEVER injection (isFired semantics)', async () => {
    const body = await getLifeline(await buildApp({ segments: [makeSegment('S-x', { pipelineStatus: 'observed' })] }));
    const epoch = body.chain.find((e) => e.version === 1);
    assert.equal(epoch.tracing.observationCount, 1, 'the row IS an observation');
    assert.equal(epoch.tracing.firedCount, 0, 'observe-only must NOT count as an injection (fired-count)');
    assert.equal(body.observationsCapped, false);
  });

  test('=100 single-epoch all-fired → exact 100, NOT capped (exactly-100 is complete)', async () => {
    const now = Date.now();
    const turns = [];
    for (let i = 0; i < 100; i++) turns.push(firedTurn(`t-eq-${i}`, now - (i + 1) * 60_000));
    const body = await getLifeline(await buildApp({ turns }));
    const epoch = body.chain.find((e) => e.version === 1);
    assert.equal(epoch.tracing.observationCount, 100);
    assert.equal(epoch.tracing.firedCount, 100);
    assert.equal(body.observations.length, 100);
    assert.equal(body.observationsCapped, false, 'exactly 100 rows is complete — nothing exists beyond the cap');
  });

  test('>100 single-epoch all-fired (101) → counts exact 101, detail list capped with provenance', async () => {
    const now = Date.now();
    const turns = [];
    for (let i = 0; i < 101; i++) turns.push(firedTurn(`t-gt-${i}`, now - (i + 1) * 60_000));
    const body = await getLifeline(await buildApp({ turns }));
    const epoch = body.chain.find((e) => e.version === 1);
    assert.equal(epoch.tracing.observationCount, 101, 'aggregate count is the EXACT full-window total, not 100');
    assert.equal(epoch.tracing.firedCount, 101);
    assert.equal(body.observations.length, 100, 'detail rows stay capped at MAX_OBSERVATIONS');
    assert.equal(body.observationsCapped, true, 'detail-list completeness provenance');
    // Detail rows are the 100 MOST RECENT (deterministic sample).
    assert.equal(body.observations[0].turnId, 't-gt-0');
  });

  test('>100 multi-thread multi-epoch: 101st row on ACTIVE v2 → v2 tracing exact, never null (sol R6 repro)', async () => {
    const now = Date.now();
    const T = now - 55 * 60_000; // v2 activated 55min ago
    const turns = [];
    // thread-A: 100 fired rows all BEFORE T → v1
    for (let i = 0; i < 100; i++) turns.push(firedTurn(`tA-${i}`, now - (60 + i) * 60_000, 'thread-A'));
    // thread-B: the 101st row AFTER T → active v2 (persisted second — R5 dropped it under the global cap)
    turns.push(firedTurn('tB-101', now - 60_000, 'thread-B'));
    const app = await buildApp({
      turns,
      overrideEvents: [
        {
          eventId: 'e-v2',
          hookId: 'S-x',
          action: 'content-set',
          timestamp: T,
          actorId: 'system',
          source: 'system',
          epochVersion: 2,
          contentVersion: 2,
        },
      ],
      overrideState: { hookId: 'S-x', enabled: true, contentVersion: 2 },
    });
    const body = await getLifeline(app);

    const v1 = body.chain.find((e) => e.version === 1);
    const v2 = body.chain.find((e) => e.version === 2);
    assert.ok(v2.isActive, 'v2 is the active epoch');
    assert.equal(v1.tracing.observationCount, 100);
    assert.equal(v1.tracing.firedCount, 100);
    assert.ok(
      v2.tracing,
      'active epoch with a real observation must NEVER read as tracing:null (unsampled ≠ zero-data)',
    );
    assert.equal(v2.tracing.observationCount, 1);
    assert.equal(v2.tracing.firedCount, 1);
    assert.equal(body.observations.length, 100);
    assert.equal(body.observationsCapped, true);
    assert.equal(body.observations[0].threadId, 'thread-B', 'newest row survives the detail cap');
  });

  test('>100 mixed fired/observe-only (60 fired + 41 observe-only) → exact split, capped detail', async () => {
    const now = Date.now();
    const turns = [];
    for (let i = 0; i < 60; i++) turns.push(firedTurn(`tF-${i}`, now - (i + 1) * 60_000));
    for (let i = 0; i < 41; i++) turns.push(observedTurn(`tO-${i}`, now - (61 + i) * 60_000));
    const body = await getLifeline(await buildApp({ turns }));
    const epoch = body.chain.find((e) => e.version === 1);
    assert.equal(epoch.tracing.observationCount, 101);
    assert.equal(epoch.tracing.firedCount, 60, 'observe-only rows never inflate the fired metric');
    assert.equal(body.observationsCapped, true);
  });

  test('<100 multi-epoch mixed → exact per-epoch split, no cap', async () => {
    const now = Date.now();
    const T = now - 55 * 60_000;
    const turns = [
      firedTurn('v1-a', now - 70 * 60_000), // before T → v1
      firedTurn('v1-b', now - 65 * 60_000), // before T → v1
      observedTurn('v2-a', now - 60_000), // after T → v2, observe-only
    ];
    const app = await buildApp({
      turns,
      overrideEvents: [
        {
          eventId: 'e-v2',
          hookId: 'S-x',
          action: 'content-set',
          timestamp: T,
          actorId: 'system',
          source: 'system',
          epochVersion: 2,
          contentVersion: 2,
        },
      ],
      overrideState: { hookId: 'S-x', enabled: true, contentVersion: 2 },
    });
    const body = await getLifeline(app);
    const v1 = body.chain.find((e) => e.version === 1);
    const v2 = body.chain.find((e) => e.version === 2);
    assert.equal(v1.tracing.observationCount, 2);
    assert.equal(v1.tracing.firedCount, 2);
    assert.equal(v2.tracing.observationCount, 1);
    assert.equal(v2.tracing.firedCount, 0);
    assert.equal(body.observationsCapped, false);
  });
});

// ── P2 (sol R5): provenance gap kind — legacy-missing vs invalid-present ──

describe('P2 (sol R5) route contract — gap kind must not be mislabeled', () => {
  test('malformed-present window/denominator → invalid-present, distinct from legacy-missing', async () => {
    // As produced by the real cache read seam (normalizeCachedJudgment) for a
    // forged entry: value null + gap kind 'invalid-present'.
    const forged = makeJudgment('S-x', 'alive', 9_000_000, {
      window: null,
      windowGap: 'invalid-present',
      denominatorKind: null,
      denominatorGap: 'invalid-present',
    });
    const { buildVersionChain } = await import('../dist/routes/segment-lifeline-chain.js');
    const { chain } = buildVersionChain({
      manifestVersion: 1,
      overrideEvents: [],
      observations: [],
      judgmentHistory: [forged],
      currentContentVersion: null,
    });
    const ev = chain[0].eval;
    assert.equal(ev.evalWindow, null);
    assert.equal(ev.evalWindowGap, 'invalid-present', 'corrupted provenance must NOT be labeled legacy-missing');
    assert.equal(ev.denominatorKind, null);
    assert.equal(ev.denominatorGap, 'invalid-present');
  });

  test('legacy-missing fields → gap kind legacy-missing (route)', async () => {
    const now = Date.now();
    const legacy = makeJudgment('S-x', 'alive', now - 1000);
    delete legacy.window;
    delete legacy.denominatorKind;
    const app = await buildApp({ judgment: legacy });
    const body = await getLifeline(app);

    const epoch = body.chain.find((e) => e.version === 1);
    assert.equal(epoch.eval.evalWindowGap, 'legacy-missing');
    assert.equal(epoch.eval.denominatorGap, 'legacy-missing');
  });

  test('explicit-null provenance → invalid-present through the REAL cache read seam (sol R6 P2)', async () => {
    // The producer never writes null; a present-null field is malformed-present.
    // `raw == null` cannot see the difference — classification must be by
    // own-property presence, end-to-end through cache → chain → response.
    const now = Date.now();
    const entry = makeJudgment('S-x', 'alive', now - 1000, {
      window: null,
      denominatorKind: null,
    });
    delete entry.windowGap;
    delete entry.denominatorGap;
    const json = JSON.stringify(entry);
    assert.ok(json.includes('"window":null'), 'fixture sanity: explicit null survives serialization');

    const app = await buildApp({
      rawCacheEntries: [{ segmentId: 'S-x', evaluatedAt: now - 1000, json }],
    });
    const body = await getLifeline(app);

    const epoch = body.chain.find((e) => e.version === 1);
    assert.ok(epoch.eval);
    assert.equal(epoch.eval.evalWindow, null);
    assert.equal(epoch.eval.evalWindowGap, 'invalid-present', 'present-null is corrupted data, NOT a legacy gap');
    assert.equal(epoch.eval.denominatorKind, null);
    assert.equal(epoch.eval.denominatorGap, 'invalid-present');
  });

  test('absent provenance fields → legacy-missing through the REAL cache read seam (matrix control)', async () => {
    const now = Date.now();
    const entry = makeJudgment('S-x', 'alive', now - 1000);
    delete entry.window;
    delete entry.denominatorKind;
    delete entry.windowGap;
    delete entry.denominatorGap;
    const app = await buildApp({
      rawCacheEntries: [{ segmentId: 'S-x', evaluatedAt: now - 1000, json: JSON.stringify(entry) }],
    });
    const body = await getLifeline(app);

    const epoch = body.chain.find((e) => e.version === 1);
    assert.equal(epoch.eval.evalWindowGap, 'legacy-missing', 'absent keys are the legacy pre-6c shape');
    assert.equal(epoch.eval.denominatorGap, 'legacy-missing');
  });
});
