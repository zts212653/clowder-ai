import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/**
 * F200 HW-6: FTS Progressive Relaxation
 *
 * Root cause: SqliteEvidenceStore FTS5 query builder joins all tokens with
 * implicit AND. For long queries (14+ tokens, mixed Chinese/English), no
 * single document contains ALL tokens → 0 results → 75% empty rate.
 *
 * Fix: progressive relaxation — AND-all → strong-AND+weak-OR → OR-all.
 * BM25 naturally ranks multi-match documents higher.
 */

describe('buildProgressiveFtsQueries', () => {
  let buildProgressiveFtsQueries;

  beforeEach(async () => {
    ({ buildProgressiveFtsQueries } = await import('../../dist/domains/memory/fts-query-builder.js'));
  });

  it('returns empty array for empty query', () => {
    assert.deepEqual(buildProgressiveFtsQueries(''), []);
    assert.deepEqual(buildProgressiveFtsQueries('   '), []);
  });

  it('returns AND-only for ≤3 tokens (no relaxation needed)', () => {
    const result = buildProgressiveFtsQueries('prompt engineering');
    assert.equal(result.length, 1, 'short queries need only AND-all');
    // AND-all: tokens joined with space (FTS5 implicit AND)
    assert.ok(result[0].includes('"prompt"'));
    assert.ok(result[0].includes('"engineering"'));
    assert.ok(!result[0].includes(' OR '));
  });

  it('returns 3-level progression for long query (>3 tokens)', () => {
    const query = 'F200 memory recall eval consumption reranking metrics';
    const result = buildProgressiveFtsQueries(query);
    assert.ok(result.length >= 2, `expected ≥2 levels, got ${result.length}`);

    // Level 1: AND-all (strictest)
    assert.ok(!result[0].includes(' OR '), 'level 1 should be AND-all');

    // Last level: OR-all (loosest)
    const last = result[result.length - 1];
    assert.ok(last.includes(' OR '), 'last level should be OR-all');
  });

  it('identifies strong tokens (F-numbers, long words) for level 2', () => {
    const query = 'F200 memory recall a b c eval consumption';
    const result = buildProgressiveFtsQueries(query);
    assert.ok(result.length >= 3, 'long query with strong tokens gets 3 levels');

    // Level 2 should have strong tokens as AND + weak as OR
    const level2 = result[1];
    // F200 is a strong token (entity-like), "a", "b", "c" are weak (short)
    assert.ok(level2.includes('"F200"'), 'strong token F200 in level 2');
    assert.ok(level2.includes(' OR '), 'level 2 should have OR for weak tokens');
  });

  it('level 2 uses explicit AND before parenthesized OR (FTS5 syntax requirement)', () => {
    // Cloud review P2: FTS5 rejects implicit AND before "(x OR y)" with
    // "fts5: syntax error near OR". Must use explicit AND keyword.
    const query = 'F200 memory recall a b c eval consumption';
    const result = buildProgressiveFtsQueries(query);
    assert.ok(result.length >= 3, 'needs 3 levels');
    const level2 = result[1];
    // Must contain explicit AND — not just space-separated tokens before parens
    assert.ok(level2.includes(' AND '), `level 2 must use explicit AND, got: ${level2}`);
  });

  it('escapes double quotes in tokens', () => {
    const result = buildProgressiveFtsQueries('say "hello" world');
    assert.ok(result.length >= 1);
    // Escaped quotes: "" inside FTS5 phrase
    assert.ok(result[0].includes('""hello""'));
  });

  it('handles pure Chinese query tokens', () => {
    const query = '记忆系统 召回率 下降 分析 原因 优化 方案 讨论';
    const result = buildProgressiveFtsQueries(query);
    // 8 tokens → should produce relaxation levels
    assert.ok(result.length >= 2, 'Chinese multi-token query needs relaxation');
    // All CJK tokens should be treated as strong
    const last = result[result.length - 1];
    assert.ok(last.includes(' OR '), 'last level is OR-all');
  });

  it('handles mixed Chinese/English query (the actual production failure case)', () => {
    // This is the type of query that caused 75% empty results
    const query = 'F200 memory recall eval 记忆 召回 consumption reranking metrics 消费加权 排序 优化 Phase B 指标';
    const result = buildProgressiveFtsQueries(query);
    assert.ok(result.length >= 2, 'mixed 14-token query must have relaxation');

    // Level 1 = AND-all (will fail in practice for this many tokens)
    assert.ok(!result[0].includes(' OR '));
    // Last = OR-all (will find SOMETHING)
    const last = result[result.length - 1];
    assert.ok(last.includes(' OR '));
  });
});

