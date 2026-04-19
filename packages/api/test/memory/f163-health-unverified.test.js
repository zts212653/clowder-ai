/**
 * F163 Phase C P2-2 fix: health report must include `unverified` metric.
 * Reviewer @codex evidence: plan specified unverified count but implementation omits it.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { generateHealthReport } from '../../dist/domains/memory/f163-health-report.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

describe('F163 P2-2: health report unverified metric', () => {
  it('reports unverified count for non-observed docs without verified_at', () => {
    const db = new Database(':memory:');
    applyMigrations(db);

    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, authority, verified_at)
       VALUES ('LL-1', 'lesson', 'active', 'verified doc', '2026-01-01', 'validated', '2026-01-01')`,
    ).run();

    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, authority, verified_at)
       VALUES ('LL-2', 'lesson', 'active', 'unverified candidate', '2026-01-02', 'candidate', NULL)`,
    ).run();

    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, authority, verified_at)
       VALUES ('LL-3', 'decision', 'active', 'unverified validated', '2026-01-03', 'validated', NULL)`,
    ).run();

    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, authority)
       VALUES ('LL-4', 'lesson', 'active', 'observed doc', '2026-01-04', 'observed')`,
    ).run();

    const report = generateHealthReport(db, { now: '2026-04-16' });

    assert.ok('unverified' in report, 'report must include unverified metric');
    assert.equal(report.unverified, 2, 'LL-2 (candidate) + LL-3 (validated) should be unverified');
  });
});
