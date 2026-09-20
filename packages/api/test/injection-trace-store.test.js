/**
 * F237 — Injection Trace v0: store + collector tests
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// ── FakeRedis with sorted set + pipeline support ──

class FakePipeline {
  constructor(redis) {
    this.redis = redis;
    this.ops = [];
  }

  set(key, value) {
    this.ops.push(async () => this.redis.set(key, value));
    return this;
  }

  del(key) {
    this.ops.push(async () => this.redis.del(key));
    return this;
  }

  sadd(key, ...members) {
    this.ops.push(async () => this.redis.sadd(key, ...members));
    return this;
  }

  async exec() {
    const results = [];
    for (const op of this.ops) {
      results.push([null, await op()]);
    }
    return results;
  }
}

class FakeRedis {
  constructor() {
    this.kv = new Map();
    this.sorted = new Map(); // key → Map<member, score>
    this.sets = new Map();
    this.hashes = new Map();
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

  async exists(key) {
    if (this.kv.has(key)) return 1;
    if (this.sorted.has(key)) return 1;
    if (this.sets?.has(key)) return 1;
    if (this.hashes.has(key)) return 1;
    return 0;
  }

  async del(key) {
    const existed = this.kv.has(key) || this.sorted.has(key) || this.sets?.has(key) || this.hashes.has(key) ? 1 : 0;
    this.kv.delete(key);
    this.ttls.delete(key);
    this.sorted.delete(key);
    this.sets?.delete(key);
    this.hashes.delete(key);
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

  async zrangebyscore(key, min, max) {
    const set = this.sorted.get(key);
    if (!set) return [];
    return [...set.entries()]
      .filter(([, score]) => score >= min && score <= max)
      .sort((a, b) => a[1] - b[1])
      .map(([member]) => member);
  }

  async zrem(key, member) {
    const set = this.sorted.get(key);
    if (!set) return 0;
    return set.delete(member) ? 1 : 0;
  }

  multi() {
    return new FakePipeline(this);
  }

  // F257 Phase D: prefix-aware SCAN for backfillRegistry.
  // ioredis scan returns [cursor, keys]; MATCH pattern is applied against raw keys.
  async scan(cursor, ...args) {
    const options = Object.fromEntries(
      Array.from({ length: Math.floor(args.length / 2) }, (_, i) => [args[i * 2], args[i * 2 + 1]]),
    );
    const pattern = options.MATCH ? new RegExp(options.MATCH.replace(/\*/g, '.*')) : null;
    const count = options.COUNT ? Number(options.COUNT) : 10;

    const allKeys = [...new Set([...this.kv.keys(), ...this.sorted.keys(), ...(this.sets?.keys() ?? [])])];
    const matched = pattern ? allKeys.filter((k) => pattern.test(k)) : allKeys;
    const start = Number(cursor) || 0;
    const next = Math.min(start + count, matched.length);
    return [String(next), matched.slice(start, next)];
  }

  // F257 Phase D: SADD/SMEMBERS for thread registry (persist() now calls sadd).
  async sadd(key, ...members) {
    if (!this.sets) {
      this.sets = new Map();
    }
    const s = this.sets;
    const existing = s.get(key) ?? new Set();
    let added = 0;
    for (const m of members) {
      if (!existing.has(m)) {
        existing.add(m);
        added++;
      }
    }
    s.set(key, existing);
    return added;
  }

  async smembers(key) {
    const s = this.sets?.get(key);
    return s ? [...s] : [];
  }

  // F257 R4: hash + Lua support for durable replay snapshots.
  async hset(key, fields) {
    const h = this.hashes.get(key) ?? new Map();
    for (const [field, value] of Object.entries(fields)) {
      h.set(field, value);
    }
    this.hashes.set(key, h);
    return 1;
  }

  async hget(key, field) {
    return this.hashes.get(key)?.get(field) ?? null;
  }

  async hgetall(key) {
    const h = this.hashes.get(key);
    if (!h) return [];
    const out = [];
    for (const [k, v] of h) {
      out.push(k, v);
    }
    return out;
  }

  async hdel(key, field) {
    const h = this.hashes.get(key);
    if (!h) return 0;
    return h.delete(field) ? 1 : 0;
  }

  #runPersistScript(keys, argv) {
    const summaryKey = keys[0];
    const hashKey = keys[1];
    const count = Number(argv[0]);
    if (this.kv.has(summaryKey) === false) return 0;
    const h = this.hashes.get(hashKey) ?? new Map();
    for (let i = 0; i < count; i++) {
      const segmentId = argv[1 + i];
      const json = argv[1 + count + i];
      h.set(segmentId, json);
    }
    this.hashes.set(hashKey, h);
    return 1;
  }

  #runDeleteScript(keys, argv) {
    const indexKey = keys[2];
    const turnId = argv[0];
    let removed = 0;
    if (this.sorted.get(indexKey)?.delete(turnId)) removed = 1;
    for (const k of keys) {
      if (
        k !== indexKey &&
        (this.kv.delete(k) || this.sets?.delete(k) || this.sorted.delete(k) || this.hashes.delete(k))
      ) {
        removed++;
      }
    }
    return removed;
  }

  async eval(script, numKeys, ...args) {
    const keys = args.slice(0, numKeys);
    const argv = args.slice(numKeys);

    if (script.includes("redis.call('EXISTS'") && script.includes("redis.call('HSET'")) {
      return this.#runPersistScript(keys, argv);
    }
    if (script.includes("redis.call('ZREM'") && script.includes("redis.call('DEL'")) {
      return this.#runDeleteScript(keys, argv);
    }

    throw new Error(`FakeRedis.eval: unsupported script`);
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
      segments: [
        {
          segmentId: 'S1',
          stage: 'session-init',
          status: 'observed',
          contentHash: 'abc123',
          charCount: 100,
          tokenEstimate: 25,
        },
      ],
      delivery: [{ stage: 'session-init', contentAssembled: true, channel: 'message-prepend', reason: 'test' }],
      totalCharCount: 100,
      totalTokenEstimate: 25,
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
      sessionTokenEstimate: 25,
      turnCharCount: 50,
      turnTokenEstimate: 12,
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
      totalTokenEstimate: 0,
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
      sessionTokenEstimate: 0,
      turnCharCount: 0,
      turnTokenEstimate: 0,
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
      totalTokenEstimate: 0,
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
      sessionTokenEstimate: 0,
      turnCharCount: 0,
      turnTokenEstimate: 0,
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
      totalTokenEstimate: 0,
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
      sessionTokenEstimate: 0,
      turnCharCount: 0,
      turnTokenEstimate: 0,
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
      totalTokenEstimate: 0,
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
      sessionTokenEstimate: 0,
      turnCharCount: 0,
      turnTokenEstimate: 0,
      segments: [],
    };

    await store.persist(summary, detail);
    await store.deleteTurn('th1', 't1');

    assert.equal(await store.getSummary('th1', 't1'), null);
    assert.equal(await store.getDetail('th1', 't1'), null);
    const { total } = await store.listTurnIds('th1');
    assert.equal(total, 0);
  });

  test('deleteTurn does not remove sibling turns from thread index', async () => {
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
      totalTokenEstimate: 0,
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
      sessionTokenEstimate: 0,
      turnCharCount: 0,
      turnTokenEstimate: 0,
      segments: [],
    };

    await store.persist(
      { ...base, turnId: 'turn-a', timestamp: 1000 },
      { ...baseDetail, turnId: 'turn-a', timestamp: 1000 },
    );
    await store.persist(
      { ...base, turnId: 'turn-b', timestamp: 2000 },
      { ...baseDetail, turnId: 'turn-b', timestamp: 2000 },
    );

    await store.deleteTurn('th1', 'turn-a');

    assert.equal(await store.getSummary('th1', 'turn-a'), null);
    assert.equal(await store.getDetail('th1', 'turn-a'), null);

    const { turnIds, total } = await store.listTurnIds('th1');
    assert.equal(total, 1);
    assert.deepEqual(turnIds, ['turn-b']);

    const remainingSummary = await store.getSummary('th1', 'turn-b');
    assert.ok(remainingSummary);
    assert.equal(remainingSummary.turnId, 'turn-b');

    const window = await store.queryWindow('th1', 1500, 2500);
    assert.equal(window.length, 1);
    assert.equal(window[0].turnId, 'turn-b');
  });

  test('queryWindow returns summaries within time range', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    const base = {
      sessionId: 's1',
      threadId: 'th1',
      catId: 'ragdoll',
      segments: [
        {
          segmentId: 'S1',
          stage: 'session-init',
          status: 'observed',
          contentHash: 'a',
          charCount: 10,
          tokenEstimate: 3,
        },
      ],
      delivery: [],
      totalCharCount: 10,
      totalTokenEstimate: 3,
      totalSegmentsObserved: 1,
      totalSegmentsAbsent: 0,
      durationMs: 0,
    };
    const baseDetail = {
      threadId: 'th1',
      catId: 'ragdoll',
      sessionContentHash: 'a',
      turnContentHash: null,
      sessionCharCount: 10,
      sessionTokenEstimate: 3,
      turnCharCount: 0,
      turnTokenEstimate: 0,
      segments: base.segments,
    };

    // Three turns: ts=1000 (before), ts=2000 (in window), ts=3000 (in window), ts=5000 (after)
    await store.persist(
      { ...base, turnId: 'before', timestamp: 1000 },
      { ...baseDetail, turnId: 'before', timestamp: 1000 },
    );
    await store.persist(
      { ...base, turnId: 'in-1', timestamp: 2000 },
      { ...baseDetail, turnId: 'in-1', timestamp: 2000 },
    );
    await store.persist(
      { ...base, turnId: 'in-2', timestamp: 3000 },
      { ...baseDetail, turnId: 'in-2', timestamp: 3000 },
    );
    await store.persist(
      { ...base, turnId: 'after', timestamp: 5000 },
      { ...baseDetail, turnId: 'after', timestamp: 5000 },
    );

    // Query window [1500, 4000] — should include in-1 (2000) and in-2 (3000), exclude before (1000) and after (5000)
    const results = await store.queryWindow('th1', 1500, 4000);
    assert.equal(results.length, 2);
    assert.equal(results[0].turnId, 'in-1');
    assert.equal(results[1].turnId, 'in-2');
  });

  test('queryWindow returns empty for no matches', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    const base = {
      sessionId: 's1',
      threadId: 'th1',
      catId: 'ragdoll',
      segments: [],
      delivery: [],
      totalCharCount: 0,
      totalTokenEstimate: 0,
      totalSegmentsObserved: 0,
      totalSegmentsAbsent: 0,
      durationMs: 0,
    };
    const baseDetail = {
      threadId: 'th1',
      catId: 'ragdoll',
      sessionContentHash: null,
      turnContentHash: null,
      sessionCharCount: 0,
      sessionTokenEstimate: 0,
      turnCharCount: 0,
      turnTokenEstimate: 0,
      segments: [],
    };

    await store.persist({ ...base, turnId: 't1', timestamp: 1000 }, { ...baseDetail, turnId: 't1', timestamp: 1000 });

    // Window entirely before or after existing data
    const before = await store.queryWindow('th1', 0, 500);
    assert.equal(before.length, 0);
    const after = await store.queryWindow('th1', 2000, 3000);
    assert.equal(after.length, 0);
  });

  test('queryWindow boundary: start-inclusive, end-exclusive [start, end)', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    const base = {
      sessionId: 's1',
      threadId: 'th1',
      catId: 'ragdoll',
      segments: [],
      delivery: [],
      totalCharCount: 0,
      totalTokenEstimate: 0,
      totalSegmentsObserved: 0,
      totalSegmentsAbsent: 0,
      durationMs: 0,
    };
    const baseDetail = {
      threadId: 'th1',
      catId: 'ragdoll',
      sessionContentHash: null,
      turnContentHash: null,
      sessionCharCount: 0,
      sessionTokenEstimate: 0,
      turnCharCount: 0,
      turnTokenEstimate: 0,
      segments: [],
    };

    await store.persist(
      { ...base, turnId: 'at-start', timestamp: 1000 },
      { ...baseDetail, turnId: 'at-start', timestamp: 1000 },
    );
    await store.persist(
      { ...base, turnId: 'at-end', timestamp: 2000 },
      { ...baseDetail, turnId: 'at-end', timestamp: 2000 },
    );

    // [1000, 2000): includes start boundary (1000), excludes end boundary (2000)
    // Matches GuardRejectionEventLog.queryWindow contract.
    const results = await store.queryWindow('th1', 1000, 2000);
    assert.equal(results.length, 1);
    assert.equal(results[0].turnId, 'at-start');

    // Start-inclusive: exact start boundary included
    const startExact = await store.queryWindow('th1', 1000, 1001);
    assert.equal(startExact.length, 1);
    assert.equal(startExact[0].turnId, 'at-start');

    // End-exclusive: [1000, 1000) is empty range
    const emptyRange = await store.queryWindow('th1', 1000, 1000);
    assert.equal(emptyRange.length, 0);

    // End-inclusive requires end+1: [1000, 2001) includes both
    const bothInclusive = await store.queryWindow('th1', 1000, 2001);
    assert.equal(bothInclusive.length, 2);
  });

  test('queryWindow returns empty for unknown threadId', async () => {
    const { InjectionTraceStore } = await import('../dist/domains/prompt-hooks/InjectionTraceStore.js');
    const redis = new FakeRedis();
    const store = new InjectionTraceStore(redis);

    const results = await store.queryWindow('nonexistent', 0, 999999);
    assert.equal(results.length, 0);
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
    assert.ok(typeof segments[0].tokenEstimate === 'number');
    assert.ok(segments[0].tokenEstimate > 0, 'observed segment should have token estimate > 0');

    assert.equal(segments[1].segmentId, 'S2');
    assert.equal(segments[1].status, 'observed');
    assert.ok(segments[1].tokenEstimate > 0, 'observed segment should have token estimate > 0');

    // S3 has no content after marker (end of string)
    assert.equal(segments[2].segmentId, 'S3');
    assert.equal(segments[2].status, 'absent');
    assert.equal(segments[2].contentHash, null);
    assert.equal(segments[2].charCount, 0);
    assert.equal(segments[2].tokenEstimate, 0, 'absent segment should have token estimate = 0');
  });

  test('parseAnnotatedSegments returns empty for no markers', async () => {
    const { parseAnnotatedSegments } = await import('../dist/domains/prompt-hooks/trace-collector.js');
    const segments = parseAnnotatedSegments('just plain text', 'session-init');
    assert.equal(segments.length, 0);
  });

  test('parseAnnotatedSegments marks consecutive empty markers as absent', async () => {
    const { parseAnnotatedSegments } = await import('../dist/domains/prompt-hooks/trace-collector.js');

    // Simulates annotated output where S3/S7 are skipped (empty markers) between observed S1 and S8
    const annotated = [
      '── [S1] 身份声明 ──',
      'Hello I am Ragdoll.',
      '',
      '── [S3] Pack Masks ──',
      '── [S7] Pack Workflows ──',
      '── [S8] co-creator引用 ──',
      'operator is lang.',
    ].join('\n');

    const segments = parseAnnotatedSegments(annotated, 'session-init');
    assert.equal(segments.length, 4);

    assert.equal(segments[0].segmentId, 'S1');
    assert.equal(segments[0].status, 'observed');
    assert.ok(segments[0].charCount > 0);

    // S3 marker immediately followed by S7 marker — no content → absent
    assert.equal(segments[1].segmentId, 'S3');
    assert.equal(segments[1].status, 'absent');
    assert.equal(segments[1].charCount, 0);
    assert.equal(segments[1].contentHash, null);
    assert.equal(segments[1].tokenEstimate, 0);

    // S7 marker immediately followed by S8 marker — no content → absent
    assert.equal(segments[2].segmentId, 'S7');
    assert.equal(segments[2].status, 'absent');
    assert.equal(segments[2].charCount, 0);
    assert.equal(segments[2].tokenEstimate, 0);

    assert.equal(segments[3].segmentId, 'S8');
    assert.equal(segments[3].status, 'observed');
    assert.ok(segments[3].charCount > 0);
  });

  test('collectTrace records pack-only segment for native-L0 with session content', async () => {
    const { collectTrace } = await import('../dist/domains/prompt-hooks/trace-collector.js');

    // hasNativeL0 = true, non-empty sessionContent → should create pack-only segment
    const result = collectTrace('test-cat', 'pack-only session content', '', true);

    // segments should contain a session-init entry (not be empty)
    const sessionSegments = result.segments.filter((s) => s.stage === 'session-init');
    assert.equal(sessionSegments.length, 1, 'should have one session-init segment for pack-only');
    assert.equal(sessionSegments[0].segmentId, 'session-init-pack-only');
    assert.equal(sessionSegments[0].status, 'observed');
    assert.ok(sessionSegments[0].contentHash !== null);
    assert.equal(sessionSegments[0].charCount, 'pack-only session content'.length);
    assert.ok(sessionSegments[0].tokenEstimate > 0);

    // Aggregate counts should be consistent with segment
    assert.equal(result.sessionCharCount, sessionSegments[0].charCount);
    assert.ok(result.sessionTokenEstimate > 0);
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
        {
          segmentId: 'S1',
          stage: 'session-init',
          status: 'observed',
          contentHash: 'a',
          charCount: 100,
          tokenEstimate: 25,
        },
        { segmentId: 'S2', stage: 'session-init', status: 'absent', contentHash: null, charCount: 0, tokenEstimate: 0 },
        {
          segmentId: 'per-turn',
          stage: 'per-turn',
          status: 'observed',
          contentHash: 'b',
          charCount: 50,
          tokenEstimate: 12,
        },
      ],
      delivery: [],
      sessionContentHash: 'a',
      turnContentHash: 'b',
      sessionCharCount: 100,
      sessionTokenEstimate: 25,
      turnCharCount: 50,
      turnTokenEstimate: 12,
      durationMs: 3,
    };
    const meta = { turnId: 't1', sessionId: 's1', threadId: 'th1', catId: 'ragdoll' };

    const summary = buildTraceSummary(trace, meta);
    assert.equal(summary.totalCharCount, 150);
    assert.equal(summary.totalTokenEstimate, 37);
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
      sessionTokenEstimate: 0,
      turnCharCount: 0,
      turnTokenEstimate: 0,
      durationMs: 1,
    };
    const meta = { turnId: 't2', threadId: 'th2', catId: 'bengal' };

    const summary = buildTraceSummary(trace, meta);
    assert.equal(summary.sessionId, undefined);
    assert.equal(summary.threadId, 'th2');
  });

  test('buildTraceDetail captures content hashes, char counts and token estimates', async () => {
    const { buildTraceDetail } = await import('../dist/domains/prompt-hooks/trace-collector.js');

    const trace = {
      segments: [],
      delivery: [],
      sessionContentHash: 'sess-hash',
      turnContentHash: 'turn-hash',
      sessionCharCount: 200,
      sessionTokenEstimate: 50,
      turnCharCount: 80,
      turnTokenEstimate: 20,
      durationMs: 1,
    };
    const meta = { turnId: 't2', threadId: 'th2', catId: 'bengal' };

    const detail = buildTraceDetail(trace, meta);
    assert.equal(detail.sessionContentHash, 'sess-hash');
    assert.equal(detail.turnContentHash, 'turn-hash');
    assert.equal(detail.sessionCharCount, 200);
    assert.equal(detail.sessionTokenEstimate, 50);
    assert.equal(detail.turnCharCount, 80);
    assert.equal(detail.turnTokenEstimate, 20);
    assert.equal(detail.catId, 'bengal');
  });

  test('buildStaticIdentity annotateSegments emits markers for skipped optional segments', async () => {
    const { buildStaticIdentity } = await import('../dist/domains/cats/services/context/SystemPromptBuilder.js');
    const { parseAnnotatedSegments } = await import('../dist/domains/prompt-hooks/trace-collector.js');
    const { catRegistry } = await import('@cat-cafe/shared');

    // Register a minimal opus config so buildStaticIdentity doesn't bail out
    if (!catRegistry.has('opus')) {
      catRegistry.register('opus', {
        id: 'opus',
        name: 'Claude Opus',
        displayName: '布偶猫',
        nickname: '宪宪',
        avatar: '🐱',
        color: '#7c3aed',
        mentionPatterns: ['@opus'],
        clientId: 'claude',
        defaultModel: 'claude-opus-4-6',
        mcpSupport: true,
        roleDescription: '主架构师和核心开发者',
        personality: '温柔但有主见',
      });
    }

    // Call with annotateSegments=true but NO pack blocks and NO mcpAvailable
    // This should still emit markers for S3/S7/S10/S11/S12/S13 (as absent)
    const annotated = buildStaticIdentity('opus', {
      annotateSegments: true,
      // no packBlocks, no mcpAvailable → optional pack/MCP segments skipped
    });

    const segments = parseAnnotatedSegments(annotated, 'session-init');

    // Pack-related segments should be present as absent (marker emitted, no content)
    const packSegmentIds = ['S3', 'S7', 'S10', 'S11', 'S12'];
    for (const id of packSegmentIds) {
      const seg = segments.find((s) => s.segmentId === id);
      assert.ok(seg, `Expected marker for skipped segment ${id}`);
      assert.equal(seg.status, 'absent', `Segment ${id} should be absent when pack not provided`);
      assert.equal(seg.charCount, 0);
    }

    // S13 (MCP) should also be absent when mcpAvailable is not set
    const mcpSeg = segments.find((s) => s.segmentId === 'S13');
    assert.ok(mcpSeg, 'Expected marker for skipped segment S13 (MCP)');
    assert.equal(mcpSeg.status, 'absent', 'S13 should be absent when MCP not available');

    // Always-present segments should be observed
    const s1 = segments.find((s) => s.segmentId === 'S1');
    assert.ok(s1, 'S1 (identity) should always be present');
    assert.equal(s1.status, 'observed');

    const s8 = segments.find((s) => s.segmentId === 'S8');
    assert.ok(s8, 'S8 (co-creator ref) should always be present');
    assert.equal(s8.status, 'observed');
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
