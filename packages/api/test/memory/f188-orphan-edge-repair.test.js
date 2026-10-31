import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Database from 'better-sqlite3';
import {
  applyOrphanRepair,
  classifyOrphanEdges,
  dryRunOrphanRepair,
} from '../../dist/domains/memory/f188-orphan-edge-repair.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';

function createTestDb() {
  const db = new Database(':memory:');
  applyMigrations(db);
  return db;
}

function insertDoc(db, anchor, kind = 'feature') {
  db.prepare(
    `INSERT INTO evidence_docs (anchor, kind, status, title, updated_at)
     VALUES (?, ?, 'active', ?, '2026-01-01')`,
  ).run(anchor, kind, anchor);
}

function insertEdge(db, from, to, relation = 'feature_ref') {
  db.prepare('INSERT OR IGNORE INTO edges (from_anchor, to_anchor, relation) VALUES (?, ?, ?)').run(from, to, relation);
}

describe('F188 Phase J: orphan edge classifier (AC-J2)', () => {
  it('classifies zero-pad orphans: F20→F020 when F020 exists', () => {
    const db = createTestDb();
    insertDoc(db, 'F020');
    insertDoc(db, 'F188');
    insertEdge(db, 'F188', 'F20', 'feature_ref');

    const result = classifyOrphanEdges(db);
    const zeroPad = result.find((c) => c.id === 'feature_ref_zero_pad');
    assert.ok(zeroPad, 'should have feature_ref_zero_pad bucket');
    assert.equal(zeroPad.edges.length, 1);
    assert.equal(zeroPad.edges[0].from_anchor, 'F188');
    assert.equal(zeroPad.edges[0].to_anchor, 'F20');
    assert.equal(zeroPad.edges[0].action, 'update');
    assert.equal(zeroPad.edges[0].new_to_anchor, 'F020');
  });

  it('classifies true ghost feature refs when canonical form also missing', () => {
    const db = createTestDb();
    insertDoc(db, 'F188');
    insertEdge(db, 'F188', 'F999', 'feature_ref');

    const result = classifyOrphanEdges(db);
    const ghost = result.find((c) => c.id === 'feature_ref_true_ghost');
    assert.ok(ghost, 'should have feature_ref_true_ghost bucket');
    assert.equal(ghost.edges.length, 1);
    assert.equal(ghost.edges[0].action, 'delete');
  });

  it('classifies wikilink orphans pointing to code-like artifacts', () => {
    const db = createTestDb();
    insertDoc(db, 'F188');
    insertEdge(db, 'F188', 'useState', 'wikilink');
    insertEdge(db, 'F188', 'React.memo', 'wikilink');

    const result = classifyOrphanEdges(db);
    const code = result.find((c) => c.id === 'wikilink_code_artifact');
    assert.ok(code, 'should have wikilink_code_artifact bucket');
    assert.ok(code.edges.length >= 1);
    assert.equal(code.edges[0].action, 'delete');
  });

  it('classifies wikilink orphans pointing to potential doc anchors', () => {
    const db = createTestDb();
    insertDoc(db, 'F188');
    insertEdge(db, 'F188', 'Library Architecture', 'wikilink');

    const result = classifyOrphanEdges(db);
    const potDoc = result.find((c) => c.id === 'wikilink_potential_doc');
    assert.ok(potDoc, 'should have wikilink_potential_doc bucket');
    assert.equal(potDoc.edges.length, 1);
    assert.equal(potDoc.edges[0].action, 'review');
  });

  it('classifies plain lowercase wikilink as potential doc, not code artifact', () => {
    const db = createTestDb();
    insertDoc(db, 'F188');
    insertEdge(db, 'F188', 'architecture', 'wikilink');

    const result = classifyOrphanEdges(db);
    const code = result.find((c) => c.id === 'wikilink_code_artifact');
    assert.equal(code.edges.length, 0, 'architecture is not a code artifact');
    const potDoc = result.find((c) => c.id === 'wikilink_potential_doc');
    assert.equal(potDoc.edges.length, 1, 'architecture should be potential doc');
  });

  it('classifies related-field orphans', () => {
    const db = createTestDb();
    insertDoc(db, 'F188');
    insertEdge(db, 'F188', 'GONE', 'related');

    const result = classifyOrphanEdges(db);
    const ghost = result.find((c) => c.id === 'related_field_ghost');
    assert.ok(ghost, 'should have related_field_ghost bucket');
    assert.equal(ghost.edges.length, 1);
    assert.equal(ghost.edges[0].action, 'delete');
  });

  it('moves true ghost to review when target exists on disk', () => {
    const db = createTestDb();
    insertDoc(db, 'F188');
    insertEdge(db, 'F188', 'F999', 'feature_ref');

    const diskAnchors = new Set(['F999']);
    const result = classifyOrphanEdges(db, { diskAnchors });
    const ghost = result.find((c) => c.id === 'feature_ref_true_ghost');
    assert.equal(ghost.edges.length, 0, 'F999 should not be auto-deleted when on disk');
    const potDoc = result.find((c) => c.id === 'wikilink_potential_doc');
    assert.ok(
      result.some((c) => c.edges.some((e) => e.to_anchor === 'F999' && e.action === 'review')),
      'F999 should go to review when on disk',
    );
  });

  it('moves related ghost to review when target exists on disk', () => {
    const db = createTestDb();
    insertDoc(db, 'F188');
    insertEdge(db, 'F188', 'GONE', 'related');

    const diskAnchors = new Set(['GONE']);
    const result = classifyOrphanEdges(db, { diskAnchors });
    const ghost = result.find((c) => c.id === 'related_field_ghost');
    assert.equal(ghost.edges.length, 0, 'GONE should not be auto-deleted when on disk');
  });

  it('returns empty classifications when no orphan edges exist', () => {
    const db = createTestDb();
    insertDoc(db, 'A');
    insertDoc(db, 'B');
    insertEdge(db, 'A', 'B', 'related');

    const result = classifyOrphanEdges(db);
    const total = result.reduce((s, c) => s + c.edges.length, 0);
    assert.equal(total, 0);
  });
});

