/** V41/V43 snapshots already contain the V1-V24 document metadata and the V39
 * recall tables. Complete the older domain fixture before later migrations run. */
export function installV39MemorySchemaFixture(db) {
  const columns = new Set(
    db
      .prepare('PRAGMA table_info(evidence_docs)')
      .all()
      .map(({ name }) => name),
  );
  for (const [name, definition] of Object.entries({
    superseded_by: 'TEXT',
    materialized_from: 'TEXT',
    pack_id: 'TEXT',
    provenance_tier: 'TEXT',
    provenance_source: 'TEXT',
    generalizable: 'INTEGER DEFAULT NULL',
    authority: "TEXT DEFAULT 'observed'",
    activation: "TEXT DEFAULT 'query'",
    verified_at: 'TEXT',
    source_ids: 'TEXT',
    summary_of_anchor: 'TEXT',
    compression_rationale: 'TEXT',
    contradicts: 'TEXT',
    invalid_at: 'TEXT',
    review_cycle_days: 'INTEGER',
    world_id: 'TEXT',
    scene_id: 'TEXT',
    collection_id: 'TEXT',
    review_status: 'TEXT',
    first_indexed_at: 'INTEGER NOT NULL DEFAULT 0',
  })) {
    if (!columns.has(name)) db.exec(`ALTER TABLE evidence_docs ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_recall_index_suppressions (
      doc_anchor TEXT NOT NULL,
      passage_id TEXT NOT NULL,
      lease_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('prepared', 'committed')),
      prepared_at TEXT NOT NULL,
      committed_at TEXT,
      PRIMARY KEY (doc_anchor, passage_id, lease_id)
    );
    CREATE INDEX IF NOT EXISTS idx_message_recall_suppressions_passage
      ON message_recall_index_suppressions(doc_anchor, passage_id, state);
    CREATE TABLE IF NOT EXISTS message_recall_index_snapshots (
      doc_anchor TEXT NOT NULL,
      passage_id TEXT NOT NULL,
      passage_content TEXT,
      passage_speaker TEXT,
      passage_position INTEGER,
      passage_created_at TEXT,
      doc_title TEXT,
      doc_summary TEXT,
      doc_source_hash TEXT,
      doc_updated_at TEXT,
      PRIMARY KEY (doc_anchor, passage_id)
    );
  `);
}
