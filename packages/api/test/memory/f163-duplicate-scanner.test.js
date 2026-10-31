/**
 * F163 Phase B Task 3: Duplicate scanner — TF-IDF similarity (AC-B1)
 * Scans evidence_docs, computes pairwise TF-IDF cosine similarity,
 * returns clusters of suspected duplicates above threshold.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { DuplicateScanner } from '../../dist/domains/memory/f163-duplicate-scanner.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

describe('F163 DuplicateScanner (AC-B1)', () => {
  /** Helper to seed docs into a fresh DB */
  function seedDb(docs) {
    const db = new Database(':memory:');
    applyMigrations(db);
    const stmt = db.prepare(
      'INSERT INTO evidence_docs (anchor, kind, status, title, summary, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    for (const d of docs) {
      stmt.run(d.anchor, d.kind ?? 'lesson', d.status ?? 'active', d.title, d.summary ?? '', '2026-04-16');
    }
    return db;
  }

  it('detects a cluster of 3 similar Redis docs', () => {
    const db = seedDb([
      {
        anchor: 'LL-001',
        title: 'Redis keyPrefix not applied to EVAL',
        summary: 'ioredis keyPrefix is ignored by EVAL/EVALSHA commands',
      },
      {
        anchor: 'LL-002',
        title: 'Redis keyPrefix behavior with EVAL',
        summary: 'keyPrefix does not apply when running EVAL scripts in Redis',
      },
      {
        anchor: 'LL-003',
        title: 'Redis EVAL ignores key prefix',
        summary: 'EVAL commands bypass ioredis keyPrefix configuration',
      },
      {
        anchor: 'LL-010',
        title: 'SQLite WAL mode benefits',
        summary: 'WAL mode improves concurrent read performance in SQLite',
      },
      {
        anchor: 'LL-011',
        title: 'Fastify route validation',
        summary: 'Using zod for request validation in Fastify routes',
      },
    ]);

    const scanner = new DuplicateScanner();
    const suggestions = scanner.scan(db, { threshold: 0.3 });

    // Should find at least one cluster containing the 3 Redis docs
    assert.ok(suggestions.length >= 1, `expected >=1 cluster, got ${suggestions.length}`);
    const redisCluster = suggestions.find(
      (s) => s.anchors.includes('LL-001') && s.anchors.includes('LL-002') && s.anchors.includes('LL-003'),
    );
    assert.ok(redisCluster, 'should find cluster of 3 Redis docs');
    assert.ok(redisCluster.similarity > 0.3, `similarity should be >0.3, got ${redisCluster.similarity}`);
    assert.ok(redisCluster.suggestedTitle.length > 0, 'suggestedTitle should be non-empty');

    // Unrelated docs should NOT be in the Redis cluster
    assert.ok(!redisCluster.anchors.includes('LL-010'));
    assert.ok(!redisCluster.anchors.includes('LL-011'));
  });

  it('returns empty when no docs exceed threshold', () => {
    const db = seedDb([
      { anchor: 'LL-100', title: 'SQLite WAL mode', summary: 'WAL mode for concurrent reads' },
      { anchor: 'LL-101', title: 'React hooks lifecycle', summary: 'useEffect cleanup patterns' },
      { anchor: 'LL-102', title: 'Git rebase workflow', summary: 'Interactive rebase for clean history' },
    ]);

    const scanner = new DuplicateScanner();
    const suggestions = scanner.scan(db, { threshold: 0.6 });
    assert.equal(suggestions.length, 0, 'no clusters expected for unrelated docs');
  });

  it('respects kind filter', () => {
    const db = seedDb([
      { anchor: 'LL-200', kind: 'lesson', title: 'Redis cache eviction', summary: 'LRU eviction policy' },
      { anchor: 'LL-201', kind: 'lesson', title: 'Redis cache eviction strategies', summary: 'LRU and LFU eviction' },
      { anchor: 'D-001', kind: 'decision', title: 'Redis cache eviction', summary: 'LRU eviction policy decision' },
    ]);

    const scanner = new DuplicateScanner();
    const suggestions = scanner.scan(db, { threshold: 0.3, kinds: ['lesson'] });

    // Should only cluster the two lessons, not the decision
    if (suggestions.length > 0) {
      for (const s of suggestions) {
        assert.ok(!s.anchors.includes('D-001'), 'decision should not be in lesson-only scan');
      }
    }
  });

  it('skips docs that are already summaries', () => {
    const db = seedDb([
      { anchor: 'LL-300', title: 'Redis keyPrefix', summary: 'keyPrefix behavior' },
      { anchor: 'LL-301', title: 'Redis keyPrefix docs', summary: 'keyPrefix documentation' },
    ]);
    // Mark LL-301 as a summary
    db.prepare("UPDATE evidence_docs SET summary_of_anchor = 'sg-001' WHERE anchor = 'LL-301'").run();

    const scanner = new DuplicateScanner();
    const suggestions = scanner.scan(db, { threshold: 0.2 });

    // LL-301 should be excluded from scanning
    for (const s of suggestions) {
      assert.ok(!s.anchors.includes('LL-301'), 'existing summaries should be excluded from scan');
    }
  });

  it('returns proper DuplicateSuggestion shape', () => {
    const db = seedDb([
      { anchor: 'LL-400', title: 'API rate limiting', summary: 'Rate limiting with Redis sliding window' },
      { anchor: 'LL-401', title: 'Rate limiting API endpoints', summary: 'Sliding window rate limiter with Redis' },
    ]);

    const scanner = new DuplicateScanner();
    const suggestions = scanner.scan(db, { threshold: 0.2 });

    if (suggestions.length > 0) {
      const s = suggestions[0];
      assert.ok(Array.isArray(s.anchors), 'anchors should be an array');
      assert.ok(typeof s.similarity === 'number', 'similarity should be a number');
      assert.ok(typeof s.suggestedTitle === 'string', 'suggestedTitle should be a string');
      assert.ok(s.anchors.length >= 2, 'cluster should have at least 2 docs');
    }
  });
});