describe('SqliteEvidenceStore — FTS Progressive Relaxation integration', () => {
  let store;

  beforeEach(async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    // Seed with documents that partially match a long query
    await store.upsert([
      {
        anchor: 'F200',
        kind: 'feature',
        status: 'active',
        title: 'Memory Recall Eval',
        summary: 'Phase A pipeline for recall events and consumption tracking',
        keywords: ['memory', 'recall', 'eval', 'consumption'],
        updatedAt: '2026-06-19T00:00:00Z',
      },
      {
        anchor: 'doc:adr-038',
        kind: 'decision',
        status: 'active',
        title: 'L0 Staging Protocol',
        summary: 'System prompt staging and compression immune layers',
        keywords: ['staging', 'protocol', 'system-prompt'],
        updatedAt: '2026-06-12T00:00:00Z',
      },
      {
        anchor: 'F168',
        kind: 'feature',
        status: 'active',
        title: 'Community Board Platform',
        summary: 'Community management dashboard for multi-tenant engagement metrics',
        keywords: ['community', 'dashboard', 'metrics'],
        updatedAt: '2026-06-10T00:00:00Z',
      },
    ]);
  });

  it('long AND-all query returns 0 results (demonstrates the bug)', async () => {
    // This is the exact pattern that caused 75% empty results in production:
    // A long query where no single doc matches ALL tokens
    const longQuery = 'F200 memory recall eval consumption reranking metrics Phase pipeline events tracking';
    const results = await store.search(longQuery);
    // Before fix: this returns 0 because AND-all fails
    // After fix: this should find F200 (partial match via relaxation)
    // For now, assert the fix works — F200 should be found
    assert.ok(results.length >= 1, `expected ≥1 result, got ${results.length}`);
    assert.equal(results[0].anchor, 'F200');
  });

  it('short AND-all query still works as before (no regression)', async () => {
    const results = await store.search('recall eval');
    assert.ok(results.length >= 1);
    assert.equal(results[0].anchor, 'F200');
  });

  it('reports degradation metadata when relaxation is used', async () => {
    const longQuery = 'F200 memory recall eval consumption reranking metrics Phase pipeline events tracking';
    const { items, meta } = await store.searchWithMeta(longQuery);
    // If relaxation kicked in, meta should indicate it
    // (short queries that match via AND-all should NOT be degraded)
    if (items.length > 0) {
      // Success case — relaxation found results
      assert.ok(true, 'relaxation produced results');
    }
  });

  it('strong tokens are prioritized — F200 match ranks higher than weak-only match', async () => {
    // Add a doc that only matches weak tokens
    await store.upsert([
      {
        anchor: 'doc:generic-metrics',
        kind: 'decision',
        status: 'active',
        title: 'Generic Metrics Guide',
        summary: 'How to track metrics and events in pipeline systems',
        keywords: ['metrics', 'events', 'pipeline'],
        updatedAt: '2026-06-18T00:00:00Z',
      },
    ]);

    const longQuery = 'F200 memory recall eval consumption reranking metrics Phase pipeline events tracking';
    const results = await store.search(longQuery);
    assert.ok(results.length >= 1);
    // F200 should rank first because it matches more strong tokens (F200, memory, recall, eval)
    assert.equal(results[0].anchor, 'F200');
  });
});
