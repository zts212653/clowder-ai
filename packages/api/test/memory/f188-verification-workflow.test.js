import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { executeVerificationAction } from '../../dist/domains/memory/f188-verification-workflow.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

function createTestDb() {
  const db = new Database(':memory:');
  applyMigrations(db);
  return db;
}

function insertDoc(db, anchor, reviewStatus = null) {
  db.prepare(
    `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, review_status)
     VALUES (?, 'feature', 'active', ?, '2026-01-01', ?)`,
  ).run(anchor, anchor, reviewStatus);
}

describe('F188 Phase J: verification workflow (AC-J7)', () => {
  it('confirm: needs_review → reviewed + verified_at set', () => {
    const db = createTestDb();
    insertDoc(db, 'A', 'needs_review');

    const result = executeVerificationAction(db, { anchor: 'A', action: 'confirm', actor: 'opus-46' });
    assert.equal(result.ok, true);

    const row = db.prepare('SELECT review_status, verified_at FROM evidence_docs WHERE anchor = ?').get('A');
    assert.equal(row.review_status, 'reviewed');
    assert.ok(row.verified_at, 'verified_at should be set');
  });

  it('mark_stale from needs_review → needs_review + verified_at NULL', () => {
    const db = createTestDb();
    insertDoc(db, 'A', 'needs_review');
    db.prepare("UPDATE evidence_docs SET verified_at = '2026-01-01' WHERE anchor = 'A'").run();

    const result = executeVerificationAction(db, { anchor: 'A', action: 'mark_stale', actor: 'opus-46' });
    assert.equal(result.ok, true);

    const row = db.prepare('SELECT review_status, verified_at FROM evidence_docs WHERE anchor = ?').get('A');
    assert.equal(row.review_status, 'needs_review');
    assert.equal(row.verified_at, null);
  });

  it('mark_stale from trusted_legacy → needs_review + verified_at NULL', () => {
    const db = createTestDb();
    insertDoc(db, 'A', 'trusted_legacy');

    const result = executeVerificationAction(db, { anchor: 'A', action: 'mark_stale', actor: 'opus-46' });
    assert.equal(result.ok, true);

    const row = db.prepare('SELECT review_status, verified_at FROM evidence_docs WHERE anchor = ?').get('A');
    assert.equal(row.review_status, 'needs_review');
    assert.equal(row.verified_at, null);
  });

  it('mark_stale from reviewed → needs_review (re-opens confirmed doc)', () => {
    const db = createTestDb();
    insertDoc(db, 'A', 'reviewed');
    db.prepare("UPDATE evidence_docs SET verified_at = '2026-03-01' WHERE anchor = 'A'").run();

    const result = executeVerificationAction(db, { anchor: 'A', action: 'mark_stale', actor: 'opus-46' });
    assert.equal(result.ok, true);

    const row = db.prepare('SELECT review_status, verified_at FROM evidence_docs WHERE anchor = ?').get('A');
    assert.equal(row.review_status, 'needs_review');
    assert.equal(row.verified_at, null);
  });

  it('escalate from needs_review → escalated', () => {
    const db = createTestDb();
    insertDoc(db, 'A', 'needs_review');

    const result = executeVerificationAction(db, { anchor: 'A', action: 'escalate', actor: 'opus-46' });
    assert.equal(result.ok, true);

    const row = db.prepare('SELECT review_status FROM evidence_docs WHERE anchor = ?').get('A');
    assert.equal(row.review_status, 'escalated');
  });

  it('escalate from trusted_legacy → escalated', () => {
    const db = createTestDb();
    insertDoc(db, 'A', 'trusted_legacy');

    const result = executeVerificationAction(db, { anchor: 'A', action: 'escalate', actor: 'opus-46' });
    assert.equal(result.ok, true);

    const row = db.prepare('SELECT review_status FROM evidence_docs WHERE anchor = ?').get('A');
    assert.equal(row.review_status, 'escalated');
  });

  it('dismiss_review from needs_review → dismissed', () => {
    const db = createTestDb();
    insertDoc(db, 'A', 'needs_review');

    const result = executeVerificationAction(db, { anchor: 'A', action: 'dismiss_review', actor: 'opus-46' });
    assert.equal(result.ok, true);

    const row = db.prepare('SELECT review_status FROM evidence_docs WHERE anchor = ?').get('A');
    assert.equal(row.review_status, 'dismissed');
  });

  it('mark_stale from dismissed → needs_review (re-opens dismissed doc)', () => {
    const db = createTestDb();
    insertDoc(db, 'A', 'needs_review');

    executeVerificationAction(db, { anchor: 'A', action: 'dismiss_review', actor: 'opus-46' });
    const dismissed = db.prepare('SELECT review_status FROM evidence_docs WHERE anchor = ?').get('A');
    assert.equal(dismissed.review_status, 'dismissed');

    const result = executeVerificationAction(db, { anchor: 'A', action: 'mark_stale', actor: 'opus-46' });
    assert.equal(result.ok, true);

    const row = db.prepare('SELECT review_status, verified_at FROM evidence_docs WHERE anchor = ?').get('A');
    assert.equal(row.review_status, 'needs_review');
    assert.equal(row.verified_at, null);
  });

  it('confirm from NULL rejects (invalid precondition)', () => {
    const db = createTestDb();
    insertDoc(db, 'A', null);

    const result = executeVerificationAction(db, { anchor: 'A', action: 'confirm', actor: 'opus-46' });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('precondition'));
  });

  it('writes audit log for each action', () => {
    const db = createTestDb();
    insertDoc(db, 'A', 'needs_review');

    executeVerificationAction(db, { anchor: 'A', action: 'confirm', actor: 'opus-46' });

    const log = db
      .prepare("SELECT * FROM f163_logs WHERE log_type = 'verification_action' ORDER BY created_at DESC LIMIT 1")
      .get();
    assert.ok(log, 'audit log should exist');
    const payload = JSON.parse(log.payload);
    assert.equal(payload.anchor, 'A');
    assert.equal(payload.action, 'confirm');
    assert.equal(payload.actor, 'opus-46');
  });

  it('rejects unknown anchor', () => {
    const db = createTestDb();

    const result = executeVerificationAction(db, { anchor: 'MISSING', action: 'confirm', actor: 'opus-46' });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('not found'));
  });
});
