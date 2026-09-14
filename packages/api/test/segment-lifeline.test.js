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

/**
 * Seed one complete trace episode: the prompt summary plus its terminal sidecar.
 *
 * The lifeline reads the caller's owner-indexed episode pool, so a summary with
 * no closed episode is invisible to it by design — ownership lives only on the
 * terminal sidecar. Tests must close the episode to make a turn readable.
 */
async function seedEpisode(store, { owner, threadId, turnId, timestamp, catId, segments }) {
  await store.persist(makeSummary(threadId, turnId, timestamp, catId, segments), makeDetail(threadId, turnId));
  await store.closeEpisode({
    traceTurnId: turnId,
    invocationId: `inv-${threadId}-${turnId}`,
    ownerUserId: owner,
    threadId,
    catId,
    inputMessageId: null,
    outputMessageId: null,
    terminalAt: timestamp,
    terminalKind: 'completed',
    toolCalls: [],
  });
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

// ── R16 route-level regression: epochGuardMetrics in JSON response ──

describe('segment-lifeline route: response contract', () => {
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

  test('summary response carries no guard projection, so nothing derives evidence nobody reads', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    // Seed an observation so the chain has tracing data
    const now = Date.now();
    await seedEpisode(store, {
      owner: 'test-user',
      threadId: 'thread-X',
      turnId: 'turn-1',
      timestamp: now - 1000,
      catId: 'opus',
      segments: [makeSegment('S-test')],
    });

    const app = await buildLifelineApp(store);
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test',
      headers: SESSION_HEADERS,
    });

    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);

    // The summary route used to correlate guard events across the whole window
    // and attribute them per epoch. No console surface ever read either field:
    // the live modal renders governance through ObjectiveGovernancePanel, and
    // guard evidence is shown per event by the replay route. Publishing them
    // cost an unfenced cross-owner scan per request for nobody.
    assert.ok(!('guardEvents' in body), 'no guard projection in the summary contract');
    assert.ok(!('epochGuardMetrics' in body), 'no per-epoch guard attribution in the summary contract');

    // Verify other shared-contract fields are present
    assert.equal(body.segmentId, 'S-test');
    assert.ok('chain' in body);
    assert.deepEqual(body.versionActivations, [{ timestamp: 0, version: 1 }]);
    assert.ok('activeVersion' in body);
    assert.ok('currentStatus' in body);
    assert.ok('window' in body);

    await app.close();
  });

  test('reports injection and disabled counts separately while detail rows stay injection-only', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);
    const now = Date.now();

    await seedEpisode(store, {
      owner: 'test-user',
      threadId: 'thread-X',
      turnId: 'turn-fired',
      timestamp: now - 2000,
      catId: 'opus',
      segments: [makeSegment('S-test')],
    });
    await seedEpisode(store, {
      owner: 'test-user',
      threadId: 'thread-X',
      turnId: 'turn-disabled',
      timestamp: now - 1000,
      catId: 'opus',
      segments: [makeSegment('S-test', { status: 'absent', pipelineStatus: 'disabled' })],
    });

    const app = await buildLifelineApp(store);
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test',
      headers: SESSION_HEADERS,
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);

    assert.deepEqual(body.chain[0].tracing, {
      observationCount: 2,
      firedCount: 1,
      disabledCount: 1,
      firstAt: now - 2000,
      lastAt: now - 1000,
    });
    assert.deepEqual(
      body.observations.map(({ turnId, pipelineStatus }) => ({ turnId, pipelineStatus })),
      [{ turnId: 'turn-fired', pipelineStatus: 'fired' }],
      'the replay list named 注入明细 must not mix in disabled rows',
    );

    await app.close();
  });

  test("another owner's episodes never enter this owner's lifeline", async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);
    const now = Date.now();

    // Same segment fired for two different owners inside the same window.
    await seedEpisode(store, {
      owner: 'test-user',
      threadId: 'thread-mine',
      turnId: 'turn-mine',
      timestamp: now - 2000,
      catId: 'opus',
      segments: [makeSegment('S-test')],
    });
    await seedEpisode(store, {
      owner: 'other-user',
      threadId: 'thread-theirs',
      turnId: 'turn-theirs',
      timestamp: now - 1000,
      catId: 'codex',
      segments: [makeSegment('S-test', { version: 2 })],
    });

    const app = await buildLifelineApp(store);
    const res = await app.inject({
      method: 'GET',
      url: '/api/segment-lifeline/S-test',
      headers: SESSION_HEADERS,
    });
    assert.equal(res.statusCode, 200, res.body);
    const body = JSON.parse(res.body);

    // Detail rows must not name the other owner's thread, turn or cat.
    assert.deepEqual(
      body.observations.map(({ threadId, turnId, catId }) => ({ threadId, turnId, catId })),
      [{ threadId: 'thread-mine', turnId: 'turn-mine', catId: 'opus' }],
      "only the requesting owner's rows are readable",
    );
    // Aggregate counts must not silently fold the other owner's activity in
    // either — a count of 2 here would leak existence without leaking names.
    assert.equal(body.chain[0].tracing.observationCount, 1, 'counts stay owner-scoped');
    assert.equal(body.chain[0].tracing.firedCount, 1);

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
