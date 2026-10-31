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
  it('counts needs_review + escalated as unverified (Phase J governance)', () => {
    const db = new Database(':memory:');
    applyMigrations(db);

    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, authority, review_status)
       VALUES ('R1', 'feature', 'active', 'needs review', '2026-01-01', 'validated', 'needs_review')`,
    ).run();

    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, authority, review_status)
       VALUES ('R2', 'decision', 'active', 'escalated', '2026-01-02', 'constitutional', 'escalated')`,
    ).run();

    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, authority, review_status)
       VALUES ('R3', 'feature', 'active', 'trusted legacy', '2026-01-03', 'validated', 'trusted_legacy')`,
    ).run();

    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, authority, review_status)
       VALUES ('R4', 'feature', 'active', 'reviewed', '2026-01-04', 'validated', 'reviewed')`,
    ).run();

    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, authority)
       VALUES ('R5', 'lesson', 'active', 'observed', '2026-01-05', 'observed')`,
    ).run();

    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, authority)
       VALUES ('R6', 'feature', 'active', 'null status', '2026-01-06', 'candidate')`,
    ).run();

    const report = generateHealthReport(db, { now: '2026-04-16' });

    assert.ok('unverified' in report, 'report must include unverified metric');
    assert.equal(
      report.unverified,
      3,
      'needs_review (R1) + escalated (R2) + candidate NULL (R6); observed (R5) excluded from fallback',
    );
  });

  it('pre-migration fallback: NULL review_status + NULL verified_at counts as unverified', () => {
    const db = new Database(':memory:');
    applyMigrations(db);

    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, authority)
       VALUES ('PRE1', 'feature', 'active', 'unmigrated doc', '2026-01-01', 'candidate')`,
    ).run();

    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, authority, verified_at)
       VALUES ('PRE2', 'feature', 'active', 'verified but unmigrated', '2026-01-02', 'validated', '2026-01-10')`,
    ).run();

    const report = generateHealthReport(db, { now: '2026-04-16' });
    assert.equal(
      report.unverified,
      1,
      'only PRE1 (NULL review_status + NULL verified_at) counts; PRE2 has verified_at',
    );
  });

  it('observed authority excluded from pre-migration fallback', () => {
    const db = new Database(':memory:');
    applyMigrations(db);

    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, authority)
       VALUES ('OBS1', 'feature', 'active', 'observed doc', '2026-01-01', 'observed')`,
    ).run();

    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, authority)
       VALUES ('CAN1', 'feature', 'active', 'candidate doc', '2026-01-02', 'candidate')`,
    ).run();

    const report = generateHealthReport(db, { now: '2026-04-16' });
    assert.equal(report.unverified, 1, 'only CAN1 counts; OBS1 (observed) excluded from fallback');
  });
});
