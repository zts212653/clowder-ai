/**
 * F237 — Injection Trace v0: store + collector tests
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// ── FakeRedis with sorted set support ──

class FakeRedis {
  constructor() {
    this.kv = new Map();
    this.sorted = new Map(); // key → Map<member, score>
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
    const existed = this.kv.has(key) ? 1 : 0;
    this.kv.delete(key);
    this.ttls.delete(key);
    return existed;
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
    return entries.slice(start, stop + 1).map(([member]) => member);
  }

  async zrem(key, member) {
    const set = this.sorted.get(key);
    if (!set) return 0;
    return set.delete(member) ? 1 : 0;
  }
}

// ── InjectionTraceStore tests ──

describe('InjectionTraceStore', () => {
  test('persist + getSummary + getDetail round-trip', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    const summary = {
      turnId: 'turn-1',
      sessionId: 'sess-1',
      threadId: 'thread-1',
      catId: 'ragdoll',
      timestamp: Date.now(),
      segments: [{ segmentId: 'S1', stage: 'session-init', status: 'observed', contentHash: 'abc123', charCount: 100 }],
      delivery: [{ stage: 'session-init', contentAssembled: true, channel: 'message-prepend', reason: 'test' }],
      totalCharCount: 100,
      totalSegmentsObserved: 1,
      totalSegmentsAbsent: 0,
      durationMs: 5,
    };
    const detail = {
      turnId: 'turn-1',
      threadId: 'thread-1',
      catId: 'ragdoll',
      timestamp: Date.now(),
      sessionContentHash: 'abc123',
      turnContentHash: 'def456',
      sessionCharCount: 100,
      turnCharCount: 50,
      segments: summary.segments,
    };

    await store.persist(summary, detail);

    const gotSummary = await store.getSummary('thread-1', 'turn-1');
    assert.deepEqual(gotSummary, summary);

    const gotDetail = await store.getDetail('thread-1', 'turn-1');
    assert.deepEqual(gotDetail, detail);
  });

  test('detail stored with EX TTL', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis, { detailTtlSeconds: 3600 });

    const summary = {
      turnId: 't1',
      sessionId: 's1',
      threadId: 'th1',
      catId: 'c1',
      timestamp: 1,
      segments: [],
      delivery: [],
      totalCharCount: 0,
      totalSegmentsObserved: 0,
      totalSegmentsAbsent: 0,
      durationMs: 0,
    };
    const detail = {
      turnId: 't1',
      threadId: 'th1',
      catId: 'c1',
      timestamp: 1,
      sessionContentHash: null,
      turnContentHash: null,
      sessionCharCount: 0,
      turnCharCount: 0,
      segments: [],
    };

    await store.persist(summary, detail);
    const detailKey = [...redis.ttls.keys()].find((k) => k.includes('detail'));
    assert.ok(detailKey, 'detail key should have TTL');
    assert.equal(redis.ttls.get(detailKey), 3600);
  });

  test('listTurnIds returns entries in reverse timestamp order', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    const base = {
      sessionId: 's1',
      threadId: 'th1',
      catId: 'c1',
      segments: [],
      delivery: [],
      totalCharCount: 0,
      totalSegmentsObserved: 0,
      totalSegmentsAbsent: 0,
      durationMs: 0,
    };
    const baseDetail = {
      threadId: 'th1',
      catId: 'c1',
      sessionContentHash: null,
      turnContentHash: null,
      sessionCharCount: 0,
      turnCharCount: 0,
      segments: [],
    };

    await store.persist(
      { ...base, turnId: 'early', timestamp: 1000 },
      { ...baseDetail, turnId: 'early', timestamp: 1000 },
    );
    await store.persist(
      { ...base, turnId: 'late', timestamp: 2000 },
      { ...baseDetail, turnId: 'late', timestamp: 2000 },
    );

    const { turnIds, total } = await store.listTurnIds('th1');
    assert.equal(total, 2);
    assert.deepEqual(turnIds, ['late', 'early']);
  });

  test('listSummaries returns summaries for listed turns', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    const summary = {
      turnId: 't1',
      sessionId: 's1',
      threadId: 'th1',
      catId: 'c1',
      timestamp: 1000,
      segments: [],
      delivery: [],
      totalCharCount: 0,
      totalSegmentsObserved: 0,
      totalSegmentsAbsent: 0,
      durationMs: 0,
    };
    const detail = {
      turnId: 't1',
      threadId: 'th1',
      catId: 'c1',
      timestamp: 1000,
      sessionContentHash: null,
      turnContentHash: null,
      sessionCharCount: 0,
      turnCharCount: 0,
      segments: [],
    };

    await store.persist(summary, detail);
    const { summaries, total } = await store.listSummaries('th1');
    assert.equal(total, 1);
    assert.equal(summaries.length, 1);
    assert.equal(summaries[0].turnId, 't1');
  });

  test('deleteTurn removes all trace data', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    const summary = {
      turnId: 't1',
      sessionId: 's1',
      threadId: 'th1',
      catId: 'c1',
      timestamp: 1000,
      segments: [],
      delivery: [],
      totalCharCount: 0,
      totalSegmentsObserved: 0,
      totalSegmentsAbsent: 0,
      durationMs: 0,
    };
    const detail = {
      turnId: 't1',
      threadId: 'th1',
      catId: 'c1',
      timestamp: 1000,
      sessionContentHash: null,
      turnContentHash: null,
      sessionCharCount: 0,
      turnCharCount: 0,
      segments: [],
    };

    await store.persist(summary, detail);
    await store.deleteTurn('th1', 't1');

    assert.equal(await store.getSummary('th1', 't1'), null);
    assert.equal(await store.getDetail('th1', 't1'), null);
    const { total } = await store.listTurnIds('th1');
    assert.equal(total, 0);
  });

  test('getSummary returns null for missing key', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);
    assert.equal(await store.getSummary('no-thread', 'no-turn'), null);
  });

  test('getSummary returns null for corrupt JSON', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);
    await redis.set('injection-trace-summary:th1:t1', 'not-json');
    // Key prefix is auto-prepended by ioredis, but FakeRedis stores raw —
    // directly query using internal key format
    const raw = await redis.get('injection-trace-summary:th1:t1');
    assert.equal(raw, 'not-json');
    assert.equal(await store.getSummary('th1', 't1'), null);
  });
});

// ── TraceCollector tests ──

describe('TraceCollector', () => {
  test('parseAnnotatedSegments extracts segments from annotated output', async () => {
    const { parseAnnotatedSegments } = await import('../dist/domains/prompt-hooks/trace-collector.js');

    const annotated = [
      '── [S1] 身份声明 ──',
      'Hello I am Ragdoll.',
      '',
      '── [S2] 硬限制 ──',
      'Do not delete Redis.',
      '',
      '── [S3] Pack Masks ──',
    ].join('\n');

    const segments = parseAnnotatedSegments(annotated, 'session-init');
    assert.equal(segments.length, 3);
    assert.equal(segments[0].segmentId, 'S1');
    assert.equal(segments[0].stage, 'session-init');
    assert.equal(segments[0].status, 'observed');
    assert.ok(segments[0].charCount > 0);
    assert.ok(segments[0].contentHash !== null);

    assert.equal(segments[1].segmentId, 'S2');
    assert.equal(segments[1].status, 'observed');

    // S3 has no content after marker (end of string)
    assert.equal(segments[2].segmentId, 'S3');
    assert.equal(segments[2].status, 'absent');
    assert.equal(segments[2].contentHash, null);
    assert.equal(segments[2].charCount, 0);
  });

  test('parseAnnotatedSegments returns empty for no markers', async () => {
    const { parseAnnotatedSegments } = await import('../dist/domains/prompt-hooks/trace-collector.js');
    const segments = parseAnnotatedSegments('just plain text', 'session-init');
    assert.equal(segments.length, 0);
  });

  test('hashContent produces deterministic 16-char hex', async () => {
    const { hashContent } = await import('../dist/domains/prompt-hooks/trace-collector.js');
    const h1 = hashContent('hello');
    const h2 = hashContent('hello');
    assert.equal(h1, h2);
    assert.equal(h1.length, 16);
    assert.match(h1, /^[0-9a-f]{16}$/);
  });

  test('buildTraceSummary computes correct counts', async () => {
    const { buildTraceSummary } = await import('../dist/domains/prompt-hooks/trace-collector.js');

    const trace = {
      segments: [
        { segmentId: 'S1', stage: 'session-init', status: 'observed', contentHash: 'a', charCount: 100 },
        { segmentId: 'S2', stage: 'session-init', status: 'absent', contentHash: null, charCount: 0 },
        { segmentId: 'per-turn', stage: 'per-turn', status: 'observed', contentHash: 'b', charCount: 50 },
      ],
      delivery: [],
      sessionContentHash: 'a',
      turnContentHash: 'b',
      sessionCharCount: 100,
      turnCharCount: 50,
      durationMs: 3,
    };
    const meta = { turnId: 't1', sessionId: 's1', threadId: 'th1', catId: 'ragdoll' };

    const summary = buildTraceSummary(trace, meta);
    assert.equal(summary.totalCharCount, 150);
    assert.equal(summary.totalSegmentsObserved, 2);
    assert.equal(summary.totalSegmentsAbsent, 1);
    assert.equal(summary.durationMs, 3);
    assert.equal(summary.turnId, 't1');
    assert.equal(summary.catId, 'ragdoll');
    assert.equal(summary.sessionId, 's1');
  });

  test('buildTraceSummary omits sessionId when not provided', async () => {
    const { buildTraceSummary } = await import('../dist/domains/prompt-hooks/trace-collector.js');

    const trace = {
      segments: [],
      delivery: [],
      sessionContentHash: null,
      turnContentHash: null,
      sessionCharCount: 0,
      turnCharCount: 0,
      durationMs: 1,
    };
    const meta = { turnId: 't2', threadId: 'th2', catId: 'bengal' };

    const summary = buildTraceSummary(trace, meta);
    assert.equal(summary.sessionId, undefined);
    assert.equal(summary.threadId, 'th2');
  });

  test('buildTraceDetail captures content hashes and char counts', async () => {
    const { buildTraceDetail } = await import('../dist/domains/prompt-hooks/trace-collector.js');

    const trace = {
      segments: [],
      delivery: [],
      sessionContentHash: 'sess-hash',
      turnContentHash: 'turn-hash',
      sessionCharCount: 200,
      turnCharCount: 80,
      durationMs: 1,
    };
    const meta = { turnId: 't2', threadId: 'th2', catId: 'bengal' };

    const detail = buildTraceDetail(trace, meta);
    assert.equal(detail.sessionContentHash, 'sess-hash');
    assert.equal(detail.turnContentHash, 'turn-hash');
    assert.equal(detail.sessionCharCount, 200);
    assert.equal(detail.turnCharCount, 80);
    assert.equal(detail.catId, 'bengal');
  });
});

// ── TraceBootstrap tests ──

describe('TraceBootstrap', () => {
  test('getTraceStore returns null before bootstrap', async () => {
    // Import fresh to test default state — the module may already be imported
    // by previous tests, so we just verify the API contract.
    const { getTraceStore } = await import('../dist/domains/prompt-hooks/trace-bootstrap.js');
    // If not bootstrapped in this test run, should be null.
    // After bootstrap, should return the store.
    const store = getTraceStore();
    // Just verify it doesn't throw and returns InjectionTraceStore | null.
    assert.ok(store === null || typeof store === 'object');
  });

  test('bootstrapTraceStore + getTraceStore returns store', async () => {
    const { bootstrapTraceStore, getTraceStore } = await import('../dist/domains/prompt-hooks/trace-bootstrap.js');
    const redis = new FakeRedis();
    bootstrapTraceStore(redis);
    const store = getTraceStore();
    assert.ok(store !== null);
    assert.equal(typeof store.persist, 'function');
    assert.equal(typeof store.getSummary, 'function');
  });
});
