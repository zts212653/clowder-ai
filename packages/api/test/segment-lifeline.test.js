/**
 * F257 Phase D — Segment lifeline route tests.
 *
 * Tests the read-model join: InjectionTraceStore observations filtered by
 * segmentId + GuardRejectionEventLog events + HookOverrideStore state/history.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import Fastify from 'fastify';

// ── FakeRedis with sorted set + SET (SADD/SMEMBERS) support ──

class FakeRedis {
  constructor() {
    this.kv = new Map();
    this.sorted = new Map();
    this.sets = new Map(); // key → Set<member> for SADD/SMEMBERS
    this.ttls = new Map();
  }

  async set(key, value, ...args) {
    this.kv.set(key, value);
    if (args[0] === 'EX' && typeof args[1] === 'number') {
      this.ttls.set(key, args[1]);
    }
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
    const set = this.sorted.get(key) ?? new Map();
    set.set(member, score);
    this.sorted.set(key, set);
    return 1;
  }

  async zcard(key) {
    return this.sorted.get(key)?.size ?? 0;
  }

  async zrevrange(key, start, stop) {
    const set = this.sorted.get(key);
    if (!set) return [];
    const entries = [...set.entries()].sort((a, b) => b[1] - a[1]);
    return entries.slice(start, stop + 1).map(([m]) => m);
  }

  async zrangebyscore(key, min, max) {
    const set = this.sorted.get(key);
    if (!set) return [];
    return [...set.entries()]
      .filter(([, score]) => score >= min && score <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([m]) => m);
  }

  async zrem(key, member) {
    const set = this.sorted.get(key);
    if (!set) return 0;
    return set.delete(member) ? 1 : 0;
  }

  // Redis SET commands (SADD/SMEMBERS) — used by thread registry.
  // Unlike SCAN MATCH, these respect ioredis keyPrefix in production.
  async sadd(key, ...members) {
    const s = this.sets.get(key) ?? new Set();
    let added = 0;
    for (const m of members) {
      if (!s.has(m)) {
        s.add(m);
        added++;
      }
    }
    this.sets.set(key, s);
    return added;
  }

  async smembers(key) {
    const s = this.sets.get(key);
    return s ? [...s] : [];
  }

  // SCAN — minimal impl for backfill testing (returns all matches in one batch).
  // No keyPrefix simulation: FakeRedis stores keys without prefix, matching
  // the backfill code's `prefix = redis.options?.keyPrefix ?? ''` → '' path.
  async scan(_cursor, ...args) {
    const matchIdx = args.indexOf('MATCH');
    const pattern = matchIdx >= 0 ? args[matchIdx + 1] : '*';
    const escaped = pattern.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`^${escaped.replace(/\*/g, '.*')}$`);
    const allKeys = new Set([...this.kv.keys(), ...this.sorted.keys()]);
    return ['0', [...allKeys].filter((k) => regex.test(k))];
  }
}

// ── Helpers ──────────────────────────────────────────────────

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

function makeDetail(threadId, turnId) {
  return { threadId, turnId, raw: '' };
}

// ── listTracedThreadIds tests ───────────────────────────────

describe('InjectionTraceStore.listTracedThreadIds', () => {
  test('returns thread IDs from index keys', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    const s1 = makeSummary('thread-A', 'turn-1', 1000, 'opus', [makeSegment('S-identity')]);
    const s2 = makeSummary('thread-B', 'turn-2', 2000, 'codex', [makeSegment('S-rules')]);
    await store.persist(s1, makeDetail('thread-A', 'turn-1'));
    await store.persist(s2, makeDetail('thread-B', 'turn-2'));

    const threadIds = await store.listTracedThreadIds();
    assert.ok(threadIds.includes('thread-A'), 'should include thread-A');
    assert.ok(threadIds.includes('thread-B'), 'should include thread-B');
    assert.equal(threadIds.length, 2);
  });

  test('returns empty when no traces exist', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    const threadIds = await store.listTracedThreadIds();
    assert.deepEqual(threadIds, []);
  });

  test('backfills registry from pre-existing index keys when SET is empty', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    // Simulate pre-existing data: index sorted sets exist (from old persist()
    // calls before registry SET was added) but registry SET is empty.
    await redis.zadd('injection-trace-index:thread-old-A', 1000, 'turn-1');
    await redis.zadd('injection-trace-index:thread-old-B', 2000, 'turn-2');
    assert.equal((await redis.smembers('injection-trace-thread-registry')).length, 0);

    // listTracedThreadIds triggers lazy backfill via SCAN
    const threadIds = await store.listTracedThreadIds();
    assert.ok(threadIds.includes('thread-old-A'), 'should discover thread-old-A');
    assert.ok(threadIds.includes('thread-old-B'), 'should discover thread-old-B');
    assert.equal(threadIds.length, 2);
  });

  test('backfills legacy threads even when new threads already in registry', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    // Scenario: deploy Phase D → persist() fires before Console opens →
    // registry has 1 new thread but legacy index keys are not yet in SET.
    // (terra P1: old code skipped backfill here because registry was non-empty)
    const s = makeSummary('thread-new', 'turn-1', 1000, 'opus', [makeSegment('S-identity')]);
    await store.persist(s, makeDetail('thread-new', 'turn-1'));

    // Pre-existing index key NOT in registry (old data before Phase D)
    await redis.zadd('injection-trace-index:thread-legacy', 500, 'turn-0');

    const threadIds = await store.listTracedThreadIds();
    assert.ok(threadIds.includes('thread-new'), 'new thread from persist()');
    assert.ok(threadIds.includes('thread-legacy'), 'legacy thread discovered via backfill');
  });

  test('skips backfill when marker is set (already completed)', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    // Simulate: backfill already ran in a previous process (marker set)
    await redis.set('injection-trace-backfill-done', '1');

    // Legacy index key exists but backfill won't run
    await redis.zadd('injection-trace-index:thread-missed', 500, 'turn-0');

    const threadIds = await store.listTracedThreadIds();
    // Backfill skipped (marker present) — only registry entries visible
    assert.ok(!threadIds.includes('thread-missed'), 'backfill skipped due to marker');
    assert.equal(threadIds.length, 0);
  });
});

// ── collectObservations integration (via route helper) ──────

describe('segment-lifeline collectObservations', () => {
  test('filters observations by segmentId', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    // Two traces in one thread: S-identity (our target) and S-rules (different)
    const s1 = makeSummary('thread-A', 'turn-1', 5000, 'opus', [makeSegment('S-identity'), makeSegment('S-rules')]);
    const s2 = makeSummary('thread-A', 'turn-2', 6000, 'codex', [makeSegment('S-rules')]);
    await store.persist(s1, makeDetail('thread-A', 'turn-1'));
    await store.persist(s2, makeDetail('thread-A', 'turn-2'));

    // Query window [4000, 7000)
    const summaries = await store.queryWindow('thread-A', 4000, 7000);
    assert.equal(summaries.length, 2, 'should have 2 summaries');

    // Filter for S-identity
    const observations = summaries
      .filter((summary) => summary.segments.some((seg) => seg.segmentId === 'S-identity' && seg.status === 'observed'))
      .map((summary) => ({
        threadId: summary.threadId,
        turnId: summary.turnId,
        timestamp: summary.timestamp,
        catId: summary.catId,
      }));

    assert.equal(observations.length, 1, 'only 1 trace has S-identity');
    assert.equal(observations[0].turnId, 'turn-1');
    assert.equal(observations[0].catId, 'opus');
  });

  test('cross-thread observations merge correctly', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    // Same segment in two different threads
    await store.persist(
      makeSummary('thread-A', 'turn-1', 5000, 'opus', [makeSegment('S-identity')]),
      makeDetail('thread-A', 'turn-1'),
    );
    await store.persist(
      makeSummary('thread-B', 'turn-2', 6000, 'codex', [makeSegment('S-identity', { version: 2 })]),
      makeDetail('thread-B', 'turn-2'),
    );

    const threadIds = await store.listTracedThreadIds();
    assert.equal(threadIds.length, 2);

    // Query both threads
    const allObservations = [];
    for (const threadId of threadIds) {
      const summaries = await store.queryWindow(threadId, 4000, 7000);
      for (const summary of summaries) {
        const seg = summary.segments.find((s) => s.segmentId === 'S-identity' && s.status === 'observed');
        if (seg) {
          allObservations.push({
            threadId: summary.threadId,
            turnId: summary.turnId,
            timestamp: summary.timestamp,
            version: seg.version,
          });
        }
      }
    }

    assert.equal(allObservations.length, 2, 'found in both threads');
    const versions = allObservations.map((o) => o.version);
    assert.ok(versions.includes(1), 'v1 from thread-A');
    assert.ok(versions.includes(2), 'v2 from thread-B');
  });

  test('absent segments excluded from observations', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    await store.persist(
      makeSummary('thread-A', 'turn-1', 5000, 'opus', [makeSegment('S-identity', { status: 'absent' })]),
      makeDetail('thread-A', 'turn-1'),
    );

    const summaries = await store.queryWindow('thread-A', 4000, 7000);
    const observed = summaries.flatMap((s) =>
      s.segments.filter((seg) => seg.segmentId === 'S-identity' && seg.status === 'observed'),
    );
    assert.equal(observed.length, 0, 'absent segments excluded');
  });
});

// ── Status derivation ───────────────────────────────────────

describe('segment-lifeline status derivation', () => {
  test('idle when no observations', () => {
    const observations = [];
    const status = observations.length > 0 ? 'tracing' : 'idle';
    assert.equal(status, 'idle');
  });

  test('tracing when observations exist', () => {
    const observations = [{ version: 1 }];
    const status = observations.length > 0 ? 'tracing' : 'idle';
    assert.equal(status, 'tracing');
  });

  test('derives latest version from observations (most recent first)', () => {
    const observations = [
      { version: 2, timestamp: 6000 },
      { version: 1, timestamp: 5000 },
    ];
    // Sorted by timestamp descending, first non-null version is latest
    const sorted = [...observations].sort((a, b) => b.timestamp - a.timestamp);
    const latestVersion = sorted.find((o) => o.version != null)?.version ?? null;
    assert.equal(latestVersion, 2);
  });

  test('null version when no observations have version', () => {
    const observations = [{ version: null }];
    const latestVersion = observations.find((o) => o.version != null)?.version ?? null;
    assert.equal(latestVersion, null);
  });
});

// ── P2-1: windowMs validation ─────────────────────────────────

describe('segment-lifeline windowMs validation', () => {
  // Extract the same validation logic used in the route
  function parseWindowMs(raw) {
    const DEFAULT = 7 * 24 * 60 * 60 * 1000;
    const MAX = 30 * 24 * 60 * 60 * 1000;
    if (raw === undefined) return { ok: true, value: DEFAULT };
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return { ok: false };
    return { ok: true, value: Math.min(n, MAX) };
  }

  test('rejects Infinity', () => {
    assert.equal(parseWindowMs('Infinity').ok, false);
  });

  test('rejects negative', () => {
    assert.equal(parseWindowMs('-5000').ok, false);
  });

  test('rejects NaN', () => {
    assert.equal(parseWindowMs('abc').ok, false);
  });

  test('rejects zero', () => {
    assert.equal(parseWindowMs('0').ok, false);
  });

  test('caps at 30 days', () => {
    const thirtyOneDays = 31 * 24 * 60 * 60 * 1000;
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const result = parseWindowMs(String(thirtyOneDays));
    assert.equal(result.ok, true);
    assert.equal(result.value, thirtyDays);
  });

  test('accepts valid positive number', () => {
    const result = parseWindowMs('3600000');
    assert.equal(result.ok, true);
    assert.equal(result.value, 3600000);
  });

  test('defaults when undefined', () => {
    const result = parseWindowMs(undefined);
    assert.equal(result.ok, true);
    assert.equal(result.value, 7 * 24 * 60 * 60 * 1000);
  });
});

// ── P2-2: guard event three-key filtering (threadId + catId + ±120s) ──

describe('segment-lifeline guard event filtering', () => {
  const PROXIMITY_MS = 120_000;

  // Helper: match logic mirrors collectGuardEvents in segment-lifeline.ts
  function filterGuardEvents(events, observations) {
    return events.filter((e) =>
      observations.some(
        (obs) =>
          obs.threadId === e.threadId && obs.catId === e.catId && Math.abs(obs.timestamp - e.timestamp) <= PROXIMITY_MS,
      ),
    );
  }

  test('same thread+cat within ±120s passes', () => {
    const obs = [{ threadId: 'thread-A', catId: 'opus', timestamp: 5000 }];
    const events = [{ eventId: 'g1', threadId: 'thread-A', catId: 'opus', timestamp: 5100 }];
    assert.equal(filterGuardEvents(events, obs).length, 1);
  });

  test('same thread, different cat excluded', () => {
    const obs = [{ threadId: 'thread-A', catId: 'opus', timestamp: 5000 }];
    const events = [{ eventId: 'g1', threadId: 'thread-A', catId: 'codex', timestamp: 5000 }];
    assert.equal(filterGuardEvents(events, obs).length, 0, 'different catId');
  });

  test('same thread+cat but outside ±120s excluded', () => {
    const obs = [{ threadId: 'thread-A', catId: 'opus', timestamp: 5000 }];
    const events = [{ eventId: 'g1', threadId: 'thread-A', catId: 'opus', timestamp: 5000 + PROXIMITY_MS + 1 }];
    assert.equal(filterGuardEvents(events, obs).length, 0, 'outside window');
  });

  test('different thread excluded even if cat+time match', () => {
    const obs = [{ threadId: 'thread-A', catId: 'opus', timestamp: 5000 }];
    const events = [{ eventId: 'g1', threadId: 'thread-B', catId: 'opus', timestamp: 5000 }];
    assert.equal(filterGuardEvents(events, obs).length, 0, 'different thread');
  });

  test('no guard events when segment has no observations', () => {
    const events = [{ eventId: 'g1', threadId: 'thread-A', catId: 'opus', timestamp: 5000 }];
    assert.equal(filterGuardEvents(events, []).length, 0);
  });

  test('boundary: exactly ±120s passes', () => {
    const obs = [{ threadId: 'thread-A', catId: 'opus', timestamp: 5000 }];
    const events = [
      { eventId: 'g1', threadId: 'thread-A', catId: 'opus', timestamp: 5000 + PROXIMITY_MS },
      { eventId: 'g2', threadId: 'thread-A', catId: 'opus', timestamp: 5000 - PROXIMITY_MS },
    ];
    assert.equal(filterGuardEvents(events, obs).length, 2, 'boundary inclusive');
  });
});

// ── R16 route-level regression: epochGuardMetrics in JSON response ──

describe('segment-lifeline route: epochGuardMetrics in response (R16 P2-1)', () => {
  const SESSION_HEADERS = { 'x-test-session-user': 'test-user' };

  async function buildLifelineApp(traceStore, opts = {}) {
    const { segmentLifelineRoutes } = await import('../dist/routes/segment-lifeline.js');
    const app = Fastify({ logger: false });
    app.addHook('preHandler', async (request) => {
      const sessionUser = request.headers['x-test-session-user'];
      if (typeof sessionUser === 'string' && sessionUser.trim()) {
        request.sessionUserId = sessionUser.trim();
      }
    });
    await app.register(segmentLifelineRoutes, { traceStore, ...opts });
    await app.ready();
    return app;
  }

  test('response JSON contains epochGuardMetrics keyed by version', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    // Seed an observation so the chain has tracing data
    const now = Date.now();
    const s = makeSummary('thread-X', 'turn-1', now - 1000, 'opus', [makeSegment('S-test')]);
    await store.persist(s, makeDetail('thread-X', 'turn-1'));

    const app = await buildLifelineApp(store);
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test',
      headers: SESSION_HEADERS,
    });

    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);

    // Core contract: epochGuardMetrics must be present and keyed by version number
    assert.ok('epochGuardMetrics' in body, 'response must include epochGuardMetrics');
    assert.equal(typeof body.epochGuardMetrics, 'object', 'epochGuardMetrics is an object');

    // v1 (manifest baseline) must have an entry (empty array since no guard events)
    assert.ok('1' in body.epochGuardMetrics, 'epochGuardMetrics has v1 key');
    assert.ok(Array.isArray(body.epochGuardMetrics['1']), 'v1 value is an array');

    // Verify other shared-contract fields are present
    assert.equal(body.segmentId, 'S-test');
    assert.ok('chain' in body);
    assert.ok('activeVersion' in body);
    assert.ok('currentStatus' in body);
    assert.ok('window' in body);

    await app.close();
  });

  test('returns 401 without session', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    const app = await buildLifelineApp(store);
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test',
    });
    assert.equal(res.statusCode, 401);
    await app.close();
  });
});
