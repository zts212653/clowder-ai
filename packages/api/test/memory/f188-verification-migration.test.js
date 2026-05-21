import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import {
  applyVerificationMigration,
  dryRunVerificationMigration,
} from '../../dist/domains/memory/f188-verification-migration.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

function createTestDb() {
  const db = new Database(':memory:');
  applyMigrations(db);
  return db;
}

function insertDoc(db, anchor, kind, sourcePath, authority = 'validated') {
  db.prepare(
    `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, source_path, authority)
     VALUES (?, ?, 'active', ?, '2026-01-01', ?, ?)`,
  ).run(anchor, kind, anchor, sourcePath, authority);
}

describe('F188 Phase J: verification migration dry-run (AC-J6)', () => {
  it('marks lesson + lessons/ path as trusted_legacy', () => {
    const db = createTestDb();
    insertDoc(db, 'L1', 'lesson', 'docs/lessons/lesson-001.md');
    insertDoc(db, 'L2', 'lesson', 'lessons/lesson-002.md');

    const report = dryRunVerificationMigration(db);
    assert.equal(report.trustedLegacy, 2);
    const items = report.details.filter((d) => d.newStatus === 'trusted_legacy');
    assert.equal(items.length, 2);
  });

  it('marks feature + features/ path as trusted_legacy', () => {
    const db = createTestDb();
    insertDoc(db, 'F186', 'feature', 'docs/features/F186-library.md');
    insertDoc(db, 'F102', 'feature', 'features/F102-memory.md');

    const report = dryRunVerificationMigration(db);
    assert.equal(report.trustedLegacy, 2);
  });

  it('marks decision + decisions/ path as trusted_legacy', () => {
    const db = createTestDb();
    insertDoc(db, 'D1', 'decision', 'docs/decisions/ADR-001.md');
    insertDoc(db, 'D2', 'decision', 'decisions/ADR-002.md');

    const report = dryRunVerificationMigration(db);
    assert.equal(report.trustedLegacy, 2);
  });

  it('marks lesson from lessons-learned.md as trusted_legacy', () => {
    const db = createTestDb();
    insertDoc(db, 'LL', 'lesson', 'docs/lessons-learned.md');

    const report = dryRunVerificationMigration(db);
    assert.equal(report.trustedLegacy, 1);
  });

  it('marks plan + constitutional authority as needs_review (anomaly)', () => {
    const db = createTestDb();
    insertDoc(db, 'P1', 'plan', 'docs/plans/plan-001.md', 'constitutional');

    const report = dryRunVerificationMigration(db);
    assert.equal(report.needsReview, 1);
    const item = report.details.find((d) => d.anchor === 'P1');
    assert.equal(item.newStatus, 'needs_review');
  });

  it('marks collection-derived validated docs as needs_review', () => {
    const db = createTestDb();
    insertDoc(db, 'C1', 'feature', 'docs/random/file.md', 'validated');

    const report = dryRunVerificationMigration(db);
    const item = report.details.find((d) => d.anchor === 'C1');
    assert.equal(item.newStatus, 'needs_review');
  });

  it('leaves observed docs as NULL (untouched)', () => {
    const db = createTestDb();
    insertDoc(db, 'O1', 'thread', 'threads/abc', 'observed');

    const report = dryRunVerificationMigration(db);
    assert.equal(report.observedNull, 1);
    const item = report.details.find((d) => d.anchor === 'O1');
    assert.equal(item.newStatus, null);
  });

  it('leaves already-verified docs untouched', () => {
    const db = createTestDb();
    insertDoc(db, 'V1', 'feature', 'docs/features/F001.md');
    db.prepare(
      "UPDATE evidence_docs SET review_status = 'reviewed', verified_at = '2026-05-01' WHERE anchor = 'V1'",
    ).run();

    const report = dryRunVerificationMigration(db);
    assert.equal(report.alreadyVerified, 1);
  });

  it('does not overwrite escalated docs on re-run (idempotency)', () => {
    const db = createTestDb();
    insertDoc(db, 'E1', 'feature', 'docs/features/F001.md');
    db.prepare("UPDATE evidence_docs SET review_status = 'escalated' WHERE anchor = 'E1'").run();

    const report = dryRunVerificationMigration(db);
    const item = report.details.find((d) => d.anchor === 'E1');
    assert.equal(item.newStatus, null, 'escalated docs must not be re-triaged');
    assert.equal(report.alreadyVerified, 1);
  });

  it('does not overwrite trusted_legacy on re-run (idempotency)', () => {
    const db = createTestDb();
    insertDoc(db, 'T1', 'feature', 'docs/random/file.md');
    db.prepare("UPDATE evidence_docs SET review_status = 'trusted_legacy' WHERE anchor = 'T1'").run();

    const report = dryRunVerificationMigration(db);
    const item = report.details.find((d) => d.anchor === 'T1');
    assert.equal(item.newStatus, null, 'trusted_legacy docs must not be re-triaged');
  });

  it('does not overwrite needs_review on re-run (idempotency)', () => {
    const db = createTestDb();
    insertDoc(db, 'N1', 'feature', 'docs/random/file.md');
    db.prepare("UPDATE evidence_docs SET review_status = 'needs_review' WHERE anchor = 'N1'").run();

    const report = dryRunVerificationMigration(db);
    const item = report.details.find((d) => d.anchor === 'N1');
    assert.equal(item.newStatus, null, 'needs_review docs must not be re-triaged');
  });

  it('total = trustedLegacy + needsReview + observedNull + alreadyVerified', () => {
    const db = createTestDb();
    insertDoc(db, 'F1', 'feature', 'docs/features/F001.md');
    insertDoc(db, 'X1', 'feature', 'docs/random/file.md');
    insertDoc(db, 'O1', 'thread', 'threads/abc', 'observed');
    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, source_path, review_status, verified_at)
       VALUES ('V1', 'feature', 'active', 'V1', '2026-01-01', 'docs/features/F002.md', 'reviewed', '2026-05-01')`,
    ).run();

    const report = dryRunVerificationMigration(db);
    assert.equal(
      report.trustedLegacy + report.needsReview + report.observedNull + report.alreadyVerified,
      report.total,
    );
  });
});

describe('F188 Phase J: verification migration apply (AC-J6)', () => {
  it('sets review_status on docs matching whitelist', () => {
    const db = createTestDb();
    insertDoc(db, 'F1', 'feature', 'docs/features/F001.md');
    insertDoc(db, 'X1', 'feature', 'docs/random/file.md');
    insertDoc(db, 'O1', 'thread', 'threads/abc', 'observed');

    applyVerificationMigration(db);

    const f1 = db.prepare("SELECT review_status FROM evidence_docs WHERE anchor = 'F1'").get();
    assert.equal(f1.review_status, 'trusted_legacy');

    const x1 = db.prepare("SELECT review_status FROM evidence_docs WHERE anchor = 'X1'").get();
    assert.equal(x1.review_status, 'needs_review');

    const o1 = db.prepare("SELECT review_status FROM evidence_docs WHERE anchor = 'O1'").get();
    assert.equal(o1.review_status, null);
  });

  it('does not overwrite already-verified docs', () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, source_path, review_status, verified_at)
       VALUES ('V1', 'feature', 'active', 'V1', '2026-01-01', 'docs/features/F002.md', 'reviewed', '2026-05-01')`,
    ).run();

    applyVerificationMigration(db);

    const v1 = db.prepare("SELECT review_status, verified_at FROM evidence_docs WHERE anchor = 'V1'").get();
    assert.equal(v1.review_status, 'reviewed');
    assert.equal(v1.verified_at, '2026-05-01');
  });
});
