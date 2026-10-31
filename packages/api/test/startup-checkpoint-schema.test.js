import assert from 'node:assert/strict';
import { test } from 'node:test';
import Database from 'better-sqlite3';

test('V49 upgrades an existing evidence DB without changing indexed documents', async () => {
  const { applyMigrations, CURRENT_SCHEMA_VERSION } = await import('../dist/domains/memory/schema.js');
  const db = new Database(':memory:');
  try {
    applyMigrations(db);
    db.prepare(`INSERT INTO evidence_docs (anchor, kind, status, title, updated_at)
      VALUES ('F001', 'feature', 'active', 'Existing evidence', '2026-01-01')`).run();
    db.exec('DROP TABLE transcript_backfill_files; DROP TABLE document_vector_sources');
    db.prepare('DELETE FROM schema_version WHERE version >= 49').run();

    applyMigrations(db);
    applyMigrations(db);
    assert.equal(
      db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version,
      CURRENT_SCHEMA_VERSION,
    );
    assert.equal(db.prepare("SELECT title FROM evidence_docs WHERE anchor = 'F001'").get().title, 'Existing evidence');
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'transcript_backfill_files'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'document_vector_sources'").get());
  } finally {
    db.close();
  }
});
