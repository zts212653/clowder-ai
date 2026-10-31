import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { computeLibraryHealth } from '../../dist/domains/memory/f188-library-health.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

function createTestDb() {
  const db = new Database(':memory:');
  applyMigrations(db);
  return db;
}

function tmpDocsRoot() {
  return mkdtempSync(join(tmpdir(), 'f188-'));
}

describe('F188 Phase B: computeLibraryHealth', () => {
  describe('staleAnchors', () => {
    it('detects anchors whose source files are missing', () => {
      const docsRoot = tmpDocsRoot();
      writeFileSync(join(docsRoot, 'existing.md'), '# exists');

      const db = createTestDb();
      const ins = db.prepare(
        `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, source_path)
         VALUES (?, ?, 'active', ?, '2026-01-01', ?)`,
      );
      ins.run('doc-1', 'feature', 'Existing Doc', 'existing.md');
      ins.run('doc-2', 'feature', 'Deleted Doc', 'deleted.md');

      const result = computeLibraryHealth(db, { docsRoot, markers: [] });
      assert.equal(result.staleAnchors.count, 1);
      assert.equal(result.staleAnchors.items[0].anchor, 'doc-2');
    });

    it('does not false-positive when source_path is relative to repoRoot (production layout)', () => {
      const repoRoot = tmpDocsRoot();
      mkdirSync(join(repoRoot, 'docs'), { recursive: true });
      writeFileSync(join(repoRoot, 'docs', 'guide.md'), '# guide');

      const db = createTestDb();
      db.prepare(
        `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, source_path)
         VALUES ('guide', 'feature', 'active', 'Guide', '2026-01-01', 'docs/guide.md')`,
      ).run();

      const result = computeLibraryHealth(db, { repoRoot, markers: [] });
      assert.equal(result.staleAnchors.count, 0, 'valid file should not be reported as stale');
    });

    it('does not false-positive when source_path is relative to docsRoot (CatCafeScanner layout)', () => {
      const repoRoot = tmpDocsRoot();
      const docsRoot = join(repoRoot, 'docs');
      mkdirSync(join(docsRoot, 'features'), { recursive: true });
      writeFileSync(join(docsRoot, 'features', 'F188.md'), '# F188');

      const db = createTestDb();
      db.prepare(
        `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, source_path)
         VALUES ('F188', 'feature', 'active', 'F188', '2026-01-01', 'features/F188.md')`,
      ).run();

      const result = computeLibraryHealth(db, { repoRoot, docsRoot, markers: [] });
      assert.equal(result.staleAnchors.count, 0, 'CatCafeScanner path should not be reported as stale');
    });

    it('excludes thread and session entries from stale check (non-file-backed)', () => {
      const db = createTestDb();
      db.prepare(
        `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, source_path)
         VALUES ('t1', 'thread', 'active', 'Thread Entry', '2026-01-01', 'threads/abc123')`,
      ).run();
      db.prepare(
        `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, source_path)
         VALUES ('s1', 'session', 'active', 'Session Entry', '2026-01-01', 'transcripts/threads/t1/cat1/sessions/s1')`,
      ).run();

      const result = computeLibraryHealth(db, { docsRoot: tmpDocsRoot(), markers: [] });
      assert.equal(result.staleAnchors.count, 0, 'thread/session entries should not be checked for staleness');
    });

    it('skips docs without source_path', () => {
      const db = createTestDb();
      db.prepare(
        `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at)
         VALUES ('no-path', 'thread', 'active', 'No Path', '2026-01-01')`,
      ).run();

      const result = computeLibraryHealth(db, { docsRoot: tmpDocsRoot(), markers: [] });
      assert.equal(result.staleAnchors.count, 0);
    });
  });

  describe('orphanEdges', () => {
    it('counts edges referencing non-existent anchors', () => {
      const db = createTestDb();
      db.prepare(
        `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at)
         VALUES ('A', 'feature', 'active', 'A', '2026-01-01')`,
      ).run();
      db.prepare("INSERT INTO edges (from_anchor, to_anchor, relation) VALUES ('A', 'GONE', 'related')").run();
      db.prepare("INSERT INTO edges (from_anchor, to_anchor, relation) VALUES ('A', 'A', 'self')").run();

      const result = computeLibraryHealth(db, { docsRoot: tmpDocsRoot(), markers: [] });
      assert.equal(result.orphanEdges.count, 1);
    });

    it('returns 0 when all edges are valid', () => {
      const db = createTestDb();
      db.prepare(
        `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at)
         VALUES ('X', 'feature', 'active', 'X', '2026-01-01')`,
      ).run();
      db.prepare(
        `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at)
         VALUES ('Y', 'feature', 'active', 'Y', '2026-01-01')`,
      ).run();
      db.prepare("INSERT INTO edges (from_anchor, to_anchor, relation) VALUES ('X', 'Y', 'related')").run();

      const result = computeLibraryHealth(db, { docsRoot: tmpDocsRoot(), markers: [] });
      assert.equal(result.orphanEdges.count, 0);
    });
  });

  describe('searchQuality', () => {
    it('counts zero-hit and low-hit searches', () => {
      const db = createTestDb();
      const ins = db.prepare(
        `INSERT INTO f163_logs (log_type, variant_id, effective_flags, payload, created_at)
         VALUES ('search', 'v1', '{}', ?, ?)`,
      );
      ins.run(JSON.stringify({ query: 'missing', resultCount: 0 }), '2026-05-01');
      ins.run(JSON.stringify({ query: 'low', resultCount: 1 }), '2026-05-02');
      ins.run(JSON.stringify({ query: 'good', resultCount: 10 }), '2026-05-03');

      const result = computeLibraryHealth(db, { docsRoot: tmpDocsRoot(), markers: [] });
      assert.equal(result.searchQuality.totalSearches, 3);
      assert.equal(result.searchQuality.zeroHitCount, 1);
      assert.equal(result.searchQuality.lowHitCount, 1);
      assert.equal(result.searchQuality.recentMisses.length, 1);
      assert.equal(result.searchQuality.recentMisses[0].query, 'missing');
      assert.equal(result.searchQuality.identifierProbeZeroHitCount, 0);
    });

    it('returns zeros when no search logs', () => {
      const db = createTestDb();
      const result = computeLibraryHealth(db, { docsRoot: tmpDocsRoot(), markers: [] });
      assert.equal(result.searchQuality.totalSearches, 0);
      assert.equal(result.searchQuality.zeroHitCount, 0);
      assert.equal(result.searchQuality.identifierProbeZeroHitCount, 0);
    });

    it('separates identifier probe zero-hits from content zero-hits', () => {
      const db = createTestDb();
      const ins = db.prepare(
        `INSERT INTO f163_logs (log_type, variant_id, effective_flags, payload, created_at)
         VALUES ('search', 'v1', '{}', ?, ?)`,
      );
      // Identifier probes — should NOT inflate zeroHitCount
      ins.run(JSON.stringify({ query: 'thread_mrhm42npxgkcsvco', resultCount: 0 }), '2026-07-15T01:00:00Z');
      ins.run(
        JSON.stringify({ query: '302ba2df-638d-4f1b-b6e6-5bdeda036c33', resultCount: 0 }),
        '2026-07-15T01:01:00Z',
      );
      ins.run(JSON.stringify({ query: '0001784067144578', resultCount: 0 }), '2026-07-15T01:02:00Z');
      ins.run(JSON.stringify({ query: '0001783500568565-000061-c5c6bc89', resultCount: 0 }), '2026-07-15T01:03:00Z');
      ins.run(
        JSON.stringify({ query: 'b6b556dd2a38f08e6698364a015d02957d85b79e', resultCount: 0 }),
        '2026-07-15T01:04:00Z',
      );
      ins.run(JSON.stringify({ query: '045c879ce', resultCount: 0 }), '2026-07-15T01:05:00Z');
      // Real content zero-hit — SHOULD count
      ins.run(JSON.stringify({ query: '图片是二进制文件 愿景守护', resultCount: 0 }), '2026-07-15T01:06:00Z');
      ins.run(JSON.stringify({ query: 'workspace-worktree-labels', resultCount: 0 }), '2026-07-15T01:07:00Z');
      // Non-zero results — neither bucket
      ins.run(JSON.stringify({ query: 'good search', resultCount: 5 }), '2026-07-15T01:08:00Z');

      const result = computeLibraryHealth(db, { docsRoot: tmpDocsRoot(), markers: [] });
      assert.equal(result.searchQuality.zeroHitCount, 2, 'only real content misses count');
      assert.equal(result.searchQuality.identifierProbeZeroHitCount, 6, 'identifier probes counted separately');
      assert.equal(result.searchQuality.observedSearches, 9);

      // recentMisses should contain ONLY content misses, NOT identifier probes
      // (ordered by created_at DESC — most recent first)
      assert.equal(result.searchQuality.recentMisses.length, 2, 'only content misses in recentMisses');
      assert.equal(result.searchQuality.recentMisses[0].query, 'workspace-worktree-labels');
      assert.equal(result.searchQuality.recentMisses[1].query, '图片是二进制文件 愿景守护');
    });

    it('does not misclassify mixed-content queries as identifier probes', () => {
      const db = createTestDb();
      const ins = db.prepare(
        `INSERT INTO f163_logs (log_type, variant_id, effective_flags, payload, created_at)
         VALUES ('search', 'v1', '{}', ?, ?)`,
      );
      // These contain identifiers but mixed with words — NOT identifier probes
      ins.run(
        JSON.stringify({ query: '045c879ce feat/workspace-worktree-labels', resultCount: 0 }),
        '2026-07-15T01:00:00Z',
      );
      ins.run(JSON.stringify({ query: 'F242 其他猫 真实调用', resultCount: 0 }), '2026-07-15T01:01:00Z');
      ins.run(
        JSON.stringify({ query: 'WORKTREE_PORT_OFFSET=-70 REDIS_URL=redis://localhost:6399', resultCount: 0 }),
        '2026-07-15T01:02:00Z',
      );

      const result = computeLibraryHealth(db, { docsRoot: tmpDocsRoot(), markers: [] });
      assert.equal(result.searchQuality.zeroHitCount, 3, 'mixed queries are content misses, not probes');
      assert.equal(result.searchQuality.identifierProbeZeroHitCount, 0);
    });

    it('many probes do not crowd content misses out of recentMisses (cap=10)', () => {
      const db = createTestDb();
      const ins = db.prepare(
        `INSERT INTO f163_logs (log_type, variant_id, effective_flags, payload, created_at)
         VALUES ('search', 'v1', '{}', ?, ?)`,
      );
      // Insert 15 probe zero-hits (would fill 10-slot cap if probes were included)
      for (let i = 0; i < 15; i++) {
        ins.run(
          JSON.stringify({ query: `thread_probe${String(i).padStart(10, '0')}`, resultCount: 0 }),
          `2026-07-15T00:${String(i).padStart(2, '0')}:00Z`,
        );
      }
      // Insert 3 content zero-hits after the probes
      ins.run(JSON.stringify({ query: 'real content miss A', resultCount: 0 }), '2026-07-15T00:20:00Z');
      ins.run(JSON.stringify({ query: 'real content miss B', resultCount: 0 }), '2026-07-15T00:21:00Z');
      ins.run(JSON.stringify({ query: 'real content miss C', resultCount: 0 }), '2026-07-15T00:22:00Z');

      const result = computeLibraryHealth(db, { docsRoot: tmpDocsRoot(), markers: [] });
      assert.equal(result.searchQuality.identifierProbeZeroHitCount, 15);
      assert.equal(result.searchQuality.zeroHitCount, 3, 'content misses counted correctly');
      // All 3 content misses should appear — probes must not consume any slots
      assert.equal(result.searchQuality.recentMisses.length, 3, 'all content misses visible despite 15 probes');
      assert.ok(
        result.searchQuality.recentMisses.every((m) => m.query.startsWith('real content miss')),
        'recentMisses contains only content misses',
      );
    });

    it('excludes eval/diagnostic origin searches from health metrics (F192 reprobe filter)', () => {
      const db = createTestDb();
      const insUser = db.prepare(
        `INSERT INTO f163_logs (log_type, variant_id, effective_flags, payload, created_at, origin)
         VALUES ('search', 'v1', '{}', ?, ?, 'user')`,
      );
      const insEval = db.prepare(
        `INSERT INTO f163_logs (log_type, variant_id, effective_flags, payload, created_at, origin)
         VALUES ('search', 'v1', '{}', ?, ?, 'eval')`,
      );
      // Real user searches
      insUser.run(JSON.stringify({ query: 'real search', resultCount: 5 }), '2026-07-20T01:00:00Z');
      insUser.run(JSON.stringify({ query: 'user zero hit', resultCount: 0 }), '2026-07-20T01:01:00Z');
      // Eval reprobe searches — should be excluded from health metrics
      insEval.run(JSON.stringify({ query: 'user zero hit', resultCount: 3 }), '2026-07-20T01:02:00Z');
      insEval.run(JSON.stringify({ query: 'thread_abc12345678', resultCount: 0 }), '2026-07-20T01:03:00Z');
      insEval.run(JSON.stringify({ query: 'another reprobe', resultCount: 0 }), '2026-07-20T01:04:00Z');
      // Default origin (NULL / legacy rows) should still be counted
      db.prepare(
        `INSERT INTO f163_logs (log_type, variant_id, effective_flags, payload, created_at)
         VALUES ('search', 'v1', '{}', ?, ?)`,
      ).run(JSON.stringify({ query: 'legacy search', resultCount: 2 }), '2026-07-20T01:05:00Z');

      const result = computeLibraryHealth(db, { docsRoot: tmpDocsRoot(), markers: [] });
      // Only user + legacy rows should be counted (3 total), not eval rows (3)
      assert.equal(result.searchQuality.totalSearches, 3, 'eval searches excluded from totalSearches');
      assert.equal(result.searchQuality.observedSearches, 3, 'eval searches excluded from observedSearches');
      assert.equal(result.searchQuality.zeroHitCount, 1, 'only user zero-hit counted');
      assert.equal(result.searchQuality.recentMisses.length, 1, 'eval zero-hits excluded from recentMisses');
      assert.equal(result.searchQuality.recentMisses[0].query, 'user zero hit');
    });
  });

  describe('replayDrift', () => {
    it('computes Jaccard drift for repeated queries', () => {
      const db = createTestDb();
      const ins = db.prepare(
        `INSERT INTO f163_logs (log_type, variant_id, effective_flags, payload, created_at)
         VALUES ('search', 'v1', '{}', ?, ?)`,
      );
      ins.run(
        JSON.stringify({ query: 'memory', topKPerCollection: { project: { anchors: ['A', 'B', 'C'] } } }),
        '2026-05-01',
      );
      ins.run(
        JSON.stringify({ query: 'memory', topKPerCollection: { project: { anchors: ['B', 'C', 'D'] } } }),
        '2026-05-02',
      );

      const result = computeLibraryHealth(db, { docsRoot: tmpDocsRoot(), markers: [] });
      assert.equal(result.replayDrift.available, true);
      assert.equal(result.replayDrift.sampleCount, 1);
      assert.equal(result.replayDrift.avgSimilarity, 0.5);
    });

    it('returns unavailable when no search logs', () => {
      const db = createTestDb();
      const result = computeLibraryHealth(db, { docsRoot: tmpDocsRoot(), markers: [] });
      assert.equal(result.replayDrift.available, false);
      assert.equal(result.replayDrift.avgSimilarity, null);
    });
  });

  describe('knowledgeFeed', () => {
    it('counts pending and needs_review markers', () => {
      const markers = [
        { id: '1', content: 'a', source: 'x', status: 'captured', createdAt: '' },
        { id: '2', content: 'b', source: 'x', status: 'needs_review', createdAt: '' },
        { id: '3', content: 'c', source: 'x', status: 'approved', createdAt: '' },
        { id: '4', content: 'd', source: 'x', status: 'normalized', createdAt: '' },
      ];

      const db = createTestDb();
      const result = computeLibraryHealth(db, { docsRoot: tmpDocsRoot(), markers });
      assert.equal(result.knowledgeFeed.pendingCount, 3);
      assert.equal(result.knowledgeFeed.needsReviewCount, 1);
    });

    it('returns zeros for empty markers', () => {
      const db = createTestDb();
      const result = computeLibraryHealth(db, { docsRoot: tmpDocsRoot(), markers: [] });
      assert.equal(result.knowledgeFeed.pendingCount, 0);
      assert.equal(result.knowledgeFeed.needsReviewCount, 0);
    });
  });

  describe('verificationDebt (AC-J8)', () => {
    it('counts needs_review and escalated docs', () => {
      const db = createTestDb();
      const ins = db.prepare(
        `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, review_status)
         VALUES (?, 'feature', 'active', ?, '2026-01-01', ?)`,
      );
      ins.run('nr1', 'nr1', 'needs_review');
      ins.run('nr2', 'nr2', 'needs_review');
      ins.run('esc', 'esc', 'escalated');
      ins.run('tl', 'tl', 'trusted_legacy');
      ins.run('rev', 'rev', 'reviewed');

      const result = computeLibraryHealth(db, { docsRoot: tmpDocsRoot(), markers: [] });
      assert.equal(result.verificationDebt.needsReviewCount, 2);
      assert.equal(result.verificationDebt.escalatedCount, 1);
      assert.equal(result.verificationDebt.trustedLegacyCount, 1);
    });

    it('returns zeros when no docs have review_status', () => {
      const db = createTestDb();
      const result = computeLibraryHealth(db, { docsRoot: tmpDocsRoot(), markers: [] });
      assert.equal(result.verificationDebt.needsReviewCount, 0);
      assert.equal(result.verificationDebt.escalatedCount, 0);
      assert.equal(result.verificationDebt.trustedLegacyCount, 0);
    });
  });
});

