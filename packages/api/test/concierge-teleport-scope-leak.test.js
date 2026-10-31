/**
 * Regression test: F167→F245 teleport mismatch (BUG-UX-14)
 *
 * Root cause: `hydratePassageResults()` creates new EvidenceItems from DB
 * for passage matches that don't exist in the scoped baseResults. This
 * bypasses the scope filter — a passage from thread B mentioning topic X
 * gets a new item added for thread B, even though only thread A (about X)
 * was in the scoped results.
 *
 * The user sees concierge text about topic X with a teleport button that
 * navigates to thread B (where the cross-posted content lives) instead of
 * thread A (the actual topic thread).
 *
 * Fix: when a scope filter is active (not 'all'), hydratePassageResults
 * must NOT create new items — only enhance existing baseResult items with
 * passage-level data (messageId for peek).
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

// Disable F200 consumption rerank which incidentally masks the scope leak
// by removing passage-only items as a side effect. We need to test the scope
// filter itself, not the reranker.
process.env.F200_CONSUMPTION_RERANK = 'off';

describe('BUG-UX-14: concierge teleport scope leak', () => {
  let store;

  beforeEach(async () => {
    const { SqliteEvidenceStore } = await import('../dist/domains/memory/SqliteEvidenceStore.js');
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
  });

  /**
   * Set up two thread docs + passages via direct SQL:
   *   - thread A: "F167 Harness Fix" (about F167)
   *   - thread B: "F245 Friction Signal Eval" (about F245, but has a passage mentioning F167)
   *
   * Passages are inserted via IndexBuilder in production; tests use
   * direct SQL since IndexBuilder has complex dependencies.
   */
  async function seedCrossThreadScenario() {
    await store.upsert([
      {
        anchor: 'thread-thread_f167abc',
        kind: 'thread',
        status: 'active',
        title: 'F167 Harness Fix: 守门 thread 边界 trigger-time enforcement',
        summary: 'Discussion about F167 harness fix for thread boundary enforcement',
        updatedAt: '2026-06-25T10:00:00Z',
      },
    ]);

    await store.upsert([
      {
        anchor: 'thread-thread_f245xyz',
        kind: 'thread',
        status: 'active',
        title: 'F245 Friction Signal Eval — 摩擦信号统一聚合',
        summary: 'Friction signal evaluation and unified aggregation',
        updatedAt: '2026-06-26T10:00:00Z',
      },
    ]);

    const db = store.db;

    // Passage in thread A about F167 (expected match — enhances existing result)
    db.prepare(
      `INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'thread-thread_f167abc',
      'p_f167_msg1',
      'F167 harness fix: hold_ball trigger-time enforcement must verify thread boundary',
      'opus',
      0,
      '2026-06-25T10:01:00Z',
    );

    // Passage in thread B that cross-references F167 content.
    // This is the problematic passage — it mentions "F167 harness fix"
    // but lives in F245's thread.
    db.prepare(
      `INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'thread-thread_f245xyz',
      'p_f245_crossref',
      'Cross-post from F167: the harness fix trigger-time enforcement affects friction signals too',
      'sonnet',
      0,
      '2026-06-26T10:01:00Z',
    );
  }

  it('scoped search with depth=raw must not add items from passage-only matches', async () => {
    await seedCrossThreadScenario();

    const results = await store.search('F167 harness fix', {
      scope: 'threads',
      depth: 'raw',
      limit: 10,
    });

    // Thread A (F167) must be in results — it's the primary match
    const f167Result = results.find((r) => r.anchor === 'thread-thread_f167abc');
    assert.ok(f167Result, 'Thread A (F167) must be in results');

    // Thread B (F245) must NOT be in results — it was only found via passage cross-reference.
    const f245Result = results.find((r) => r.anchor === 'thread-thread_f245xyz');
    assert.strictEqual(
      f245Result,
      undefined,
      'Thread B (F245) must NOT leak into scoped results via passage-only match. ' +
        'This is the F167→F245 teleport mismatch bug: card shows F167 content but navigates to F245.',
    );
  });

  it('thread A passages should still be enriched (message-level precision preserved)', async () => {
    await seedCrossThreadScenario();

    const results = await store.search('F167 harness fix', {
      scope: 'threads',
      depth: 'raw',
      limit: 10,
    });

    const f167Result = results.find((r) => r.anchor === 'thread-thread_f167abc');
    assert.ok(f167Result, 'Thread A (F167) must be in results');
    assert.ok(
      f167Result.passages && f167Result.passages.length > 0,
      'Thread A should have passages attached for message-level precision',
    );
  });

  it('unscoped search still allows passage hydration of new items', async () => {
    await seedCrossThreadScenario();

    const results = await store.search('F167 harness fix', {
      depth: 'raw',
      limit: 10,
    });

    const f167Result = results.find((r) => r.anchor === 'thread-thread_f167abc');
    assert.ok(f167Result, 'Thread A (F167) should be in unscoped results');

    // Thread B should appear via passage match — acceptable for unscoped search
    const f245Result = results.find((r) => r.anchor === 'thread-thread_f245xyz');
    assert.ok(f245Result, 'Thread B (F245) should appear in unscoped results via passage hydration');
  });

  it('scope=sessions also prevents passage scope leak', async () => {
    // Thread and session share the same protection mechanism
    await store.upsert([
      {
        anchor: 'session-sess_target',
        kind: 'session',
        status: 'active',
        title: 'Session about Redis patterns',
        summary: 'Discussion about Redis patterns and keyPrefix behavior',
        updatedAt: '2026-06-25T10:00:00Z',
      },
    ]);

    await store.upsert([
      {
        anchor: 'thread-thread_unrelated',
        kind: 'thread',
        status: 'active',
        title: 'Thread about deployment',
        summary: 'Deployment discussion unrelated to Redis',
        updatedAt: '2026-06-26T10:00:00Z',
      },
    ]);

    const db = store.db;
    db.prepare(
      `INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('session-sess_target', 'p_sess_1', 'Redis keyPrefix behavior with ioredis', null, 0, '2026-06-25T10:01:00Z');

    db.prepare(
      `INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'thread-thread_unrelated',
      'p_thread_crossref',
      'Mentioned Redis keyPrefix issue from last session',
      null,
      0,
      '2026-06-26T10:01:00Z',
    );

    const results = await store.search('Redis keyPrefix', {
      scope: 'sessions',
      depth: 'raw',
      limit: 10,
    });

    // Unrelated thread must not leak into session-scoped results
    const leaked = results.find((r) => r.anchor === 'thread-thread_unrelated');
    assert.strictEqual(leaked, undefined, 'Thread must not leak into session-scoped results');
  });

  it('passage-only match in wrong-kind doc blocked even when no doc-level results (cloud P1)', async () => {
    // Cloud reviewer P1 (R3): When scope='threads' has no doc-level hits,
    // the hasDocLevelResults guard is skipped, but a passage in a SESSION doc
    // should still be blocked — its kind doesn't match the scope.
    await store.upsert([
      {
        anchor: 'session-sess_wrong_kind',
        kind: 'session',
        status: 'active',
        title: 'Session about general topics',
        summary: 'Broad session discussion',
        updatedAt: '2026-06-26T10:00:00Z',
      },
    ]);

    const db = store.db;

    // Passage in a SESSION doc with unique query terms
    db.prepare(
      `INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'session-sess_wrong_kind',
      'p_wrong_kind_1',
      'The quasicrystalline lattice enumeration algorithm converged in 3 iterations',
      'opus',
      0,
      '2026-06-26T10:01:00Z',
    );

    const results = await store.search('quasicrystalline lattice enumeration', {
      scope: 'threads',
      depth: 'raw',
      limit: 10,
    });

    // Even though no doc-level FTS matches exist (hasDocLevelResults=false),
    // the session doc must NOT leak into thread-scoped results — its kind
    // doesn't match the scope. This is the same class of scope leak as the
    // original teleport mismatch bug.
    const leaked = results.find((r) => r.anchor === 'session-sess_wrong_kind');
    assert.strictEqual(
      leaked,
      undefined,
      'Session doc must not leak into thread-scoped results via passage-only match, ' +
        'even when no doc-level FTS results exist (cloud P1 on BUG-UX-14 R3).',
    );
  });

  it('passage-only thread match surfaces when no doc-level FTS matches exist', async () => {
    // Reviewer P1 scenario: a thread whose title/summary don't contain the query,
    // but a passage does. When NO doc-level FTS matches exist, this should still
    // surface — passage-only matches are the primary discovery channel here.
    await store.upsert([
      {
        anchor: 'thread-thread_hidden_gem',
        kind: 'thread',
        status: 'active',
        title: 'General Architecture Discussion',
        summary: 'Broad discussion about system design patterns',
        updatedAt: '2026-06-25T10:00:00Z',
      },
    ]);

    const db = store.db;

    // Passage contains unique query terms not in any doc title/summary
    db.prepare(
      `INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'thread-thread_hidden_gem',
      'p_hidden_msg1',
      'The zygomorphic bloom filter optimization reduced false positive rate by 40%',
      'opus',
      0,
      '2026-06-25T10:01:00Z',
    );

    const results = await store.search('zygomorphic bloom filter', {
      scope: 'threads',
      depth: 'raw',
      limit: 10,
    });

    // No doc title/summary mentions "zygomorphic bloom filter", so doc-level FTS
    // returns 0 results. The passage-only match must surface — blocking it would
    // silently drop legitimate content that is only discoverable via messages.
    const found = results.find((r) => r.anchor === 'thread-thread_hidden_gem');
    assert.ok(
      found,
      'Thread with passage-only match must surface when no doc-level FTS matches exist. ' +
        'Blocking this is a recall regression (reviewer P1 on BUG-UX-14).',
    );
  });
});
