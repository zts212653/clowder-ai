import type Database from 'better-sqlite3';

// Scanner paths are docs-relative; lane identities include docs/. Both bind the same anchor.
const ANCHOR = `('doc:' || CASE WHEN life.source_path LIKE 'docs/%'
  THEN substr(life.source_path, 6, length(life.source_path) - 8)
  ELSE substr(life.source_path, 1, length(life.source_path) - 3) END)`;

function blockedDoc(row: string): string {
  return `EXISTS (SELECT 1 FROM taste_memory_lifecycle AS life
    WHERE (${row}.anchor = ${ANCHOR} OR ${row}.source_path = life.source_path
      OR ${row}.source_path = CASE WHEN life.source_path LIKE 'docs/%'
        THEN substr(life.source_path, 6) ELSE life.source_path END)
    AND (life.status <> 'active' OR (life.projected_revision IS NOT NULL
      AND COALESCE(${row}.source_hash, '') NOT IN (life.projected_revision,
        substr(life.projected_revision, 8), substr(life.projected_revision, 8, 16)))))`;
}

function blockedPassage(row: string): string {
  return `EXISTS (SELECT 1 FROM taste_memory_lifecycle AS life
    WHERE ${row}.doc_anchor = ${ANCHOR} AND (life.status <> 'active'
      OR NOT EXISTS (SELECT 1 FROM evidence_docs AS doc
        WHERE doc.anchor = ${row}.doc_anchor AND NOT (${blockedDoc('doc')}))))`;
}

/** Persistent SQL barriers also apply to old index writers which do not know the lifecycle API. */
export function ensureTasteMemoryProjectionFence(db: Database.Database): void {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'taste_memory_lifecycle'").get()) return;
  const purge = `
    DELETE FROM evidence_passages WHERE ${blockedPassage('evidence_passages')}
      OR doc_anchor IN (SELECT anchor FROM evidence_docs WHERE ${blockedDoc('evidence_docs')});
    DELETE FROM evidence_docs WHERE ${blockedDoc('evidence_docs')};
  `;
  db.transaction(() => {
    db.exec(purge);
    for (const [table, predicate] of [
      ['evidence_docs', blockedDoc('NEW')],
      ['evidence_passages', blockedPassage('NEW')],
    ]) {
      for (const operation of ['INSERT', 'UPDATE']) {
        const name = `taste_${table}_fence_${operation.toLowerCase()}`;
        db.exec(`DROP TRIGGER IF EXISTS ${name};
          CREATE TRIGGER ${name} BEFORE ${operation} ON ${table}
          WHEN ${predicate} BEGIN SELECT RAISE(IGNORE); END;`);
      }
    }
    for (const operation of ['INSERT', 'UPDATE']) {
      const name = `taste_lifecycle_purge_${operation.toLowerCase()}`;
      db.exec(`DROP TRIGGER IF EXISTS ${name};
        CREATE TRIGGER ${name} AFTER ${operation} ON taste_memory_lifecycle BEGIN ${purge} END;`);
    }
  })();
}