describe('F188 Phase J: orphan edge dry-run (AC-J3)', () => {
  it('returns classification report with counts and SQL preview', () => {
    const db = createTestDb();
    insertDoc(db, 'F020');
    insertDoc(db, 'F188');
    insertEdge(db, 'F188', 'F20', 'feature_ref');
    insertEdge(db, 'F188', 'GHOST', 'feature_ref');

    const report = dryRunOrphanRepair(db);
    assert.ok(report.classifications.length > 0);
    assert.ok(typeof report.totalOrphansBefore === 'number');
    assert.ok(typeof report.autoFixableCount === 'number');
    assert.ok(typeof report.reviewCount === 'number');
    assert.ok(Array.isArray(report.sqlPreview));
  });

  it('auto-fixable count includes update + delete actions', () => {
    const db = createTestDb();
    insertDoc(db, 'F020');
    insertDoc(db, 'F188');
    insertEdge(db, 'F188', 'F20', 'feature_ref');
    insertEdge(db, 'F188', 'GHOST', 'related');

    const report = dryRunOrphanRepair(db);
    assert.ok(report.autoFixableCount >= 2, 'zero-pad update + ghost delete should both be auto-fixable');
  });

  it('dry-run with diskAnchors downgrades ghost delete to review', () => {
    const db = createTestDb();
    insertDoc(db, 'F188');
    insertEdge(db, 'F188', 'F999', 'feature_ref');
    insertEdge(db, 'F188', 'GONE', 'related');

    const diskAnchors = new Set(['F999', 'GONE']);
    const report = dryRunOrphanRepair(db, { diskAnchors });
    assert.equal(report.autoFixableCount, 0, 'disk-present ghosts should not be auto-fixable');
    assert.equal(report.reviewCount, 2, 'disk-present ghosts should go to review');
  });
});

