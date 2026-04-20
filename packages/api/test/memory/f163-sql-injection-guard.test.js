/**
 * F163 Phase C P2-1 fix: nowClause must use parameter binding, not string interpolation.
 * Reviewer @codex evidence: opts.now is interpolated directly into SQL template literal.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { generateHealthReport } from '../../dist/domains/memory/f163-health-report.js';
import { queryReviewQueue } from '../../dist/domains/memory/f163-review-queue.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

function setupDb() {
  const db = new Database(':memory:');
  applyMigrations(db);
  db.prepare(
    `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, verified_at, review_cycle_days)
     VALUES ('LL-SQL', 'lesson', 'active', 'test doc', '2026-01-01', '2026-01-01', 30)`,
  ).run();
  return db;
}

describe('F163 P2-1: SQL injection guard on nowClause', () => {
  it('queryReviewQueue rejects malicious now parameter', () => {
    const db = setupDb();
    assert.doesNotThrow(() => {
      queryReviewQueue(db, { now: "2026-04-16'); DROP TABLE evidence_docs; --" });
    });
    const count = db.prepare('SELECT COUNT(*) as c FROM evidence_docs').get().c;
    assert.equal(count, 1, 'table must survive injection attempt');
  });

  it('generateHealthReport rejects malicious now parameter', () => {
    const db = setupDb();
    assert.doesNotThrow(() => {
      generateHealthReport(db, { now: "2026-04-16'); DROP TABLE evidence_docs; --" });
    });
    const count = db.prepare('SELECT COUNT(*) as c FROM evidence_docs').get().c;
    assert.equal(count, 1, 'table must survive injection attempt');
  });

  it('queryReviewQueue works with valid ISO date via parameter binding', () => {
    const db = setupDb();
    const results = queryReviewQueue(db, { now: '2026-04-16' });
    assert.ok(Array.isArray(results));
    assert.ok(results.length >= 1, 'should find the stale doc');
    assert.equal(results[0].anchor, 'LL-SQL');
  });

  it('generateHealthReport works with valid ISO date via parameter binding', () => {
    const db = setupDb();
    const report = generateHealthReport(db, { now: '2026-04-16' });
    assert.equal(report.totalDocs, 1);
  });
});
