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
    const before = db.prepare("SELECT * FROM evidence_docs WHERE anchor = 'F001'").get();
    const vectorTriggers = () =>
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'vector_g%' ORDER BY name")
        .all()
        .map(({ name }) => name);
    const currentVectorTriggers = vectorTriggers();
    // A pre-V49 database cannot retain V81 triggers pointing at the proof
    // table we are removing. The real migration must reinstall every fence.
    for (const name of currentVectorTriggers) db.exec(`DROP TRIGGER ${name}`);
    db.exec('DROP TABLE transcript_backfill_files; DROP TABLE document_vector_sources');
    db.prepare('DELETE FROM schema_version WHERE version >= 49').run();

    applyMigrations(db);
    applyMigrations(db);
    assert.equal(
      db.prepare('SELECT MAX(version) AS version FROM schema_version').get().version,
      CURRENT_SCHEMA_VERSION,
    );
    assert.deepEqual(db.prepare("SELECT * FROM evidence_docs WHERE anchor = 'F001'").get(), before);
    assert.deepEqual(vectorTriggers(), currentVectorTriggers);
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'transcript_backfill_files'").get());
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name = 'document_vector_sources'").get());
  } finally {
    db.close();
  }
});
