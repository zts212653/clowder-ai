import type Database from 'better-sqlite3';

const columns = 'entity_id, doc_anchor, passage_id, surface, surface_norm, source, provenance_json, created_at';
const currentGeneration = `MAX(COALESCE(e.generation, 0), COALESCE(d.generation, 0))`;

/** V52: retain the legacy rows in place; publish derived projections by pointer.
 * No corpus rewrite or destructive data migration. Legacy INSERT OR IGNORE and
 * DELETE statements continue to operate on the current projection via triggers. */
export function migrateEntityMentionProjections(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_source_revision (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL);
      INSERT OR IGNORE INTO memory_source_revision(id, revision) VALUES (1, 0);
      CREATE TABLE IF NOT EXISTS entity_mention_pending_docs (doc_anchor TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS entity_mention_generations (
        generation INTEGER PRIMARY KEY AUTOINCREMENT, owner_pid INTEGER NOT NULL,
        phase TEXT NOT NULL CHECK (phase IN ('staging', 'published')), scopes_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entity_mention_entity_heads (
        entity_id TEXT PRIMARY KEY REFERENCES entity_registry(entity_id) ON DELETE CASCADE,
        generation INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS entity_mention_doc_heads (
        doc_anchor TEXT PRIMARY KEY REFERENCES evidence_docs(anchor) ON DELETE CASCADE,
        generation INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_entity_mention_entity_generation ON entity_mention_entity_heads(generation);
      CREATE INDEX IF NOT EXISTS idx_entity_mention_doc_generation ON entity_mention_doc_heads(generation);
      CREATE TABLE IF NOT EXISTS entity_mention_rows (
        generation INTEGER NOT NULL, entity_id TEXT NOT NULL, doc_anchor TEXT NOT NULL,
        passage_id TEXT NOT NULL DEFAULT '', surface TEXT NOT NULL, surface_norm TEXT NOT NULL,
        source TEXT NOT NULL, provenance_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (generation, entity_id, doc_anchor, passage_id, surface_norm),
        FOREIGN KEY (doc_anchor) REFERENCES evidence_docs(anchor) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_entity_mention_rows_entity ON entity_mention_rows(entity_id, generation);
      CREATE INDEX IF NOT EXISTS idx_entity_mention_rows_doc ON entity_mention_rows(doc_anchor, generation);
    `);
    const canonical = db.prepare("SELECT type FROM sqlite_master WHERE name='entity_mentions'").get() as
      | { type: string }
      | undefined;
    if (canonical?.type === 'table') db.exec('ALTER TABLE entity_mentions RENAME TO entity_mentions_legacy');
    db.exec(`
      CREATE VIEW IF NOT EXISTS entity_mentions AS
        SELECT ${columns
          .split(', ')
          .map((column) => `m.${column}`)
          .join(', ')} FROM entity_mentions_legacy m
        LEFT JOIN entity_mention_entity_heads e ON e.entity_id = m.entity_id
        LEFT JOIN entity_mention_doc_heads d ON d.doc_anchor = m.doc_anchor
        WHERE ${currentGeneration} = 0
        UNION ALL
        SELECT ${columns
          .split(', ')
          .map((column) => `m.${column}`)
          .join(', ')} FROM entity_mention_rows m
        JOIN entity_registry r ON r.entity_id = m.entity_id
        LEFT JOIN entity_mention_entity_heads e ON e.entity_id = m.entity_id
        LEFT JOIN entity_mention_doc_heads d ON d.doc_anchor = m.doc_anchor
        WHERE m.generation = ${currentGeneration};
    `);
    const generationForNew = `(SELECT MAX(COALESCE((SELECT generation FROM entity_mention_entity_heads WHERE entity_id = NEW.entity_id), 0), COALESCE((SELECT generation FROM entity_mention_doc_heads WHERE doc_anchor = NEW.doc_anchor), 0)))`;
    const newValues = columns
      .split(', ')
      .map((column) => `NEW.${column}`)
      .join(', ');
    db.exec(`CREATE TRIGGER IF NOT EXISTS entity_mentions_insert INSTEAD OF INSERT ON entity_mentions BEGIN
      SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM entity_registry WHERE entity_id = NEW.entity_id) THEN RAISE(ABORT, 'FOREIGN KEY constraint failed') END;
      INSERT OR IGNORE INTO entity_mentions_legacy (${columns}) SELECT ${newValues} WHERE ${generationForNew} = 0;
      INSERT OR IGNORE INTO entity_mention_rows (generation, ${columns}) SELECT ${generationForNew}, ${newValues} WHERE ${generationForNew} > 0;
    END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS entity_mentions_delete INSTEAD OF DELETE ON entity_mentions BEGIN
      DELETE FROM entity_mentions_legacy WHERE entity_id = OLD.entity_id AND doc_anchor = OLD.doc_anchor AND passage_id = OLD.passage_id AND surface_norm = OLD.surface_norm;
      DELETE FROM entity_mention_rows WHERE entity_id = OLD.entity_id AND doc_anchor = OLD.doc_anchor AND passage_id = OLD.passage_id AND surface_norm = OLD.surface_norm
        AND generation = (SELECT MAX(COALESCE((SELECT generation FROM entity_mention_entity_heads WHERE entity_id = OLD.entity_id), 0), COALESCE((SELECT generation FROM entity_mention_doc_heads WHERE doc_anchor = OLD.doc_anchor), 0)));
    END`);
    db.exec(`CREATE TRIGGER IF NOT EXISTS entity_mention_rows_entity_delete AFTER DELETE ON entity_registry
      BEGIN DELETE FROM entity_mention_rows WHERE entity_id = OLD.entity_id; END`);
    for (const table of ['evidence_docs', 'evidence_passages', 'entity_registry', 'entity_aliases']) {
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        db.exec(`CREATE TRIGGER IF NOT EXISTS memory_revision_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
          BEGIN UPDATE memory_source_revision SET revision = revision + 1 WHERE id = 1; END`);
      }
    }
    for (const table of ['evidence_docs', 'evidence_passages']) {
      const field = table === 'evidence_docs' ? 'anchor' : 'doc_anchor';
      for (const operation of ['INSERT', 'UPDATE', 'DELETE']) {
        const row = operation === 'DELETE' ? 'OLD' : 'NEW';
        db.exec(`CREATE TRIGGER IF NOT EXISTS memory_mention_pending_${table}_${operation.toLowerCase()} AFTER ${operation} ON ${table}
          BEGIN INSERT INTO entity_mention_pending_docs(doc_anchor)
            SELECT ${row}.${field} WHERE EXISTS (SELECT 1 FROM entity_registry LIMIT 1)
              AND NOT EXISTS (SELECT 1 FROM entity_mention_pending_docs WHERE doc_anchor=${row}.${field}); END`);
      }
    }
    db.prepare('INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      52,
      new Date().toISOString(),
    );
  })();
}
