/**
 * F257 Phase D — SegmentJudgmentCache unit tests.
 *
 * Red tests for review findings:
 *   P1-2: Cache drops segmentVersion from SegmentJudgment
 *   P2-3: No direct tests existed
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

// ── FakeRedis with HASH + pipeline support ──────────────────

class FakeRedis {
  constructor() {
    this.hashes = new Map(); // key → Map<field, value>
    this.zsets = new Map(); // key → [{score, member}]
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

  async zadd(key, score, member) {
    const z = this.zsets.get(key) ?? [];
    z.push({ score, member });
    z.sort((a, b) => a.score - b.score || a.member.localeCompare(b.member));
    this.zsets.set(key, z);
    return 1;
  }

  async zrangebyscore(key, min, max, ...args) {
    const z = this.zsets.get(key) ?? [];
    const minN = min === '-inf' ? -Infinity : Number(min);
    const maxN = max === '+inf' ? Infinity : Number(max);
    let filtered = z.filter((e) => e.score >= minN && e.score <= maxN);
    if (args[0] === 'LIMIT') {
      const offset = Number(args[1]);
      const count = Number(args[2]);
      filtered = filtered.slice(offset, offset + count);
    }
    return filtered.map((e) => e.member);
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
            const val = await self.hget(op.key, op.field);
            results.push([null, val]);
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
}

// ── Minimal SegmentJudgment shape (matching segment-judgment-engine) ──

function makeJudgment(partial) {
  return {
    judgmentId: `j-${Math.random().toString(36).slice(2, 8)}`,
    segmentId: 'S1',
    segmentVersion: null,
    window: { startMs: 0, endMs: 1000 },
    verdict: 'alive',
    evidence: {
      injectionCount: { value: 10, how_counted: 'fired-count' },
      violationCount: { value: 0, how_counted: 'event-log' },
      denominatorKind: 'fired-count',
      eventRefs: [],
      correlationConfidence: 'window',
    },
    pressure: { observabilityDeadline: null, nextRequiredAction: null },
    producedBy: { domainId: 'eval:harness-ledger', runId: 'run1', evalCat: 'cat1' },
    ...partial,
  };
}

describe('SegmentJudgmentCache', () => {
  /** @type {import('../dist/domains/prompt-hooks/SegmentJudgmentCache.js').SegmentJudgmentCache} */
  let cache;
  let redis;

  test('setup: import and create cache', async () => {
    const mod = await import('../dist/domains/prompt-hooks/SegmentJudgmentCache.js');
    redis = new FakeRedis();
    cache = new mod.SegmentJudgmentCache(redis);
    assert.ok(cache);
  });

  // ── Basic CRUD ───────────────────────────────────────────────

  test('get returns null for unknown segment', async () => {
    const result = await cache.get('unknown');
    assert.equal(result, null);
  });

  test('updateBatch stores and retrieves judgment', async () => {
    await cache.updateBatch([makeJudgment({ segmentId: 'S1', verdict: 'alive' })]);
    const cached = await cache.get('S1');
    assert.ok(cached);
    assert.equal(cached.segmentId, 'S1');
    assert.equal(cached.verdict, 'alive');
    assert.equal(cached.injectionCount, 10);
    assert.equal(cached.violationCount, 0);
  });

  test('updateBatch overwrites previous entry', async () => {
    await cache.updateBatch([makeJudgment({ segmentId: 'S1', verdict: 'alive' })]);
    await cache.updateBatch([makeJudgment({ segmentId: 'S1', verdict: 'dormant' })]);
    const cached = await cache.get('S1');
    assert.equal(cached.verdict, 'dormant');
  });

  test('updateBatch with empty array is a no-op', async () => {
    await cache.updateBatch([]); // should not throw
  });

  // ── P1-2: segmentVersion preservation ────────────────────────

  test('segmentVersion is preserved in cache (not dropped)', async () => {
    await cache.updateBatch([makeJudgment({ segmentId: 'S2', segmentVersion: 1, verdict: 'alive' })]);
    const cached = await cache.get('S2');
    assert.ok(cached, 'cached entry should exist');
    assert.equal(cached.segmentVersion, 1, 'segmentVersion must be preserved, not dropped');
  });

  test('segmentVersion=null is preserved (not silently dropped)', async () => {
    await cache.updateBatch([makeJudgment({ segmentId: 'S3', segmentVersion: null, verdict: 'dormant' })]);
    const cached = await cache.get('S3');
    assert.ok(cached);
    assert.equal(cached.segmentVersion, null, 'null segmentVersion should be preserved');
  });

  // ── Batch read ───────────────────────────────────────────────

  test('getBatch returns multiple cached entries', async () => {
    redis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/SegmentJudgmentCache.js');
    cache = new mod.SegmentJudgmentCache(redis);

    await cache.updateBatch([
      makeJudgment({ segmentId: 'A', verdict: 'alive', segmentVersion: 1 }),
      makeJudgment({ segmentId: 'B', verdict: 'dormant', segmentVersion: 2 }),
    ]);

    const batch = await cache.getBatch(['A', 'B', 'missing']);
    assert.equal(batch.size, 2);
    assert.equal(batch.get('A')?.verdict, 'alive');
    assert.equal(batch.get('B')?.verdict, 'dormant');
    assert.equal(batch.has('missing'), false);
  });

  test('getBatch with empty array returns empty map', async () => {
    const batch = await cache.getBatch([]);
    assert.equal(batch.size, 0);
  });

  // ── P1-2: judgment history ──────────────────────────────────

  test('updateBatch appends to history, getHistory returns all in time order', async () => {
    redis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/SegmentJudgmentCache.js');
    cache = new mod.SegmentJudgmentCache(redis);

    // Two separate eval runs for the same segment
    await cache.updateBatch([
      makeJudgment({ segmentId: 'H1', verdict: 'dormant', window: { startMs: 0, endMs: 100 } }),
    ]);
    await cache.updateBatch([
      makeJudgment({ segmentId: 'H1', verdict: 'alive', window: { startMs: 100, endMs: 200 } }),
    ]);

    const history = await cache.getHistory('H1');
    assert.equal(history.length, 2, 'should have 2 history entries');
    assert.equal(history[0].verdict, 'dormant', 'first entry (oldest) is dormant');
    assert.equal(history[0].evaluatedAt, 100);
    assert.equal(history[1].verdict, 'alive', 'second entry (latest) is alive');
    assert.equal(history[1].evaluatedAt, 200);
  });

  test('getHistory returns empty for unknown segment', async () => {
    const history = await cache.getHistory('nonexistent');
    assert.equal(history.length, 0);
  });

  // ── 判据②: eval window + denominatorKind provenance (F257 #6 slice 6c) ──

  test("round-trip preserves the judgment's OWN eval window [startMs,endMs)", async () => {
    redis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/SegmentJudgmentCache.js');
    cache = new mod.SegmentJudgmentCache(redis);

    await cache.updateBatch([
      makeJudgment({ segmentId: 'W1', verdict: 'alive', window: { startMs: 5000, endMs: 9000 } }),
    ]);
    const cached = await cache.get('W1');
    assert.ok(cached);
    assert.deepEqual(cached.window, { startMs: 5000, endMs: 9000 }, 'eval window must survive the round-trip');
    assert.equal(cached.evaluatedAt, 9000, 'evaluatedAt stays = window.endMs (not a window substitute)');
  });

  test('round-trip preserves denominatorKind', async () => {
    redis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/SegmentJudgmentCache.js');
    cache = new mod.SegmentJudgmentCache(redis);

    await cache.updateBatch([makeJudgment({ segmentId: 'W2', verdict: 'alive' })]);
    const cached = await cache.get('W2');
    assert.equal(cached.denominatorKind, 'fired-count');
  });

  test('history entries carry window + denominatorKind per version', async () => {
    redis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/SegmentJudgmentCache.js');
    cache = new mod.SegmentJudgmentCache(redis);

    await cache.updateBatch([
      makeJudgment({ segmentId: 'W3', verdict: 'dormant', window: { startMs: 0, endMs: 100 } }),
    ]);
    await cache.updateBatch([
      makeJudgment({ segmentId: 'W3', verdict: 'alive', window: { startMs: 100, endMs: 200 } }),
    ]);
    const history = await cache.getHistory('W3');
    assert.equal(history.length, 2);
    assert.deepEqual(history[0].window, { startMs: 0, endMs: 100 });
    assert.deepEqual(history[1].window, { startMs: 100, endMs: 200 });
    assert.equal(history[0].denominatorKind, 'fired-count');
  });

  test('legacy entry without window/denominatorKind reads back as explicit null (fail-visible, not guessed)', async () => {
    redis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/SegmentJudgmentCache.js');
    cache = new mod.SegmentJudgmentCache(redis);

    // Simulate a pre-6c Redis JSON: no window, no denominatorKind.
    const legacy = {
      segmentId: 'L1',
      verdict: 'alive',
      injectionCount: 3,
      violationCount: 0,
      correlationConfidence: 'window',
      evaluatedAt: 7000,
      runId: 'run-legacy',
      segmentVersion: 1,
    };
    await redis.hset('segment-judgment-latest', 'L1', JSON.stringify(legacy));
    await redis.zadd('segment-judgment-history:L1', 7000, JSON.stringify(legacy));

    const cached = await cache.get('L1');
    assert.ok(cached);
    assert.equal(cached.window, null, 'legacy window must be explicit null — never derived from evaluatedAt');
    assert.equal(cached.denominatorKind, null, 'legacy denominatorKind must be explicit null');

    const history = await cache.getHistory('L1');
    assert.equal(history[0].window, null);
    assert.equal(history[0].denominatorKind, null);
  });

  // ── 判据② P2-1 (sol R1): malformed-PRESENT provenance fields fail closed ──
  // Missing fields are legacy (→ null). Present-but-malformed fields are
  // forgery-grade input — the read boundary must NOT pass them to the UI
  // (Invalid Date ~ Invalid Date, bogus denominator text).

  async function freshCache() {
    redis = new FakeRedis();
    const mod = await import('../dist/domains/prompt-hooks/SegmentJudgmentCache.js');
    cache = new mod.SegmentJudgmentCache(redis);
    return cache;
  }

  function validEntry(overrides = {}) {
    return {
      segmentId: 'M1',
      verdict: 'alive',
      injectionCount: 3,
      violationCount: 0,
      correlationConfidence: 'window',
      evaluatedAt: 7000,
      runId: 'run-m',
      segmentVersion: 1,
      window: { startMs: 6000, endMs: 7000 },
      denominatorKind: 'fired-count',
      ...overrides,
    };
  }

  test('malformed window (string) normalizes to null, rest of entry survives', async () => {
    const c = await freshCache();
    await redis.hset('segment-judgment-latest', 'M1', JSON.stringify(validEntry({ window: 'bad' })));
    const cached = await c.get('M1');
    assert.ok(cached, 'entry itself must survive — only the forged field is dropped');
    assert.equal(cached.window, null);
    assert.equal(cached.denominatorKind, 'fired-count');
  });

  test('malformed window (empty object / reversed range / array) normalizes to null', async () => {
    const c = await freshCache();
    await redis.hset('segment-judgment-latest', 'E1', JSON.stringify(validEntry({ segmentId: 'E1', window: {} })));
    await redis.hset(
      'segment-judgment-latest',
      'E2',
      JSON.stringify(validEntry({ segmentId: 'E2', window: { startMs: 9000, endMs: 1000 } })),
    );
    await redis.hset('segment-judgment-latest', 'E3', JSON.stringify(validEntry({ segmentId: 'E3', window: [1, 2] })));
    assert.equal((await c.get('E1')).window, null, 'empty object is not a window');
    assert.equal((await c.get('E2')).window, null, 'startMs > endMs is not a legal [start,end) order');
    assert.equal((await c.get('E3')).window, null, 'array is not a window record');
  });

  test('zero-length window (startMs === endMs) normalizes to null (sol R4 P2-1)', async () => {
    const c = await freshCache();
    // judgment-schema-v1 defines a [start,end) sampling window — an empty
    // interval has no sampleable instant, and canonical selectors/adapters
    // uniformly reject windowEndMs <= windowStartMs. The cache read boundary
    // must fail closed the same way instead of rendering `t ~ t` as a
    // trusted coordinate.
    await redis.hset(
      'segment-judgment-latest',
      'Z1',
      JSON.stringify(validEntry({ segmentId: 'Z1', window: { startMs: 7000, endMs: 7000 } })),
    );
    const cached = await c.get('Z1');
    assert.ok(cached, 'entry itself must survive — only the forged field is dropped');
    assert.equal(cached.window, null, 'zero-length [t,t) window is malformed, not a legal coordinate');
    assert.equal(cached.denominatorKind, 'fired-count');

    await redis.zadd(
      'segment-judgment-history:Z1',
      7000,
      JSON.stringify(validEntry({ segmentId: 'Z1', window: { startMs: 7000, endMs: 7000 } })),
    );
    const history = await c.getHistory('Z1');
    assert.equal(history[0].window, null, 'history seam applies the same interval invariant');
  });

  test('malformed denominatorKind (number / unknown string) normalizes to null', async () => {
    const c = await freshCache();
    await redis.hset(
      'segment-judgment-latest',
      'D1',
      JSON.stringify(validEntry({ segmentId: 'D1', denominatorKind: 7 })),
    );
    await redis.hset(
      'segment-judgment-latest',
      'D2',
      JSON.stringify(validEntry({ segmentId: 'D2', denominatorKind: 'typed-fact' })),
    );
    assert.equal((await c.get('D1')).denominatorKind, null, 'non-string denominator must not reach the UI');
    assert.equal((await c.get('D2')).denominatorKind, null, 'off-domain denominator must not reach the UI');
  });

  test('gap kind distinguishes legacy-missing from invalid-present (sol R5 P2)', async () => {
    const c = await freshCache();
    // legacy: fields absent entirely
    const legacy = validEntry({ segmentId: 'G1' });
    delete legacy.window;
    delete legacy.denominatorKind;
    await redis.hset('segment-judgment-latest', 'G1', JSON.stringify(legacy));
    // forged: fields present but malformed
    await redis.hset(
      'segment-judgment-latest',
      'G2',
      JSON.stringify(validEntry({ segmentId: 'G2', window: { startMs: 7000, endMs: 7000 }, denominatorKind: 'bogus' })),
    );
    // valid: fields present and well-formed
    await redis.hset('segment-judgment-latest', 'G3', JSON.stringify(validEntry({ segmentId: 'G3' })));

    const g1 = await c.get('G1');
    assert.equal(g1.window, null);
    assert.equal(g1.windowGap, 'legacy-missing', 'absent fields are a legacy gap');
    assert.equal(g1.denominatorGap, 'legacy-missing');

    const g2 = await c.get('G2');
    assert.equal(g2.window, null);
    assert.equal(g2.windowGap, 'invalid-present', 'corrupted provenance is NOT a legacy gap');
    assert.equal(g2.denominatorKind, null);
    assert.equal(g2.denominatorGap, 'invalid-present');

    const g3 = await c.get('G3');
    assert.deepEqual(g3.window, { startMs: 6000, endMs: 7000 });
    assert.equal(g3.windowGap, null, 'well-formed provenance has no gap');
    assert.equal(g3.denominatorGap, null);
  });

  // ── P2 (sol R6): presence matrix — absent vs explicit-null vs valid vs invalid ──
  // `raw == null` cannot distinguish a field that is ABSENT (legacy pre-6c
  // entry) from a field that is PRESENT with value null. The producer never
  // writes null, so present-null is malformed-present → 'invalid-present',
  // never 'legacy-missing'. Classification must be by own-property presence.

  test('presence matrix: explicit-null → invalid-present (not legacy-missing) across get/getBatch/getHistory', async () => {
    const c = await freshCache();
    // absent: pre-6c legacy entry (keys missing entirely)
    const absent = validEntry({ segmentId: 'P-absent' });
    delete absent.window;
    delete absent.denominatorKind;
    // explicit-null: corrupted entry — producer never writes null
    const explicitNull = validEntry({ segmentId: 'P-null', window: null, denominatorKind: null });
    // valid: well-formed producer write
    const valid = validEntry({ segmentId: 'P-valid' });
    // invalid non-null: forged values
    const invalid = validEntry({
      segmentId: 'P-invalid',
      window: { startMs: 7000, endMs: 7000 },
      denominatorKind: 'bogus',
    });

    for (const entry of [absent, explicitNull, valid, invalid]) {
      await redis.hset('segment-judgment-latest', entry.segmentId, JSON.stringify(entry));
      await redis.zadd(`segment-judgment-history:${entry.segmentId}`, 7000, JSON.stringify(entry));
    }

    const expectGaps = (label, j, windowGap, denominatorGap) => {
      assert.ok(j, `${label}: entry must survive`);
      assert.equal(j.windowGap, windowGap, `${label}: windowGap`);
      assert.equal(j.denominatorGap, denominatorGap, `${label}: denominatorGap`);
    };

    // get seam
    expectGaps('get/absent', await c.get('P-absent'), 'legacy-missing', 'legacy-missing');
    expectGaps('get/explicit-null', await c.get('P-null'), 'invalid-present', 'invalid-present');
    expectGaps('get/valid', await c.get('P-valid'), null, null);
    expectGaps('get/invalid', await c.get('P-invalid'), 'invalid-present', 'invalid-present');

    // getBatch seam
    const batch = await c.getBatch(['P-absent', 'P-null', 'P-valid', 'P-invalid']);
    expectGaps('getBatch/absent', batch.get('P-absent'), 'legacy-missing', 'legacy-missing');
    expectGaps('getBatch/explicit-null', batch.get('P-null'), 'invalid-present', 'invalid-present');
    expectGaps('getBatch/valid', batch.get('P-valid'), null, null);
    expectGaps('getBatch/invalid', batch.get('P-invalid'), 'invalid-present', 'invalid-present');

    // getHistory seam
    expectGaps('getHistory/absent', (await c.getHistory('P-absent'))[0], 'legacy-missing', 'legacy-missing');
    expectGaps('getHistory/explicit-null', (await c.getHistory('P-null'))[0], 'invalid-present', 'invalid-present');
    expectGaps('getHistory/valid', (await c.getHistory('P-valid'))[0], null, null);
    expectGaps('getHistory/invalid', (await c.getHistory('P-invalid'))[0], 'invalid-present', 'invalid-present');
  });

  test('non-record raw (JSON array) is rejected entirely across get/getBatch/getHistory', async () => {
    const c = await freshCache();
    await redis.hset('segment-judgment-latest', 'A1', JSON.stringify([]));
    await redis.zadd('segment-judgment-history:A1', 7000, JSON.stringify([]));
    assert.equal(await c.get('A1'), null, 'array raw must not be cast into a CachedJudgment');
    const batch = await c.getBatch(['A1']);
    assert.equal(batch.has('A1'), false);
    assert.equal((await c.getHistory('A1')).length, 0);
  });

  test('getBatch + getHistory apply the same fail-closed normalization per entry', async () => {
    const c = await freshCache();
    await redis.hset('segment-judgment-latest', 'B1', JSON.stringify(validEntry({ segmentId: 'B1', window: {} })));
    await redis.hset('segment-judgment-latest', 'B2', JSON.stringify(validEntry({ segmentId: 'B2' })));
    const batch = await c.getBatch(['B1', 'B2']);
    assert.equal(batch.get('B1').window, null);
    assert.deepEqual(batch.get('B2').window, { startMs: 6000, endMs: 7000 });

    await redis.zadd(
      'segment-judgment-history:B1',
      7000,
      JSON.stringify(validEntry({ segmentId: 'B1', denominatorKind: 'bogus' })),
    );
    const history = await c.getHistory('B1');
    assert.equal(history.length, 1);
    assert.equal(history[0].denominatorKind, null);
  });
});
