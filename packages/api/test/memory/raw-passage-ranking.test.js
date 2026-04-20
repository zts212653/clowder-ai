/**
 * depth=raw passage ranking regression test
 *
 * Bug: when depth=raw and limit is small, results without passages
 * can crowd out results WITH passages because doc-level BM25 hits
 * come first in the array and slice(0, limit) truncates the rest.
 * The passage-bearing doc gets synthesized and appended to the END
 * of the results array, then cut by slice.
 *
 * Fix: raw mode must prioritize results that have passage matches.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

describe('depth=raw passage ranking', () => {
  let store;

  beforeEach(async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    // Seed 3 thread docs: aaa and bbb match "redis" at doc level,
    // ccc does NOT match "redis" at doc level (title/summary say "config")
    await store.upsert([
      {
        anchor: 'thread-aaa',
        kind: 'thread',
        status: 'active',
        title: 'Redis config discussion',
        summary: 'Redis port 6399 vs 6398 discussion about redis settings',
        updatedAt: '2026-04-01T00:00:00Z',
      },
      {
        anchor: 'thread-bbb',
        kind: 'thread',
        status: 'active',
        title: 'Redis pitfall thread',
        summary: 'Redis keyPrefix gotcha with redis eval',
        updatedAt: '2026-04-02T00:00:00Z',
      },
      {
        anchor: 'thread-ccc',
        kind: 'thread',
        status: 'active',
        title: 'Infrastructure planning',
        summary: 'Cache layer design for session storage',
        updatedAt: '2026-04-03T00:00:00Z',
      },
    ]);

    // Only thread-ccc gets passages that match "redis" (passage-only hit)
    const db = store.getDb();
    const stmt = db.prepare(
      'INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    stmt.run(
      'thread-ccc',
      'msg-001',
      'The redis keyPrefix does not apply to eval scripts',
      'opus',
      0,
      '2026-04-03T10:00:00Z',
    );
    stmt.run(
      'thread-ccc',
      'msg-002',
      'We hit the redis WRONGTYPE error in production',
      'user',
      1,
      '2026-04-03T10:01:00Z',
    );
  });

  it('passage-only hit ranks before doc-only hits when depth=raw (limit=1)', async () => {
    const results = await store.search('redis', { depth: 'raw', limit: 1 });
    assert.equal(results.length, 1);
    assert.ok(results[0].passages?.length > 0, 'top-1 must be the passage-bearing result, got: ' + results[0].anchor);
  });

  it('passage-only hit ranks before doc-only hits when depth=raw (limit=2)', async () => {
    const results = await store.search('redis', { depth: 'raw', limit: 2 });
    assert.equal(results.length, 2);
    const first = results[0];
    assert.ok(first.passages?.length > 0, 'first result must have passages, got: ' + first.anchor);
  });

  it('all results returned when limit >= total matches', async () => {
    const results = await store.search('redis', { depth: 'raw', limit: 10 });
    assert.ok(results.length >= 3, 'should return all matching docs + passage-synthesized');
    const withPassages = results.filter((r) => r.passages?.length > 0);
    assert.ok(withPassages.length >= 1, 'at least one result must have passages');
  });

  it('preserves passage rank field for downstream sorting', async () => {
    const passages = store.searchPassages('redis', 5);
    assert.ok(passages.length > 0, 'should find passage matches');
    assert.ok(passages[0].rank != null, 'passage should carry BM25 rank');
    assert.ok(typeof passages[0].rank === 'number', 'rank must be a number');
  });
});
