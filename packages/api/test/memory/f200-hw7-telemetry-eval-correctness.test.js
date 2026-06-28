import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/**
 * F200 HW-7: Telemetry 三态校准 + Eval Correctness
 *
 * Three fixes in one PR:
 * 1. Telemetry 三态: result_count=NULL must not be counted as zero-hit
 *    (NULL = not-written by telemetry pipeline, not "true zero results")
 * 2. Shadow baseline: on-mode shadow stores pre-rerank BM25 order
 *    (was storing post-rerank = shadow ≡ live by construction)
 * 3. Adapter: search_zero_hit_rate as primary recall signal,
 *    result_count=NULL excluded from zero-hit computation
 */

// --- Part 1: Telemetry 三態校准 (result_count NULL handling) ---

describe('HW-7 Part 1: result_count NULL 三態校准', () => {
  let Database, db;

  beforeEach(async () => {
    Database = (await import('better-sqlite3')).default;
    const schema = await import('../../dist/domains/memory/schema.js');

    db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(schema.SCHEMA_V1);
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(1, new Date().toISOString());
    schema.applyMigrations(db);
  });

  function insertF163Log(query, resultCount) {
    const payload = JSON.stringify({ query, resultCount });
    db.prepare(
      "INSERT INTO f163_logs (log_type, variant_id, effective_flags, payload, created_at) VALUES ('search', 'default', '{}', ?, datetime('now'))",
    ).run(payload);
  }

  it('result_count=NULL must NOT be counted as zero-hit (three-state: true-zero / not-written / parser-miss)', async () => {
    // Seed: 2 true-zero (resultCount=0), 3 not-written (resultCount absent/null), 1 normal (resultCount=5)
    insertF163Log('query-zero-1', 0);
    insertF163Log('query-zero-2', 0);
    insertF163Log('query-null-1', undefined); // telemetry pipeline didn't write
    insertF163Log('query-null-2', null); // explicitly null
    insertF163Log('query-null-3', undefined);
    insertF163Log('query-normal', 5);

    const { computeLibraryHealth } = await import('../../dist/domains/memory/f188-library-health.js');
    const health = computeLibraryHealth(db, { markers: [] });

    // Before fix: zeroHitCount = 5 (2 true-zero + 3 null-as-zero)
    // After fix:  zeroHitCount = 2 (only true-zero; NULL excluded)
    assert.equal(
      health.searchQuality.zeroHitCount,
      2,
      'only true-zero (resultCount=0) should count as zero-hit; NULL/undefined = not-written, excluded',
    );
  });

  it('result_count=0 is true-zero and SHOULD be counted as zero-hit', async () => {
    insertF163Log('query-zero', 0);
    insertF163Log('query-normal', 3);

    const { computeLibraryHealth } = await import('../../dist/domains/memory/f188-library-health.js');
    const health = computeLibraryHealth(db, { markers: [] });

    assert.equal(health.searchQuality.zeroHitCount, 1, 'true-zero (resultCount=0) is a real zero-hit');
    assert.equal(health.searchQuality.totalSearches, 2);
  });

  it('Cloud-P1: observedSearches excludes NULL rows for accurate rate denominator', async () => {
    // 2 true-zero + 3 not-written (null/undefined) + 1 normal = 6 total rows
    // observedSearches should be 3 (only rows with explicit numeric resultCount)
    insertF163Log('query-zero-1', 0);
    insertF163Log('query-zero-2', 0);
    insertF163Log('query-null-1', undefined);
    insertF163Log('query-null-2', null);
    insertF163Log('query-null-3', undefined);
    insertF163Log('query-normal', 5);

    const { computeLibraryHealth } = await import('../../dist/domains/memory/f188-library-health.js');
    const health = computeLibraryHealth(db, { markers: [] });

    assert.equal(health.searchQuality.totalSearches, 6, 'totalSearches counts all rows');
    assert.equal(
      health.searchQuality.observedSearches,
      3,
      'observedSearches = rows with explicit numeric resultCount (0+0+5), not NULL/undefined',
    );
  });
});

// --- Part 3: Adapter zero-hit-rate as primary recall signal ---

describe('HW-7 Part 3: eval-memory-adapter search_zero_hit_rate priority', () => {
  it('recallMetricRefs includes search_zero_hit_rate as a recall-level signal', async () => {
    const { recallMetricRefs } = await import('../../dist/infrastructure/harness-eval/eval-memory-adapter.js');
    assert.ok(recallMetricRefs, 'recallMetricRefs should be exported');
    const refs = recallMetricRefs();
    assert.ok(
      refs.includes('search_zero_hit_rate'),
      `recallMetricRefs should include search_zero_hit_rate as a primary recall signal, got: ${refs.join(', ')}`,
    );
    // It should be listed BEFORE grep_fallback_rate to signal priority
    const zhrIdx = refs.indexOf('search_zero_hit_rate');
    const gfrIdx = refs.indexOf('grep_fallback_rate');
    assert.ok(
      zhrIdx < gfrIdx,
      `search_zero_hit_rate (idx=${zhrIdx}) should precede grep_fallback_rate (idx=${gfrIdx}) in priority order`,
    );
  });
});