describe('review_status column (AC-J6 prerequisite)', () => {
  it('evidence_docs has review_status column', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    const info = db.prepare("PRAGMA table_info('evidence_docs')").all();
    const col = info.find((c) => c.name === 'review_status');
    assert.ok(col, 'review_status column should exist');
    assert.equal(col.type, 'TEXT');
  });

  it('review_status defaults to NULL for new rows', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at)
       VALUES ('test', 'feature', 'active', 'Test', '2026-01-01')`,
    ).run();
    const row = db.prepare('SELECT review_status FROM evidence_docs WHERE anchor = ?').get('test');
    assert.equal(row.review_status, null);
  });

  it('review_status accepts valid enum values', () => {
    const db = new Database(':memory:');
    applyMigrations(db);
    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, review_status)
       VALUES ('t1', 'feature', 'active', 'T1', '2026-01-01', 'trusted_legacy')`,
    ).run();
    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, review_status)
       VALUES ('t2', 'feature', 'active', 'T2', '2026-01-01', 'needs_review')`,
    ).run();
    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, review_status)
       VALUES ('t3', 'feature', 'active', 'T3', '2026-01-01', 'reviewed')`,
    ).run();
    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, review_status)
       VALUES ('t4', 'feature', 'active', 'T4', '2026-01-01', 'escalated')`,
    ).run();
    const rows = db.prepare('SELECT anchor, review_status FROM evidence_docs ORDER BY anchor').all();
    assert.equal(rows[0].review_status, 'trusted_legacy');
    assert.equal(rows[1].review_status, 'needs_review');
    assert.equal(rows[2].review_status, 'reviewed');
    assert.equal(rows[3].review_status, 'escalated');
  });
});
