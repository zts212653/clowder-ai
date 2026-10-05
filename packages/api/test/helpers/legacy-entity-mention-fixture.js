/** Minimal V24 memory tables for domain-specific historical migration fixtures.
 * Real V27/V41 databases already contain these tables; later memory migrations
 * must not weaken their production prerequisites to accommodate partial fixtures. */
export function installLegacyEntityMentionFixture(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS evidence_docs (
      anchor TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
      title TEXT NOT NULL, summary TEXT, keywords TEXT, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS evidence_passages (
      id INTEGER PRIMARY KEY AUTOINCREMENT, doc_anchor TEXT NOT NULL,
      passage_id TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT,
      UNIQUE(doc_anchor, passage_id)
    );
    CREATE TABLE IF NOT EXISTS entity_registry (
      entity_id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, canonical_name TEXT NOT NULL,
      provenance_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS entity_aliases (
      entity_id TEXT NOT NULL, alias TEXT NOT NULL, alias_norm TEXT NOT NULL,
      provenance_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(entity_id,alias_norm),
      FOREIGN KEY(entity_id) REFERENCES entity_registry(entity_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS entity_mentions (
      entity_id TEXT NOT NULL, doc_anchor TEXT NOT NULL, passage_id TEXT NOT NULL DEFAULT '',
      surface TEXT NOT NULL, surface_norm TEXT NOT NULL, source TEXT NOT NULL,
      provenance_json TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY(entity_id,doc_anchor,passage_id,surface_norm),
      FOREIGN KEY(entity_id) REFERENCES entity_registry(entity_id) ON DELETE CASCADE,
      FOREIGN KEY(doc_anchor) REFERENCES evidence_docs(anchor) ON DELETE CASCADE
    );
  `);
}
