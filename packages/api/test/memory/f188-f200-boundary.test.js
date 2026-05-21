import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { executeVerificationAction } from '../../dist/domains/memory/f188-verification-workflow.js';
import { RecallMetricsComputer } from '../../dist/domains/memory/RecallMetricsComputer.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

function createTestDb() {
  const db = new Database(':memory:');
  applyMigrations(db);
  return db;
}

function insertDoc(db, anchor, opts = {}) {
  const { reviewStatus = null, verifiedAt = null, authority = 'validated' } = opts;
  db.prepare(
    `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at, authority, review_status, verified_at)
     VALUES (?, 'feature', 'active', ?, '2026-01-01', ?, ?, ?)`,
  ).run(anchor, anchor, authority, reviewStatus, verifiedAt);
}

let recallSeq = 0;
function insertRecallEvent(db, anchor) {
  recallSeq++;
  db.prepare(
    `INSERT INTO recall_events (recall_id, cat_id, invocation_id, tool_name, query,
     candidates_json, consumed_json, timestamp)
     VALUES (?, 'opus-46', 'inv-1', 'search', 'test', '[]', ?, ?)`,
  ).run(`recall-${anchor}-${recallSeq}`, JSON.stringify([{ anchor, consumed: true }]), Date.now());
}

describe('F200 integration boundary (AC-J8)', () => {
  it('F200 RecallMetricsComputer does not write verified_at', () => {
    const db = createTestDb();
    insertDoc(db, 'A', { reviewStatus: 'needs_review' });
    insertRecallEvent(db, 'A');

    const computer = new RecallMetricsComputer(db);
    computer.computeMetrics();

    const row = db.prepare('SELECT verified_at FROM evidence_docs WHERE anchor = ?').get('A');
    assert.equal(row.verified_at, null, 'F200 must not write verified_at');
  });

  it('F200 RecallMetricsComputer does not change authority', () => {
    const db = createTestDb();
    insertDoc(db, 'A', { authority: 'validated' });
    insertRecallEvent(db, 'A');

    const computer = new RecallMetricsComputer(db);
    computer.computeMetrics();

    const row = db.prepare('SELECT authority FROM evidence_docs WHERE anchor = ?').get('A');
    assert.equal(row.authority, 'validated', 'F200 must not change authority');
  });

  it('F200 RecallMetricsComputer does not change review_status', () => {
    const db = createTestDb();
    insertDoc(db, 'A', { reviewStatus: 'needs_review' });
    insertRecallEvent(db, 'A');

    const computer = new RecallMetricsComputer(db);
    computer.computeMetrics();

    const row = db.prepare('SELECT review_status FROM evidence_docs WHERE anchor = ?').get('A');
    assert.equal(row.review_status, 'needs_review', 'F200 must not change review_status');
  });

  it('F188 verification workflow does not write to anchor_recall_metrics', () => {
    const db = createTestDb();
    insertDoc(db, 'A', { reviewStatus: 'needs_review' });

    executeVerificationAction(db, { anchor: 'A', action: 'confirm', actor: 'opus-46' });

    const hasTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='anchor_recall_metrics'")
      .get();
    if (hasTable) {
      const rows = db.prepare('SELECT * FROM anchor_recall_metrics').all();
      const touched = rows.filter((r) => r.anchor === 'A');
      assert.equal(touched.length, 0, 'F188 must not write to anchor_recall_metrics');
    }
  });

  it('needs_review docs can be joined with recall_events for priority sorting', () => {
    const db = createTestDb();
    insertDoc(db, 'LOW', { reviewStatus: 'needs_review' });
    insertDoc(db, 'HIGH', { reviewStatus: 'needs_review' });

    for (let i = 0; i < 5; i++) insertRecallEvent(db, 'HIGH');
    insertRecallEvent(db, 'LOW');

    const rows = db
      .prepare(
        `SELECT ed.anchor,
                (SELECT COUNT(*) FROM recall_events re
                 WHERE re.consumed_json LIKE '%' || ed.anchor || '%') AS mention_count
         FROM evidence_docs ed
         WHERE ed.review_status = 'needs_review'
         ORDER BY mention_count DESC`,
      )
      .all();

    assert.equal(rows[0].anchor, 'HIGH');
    assert.ok(rows[0].mention_count > rows[1].mention_count);
  });
});