describe('F188 Phase J: orphan edge apply (AC-J4)', () => {
  it('updates zero-pad edges to canonical form', () => {
    const db = createTestDb();
    insertDoc(db, 'F020');
    insertDoc(db, 'F188');
    insertEdge(db, 'F188', 'F20', 'feature_ref');

    const report = dryRunOrphanRepair(db);
    const result = applyOrphanRepair(db, report);
    assert.ok(result.applied > 0);

    const remaining = db.prepare("SELECT count(*) AS c FROM edges WHERE to_anchor = 'F20'").get();
    assert.equal(remaining.c, 0, 'old F20 edge should be gone');

    const updated = db.prepare("SELECT count(*) AS c FROM edges WHERE to_anchor = 'F020'").get();
    assert.equal(updated.c, 1, 'should have F020 edge');
  });

  it('handles zero-pad update when canonical edge already exists', () => {
    const db = createTestDb();
    insertDoc(db, 'F020');
    insertDoc(db, 'F188');
    insertEdge(db, 'F188', 'F20', 'feature_ref');
    insertEdge(db, 'F188', 'F020', 'feature_ref');

    const report = dryRunOrphanRepair(db);
    const result = applyOrphanRepair(db, report);
    assert.ok(result.applied > 0);

    const remaining = db.prepare("SELECT count(*) AS c FROM edges WHERE to_anchor = 'F20'").get();
    assert.equal(remaining.c, 0, 'old F20 edge should be gone');

    const canonical = db
      .prepare(
        "SELECT count(*) AS c FROM edges WHERE from_anchor = 'F188' AND to_anchor = 'F020' AND relation = 'feature_ref'",
      )
      .get();
    assert.equal(canonical.c, 1, 'should have exactly one canonical edge');
  });

  it('deletes true ghost edges', () => {
    const db = createTestDb();
    insertDoc(db, 'F188');
    insertEdge(db, 'F188', 'GHOST', 'related');

    const report = dryRunOrphanRepair(db);
    const result = applyOrphanRepair(db, report);
    assert.ok(result.applied > 0);

    const remaining = db.prepare("SELECT count(*) AS c FROM edges WHERE to_anchor = 'GHOST'").get();
    assert.equal(remaining.c, 0, 'ghost edge should be deleted');
  });

  it('does NOT auto-delete wikilink_potential_doc edges', () => {
    const db = createTestDb();
    insertDoc(db, 'F188');
    insertEdge(db, 'F188', 'Library Architecture', 'wikilink');

    const report = dryRunOrphanRepair(db);
    const result = applyOrphanRepair(db, report);

    const remaining = db.prepare("SELECT count(*) AS c FROM edges WHERE to_anchor = 'Library Architecture'").get();
    assert.equal(remaining.c, 1, 'potential doc edge should be kept for review');
    assert.equal(result.skippedReview > 0, true);
  });

  it('creates backup before applying', () => {
    const db = createTestDb();
    insertDoc(db, 'F188');
    insertEdge(db, 'F188', 'GHOST', 'related');

    const report = dryRunOrphanRepair(db);
    applyOrphanRepair(db, report);

    const backup = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'edges_backup_%'").get();
    assert.ok(backup, 'backup table should exist');
  });

  it('feature_ref from-orphan deletes even when disk target exists', () => {
    const db = createTestDb();
    // Both endpoints missing from DB, but F020 exists on disk
    insertEdge(db, 'GONE_SOURCE', 'F020', 'feature_ref');

    const diskAnchors = new Set(['F020']);
    const classifications = classifyOrphanEdges(db, { diskAnchors });
    const ghost = classifications.find((c) => c.id === 'feature_ref_true_ghost');
    assert.ok(ghost, 'from-orphan feature_ref should be deleted');
    assert.equal(ghost.edges.length, 1);
    assert.equal(ghost.edges[0].from_anchor, 'GONE_SOURCE');

    const potDoc = classifications.find((c) => c.id === 'wikilink_potential_doc');
    assert.equal(potDoc?.edges.length ?? 0, 0, 'should NOT be downgraded to review');
  });

  it('wikilink with both endpoints missing routes to delete, not review', () => {
    const db = createTestDb();
    insertEdge(db, 'GONE_SOURCE', 'Potential Doc Title', 'wikilink');

    const classifications = classifyOrphanEdges(db);
    const ghost = classifications.find((c) => c.id === 'related_field_ghost');
    assert.ok(ghost, 'both-orphan wikilink should be deleted as related_field_ghost');
    assert.equal(ghost.edges.length, 1);
    assert.equal(ghost.edges[0].from_anchor, 'GONE_SOURCE');

    const potDoc = classifications.find((c) => c.id === 'wikilink_potential_doc');
    assert.equal(potDoc?.edges.length ?? 0, 0, 'should NOT be classified as potential doc');
  });

  it('from-orphan edge auto-deletes regardless of disk target', () => {
    const db = createTestDb();
    insertDoc(db, 'TARGET');
    insertEdge(db, 'MISSING_SOURCE', 'TARGET', 'related');

    const diskAnchors = new Set(['TARGET']);
    const classifications = classifyOrphanEdges(db, { diskAnchors });
    const ghost = classifications.find((c) => c.id === 'related_field_ghost');
    assert.ok(ghost, 'from-orphan should be classified as related_field_ghost');
    assert.equal(ghost.edges.length, 1);
    assert.equal(ghost.edges[0].from_anchor, 'MISSING_SOURCE');
  });

  it('reduces orphan count after apply', () => {
    const db = createTestDb();
    insertDoc(db, 'F020');
    insertDoc(db, 'F188');
    insertEdge(db, 'F188', 'F20', 'feature_ref');
    insertEdge(db, 'F188', 'GONE', 'related');

    const beforeReport = dryRunOrphanRepair(db);
    assert.equal(beforeReport.totalOrphansBefore, 2);

    applyOrphanRepair(db, beforeReport);

    const afterReport = dryRunOrphanRepair(db);
    assert.equal(afterReport.totalOrphansBefore, 0, 'all auto-fixable orphans should be resolved');
  });
});
