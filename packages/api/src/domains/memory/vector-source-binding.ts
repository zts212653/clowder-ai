import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EmbedModelInfo } from './interfaces.js';
import { type PassageVectorStore, parsePassageVectorKey } from './PassageVectorStore.js';
import type { VectorStore } from './VectorStore.js';
import {
  prepareGenerationInvalidationConnection,
  sourceInvalidationFactSql,
} from './vector-generation-invalidation.js';
import { type VectorGenerationTables, vectorGenerationTables } from './vector-generation-tables.js';
import { PASSAGE_PARENT_POLICY_FIELDS } from './vector-source-fields.js';

export interface VectorSourceSnapshot {
  kind: 'documents' | 'passages';
  key: string;
  revisionHash: string;
  sourceHash: string;
  text: string;
}

/** Bind exactly the canonical input read before the encoder await. */
export function captureVectorSource(
  db: Database.Database,
  kind: VectorSourceSnapshot['kind'],
  key: string,
): VectorSourceSnapshot | undefined {
  const row =
    kind === 'documents'
      ? (db.prepare('SELECT * FROM evidence_docs WHERE anchor=?').get(key) as Record<string, unknown> | undefined)
      : (() => {
          const { docAnchor, passageId } = parsePassageVectorKey(key);
          return db
            .prepare('SELECT * FROM evidence_passages WHERE doc_anchor=? AND passage_id=?')
            .get(docAnchor, passageId) as Record<string, unknown> | undefined;
        })();
  if (!row) return;
  if (kind === 'passages')
    return capturePassageVectorSource(db, {
      docAnchor: String(row.doc_anchor),
      passageId: String(row.passage_id),
      content: String(row.content),
    });
  return sourceSnapshot(kind, key, row);
}

/** Reuse a passage body already selected by the bounded warmup page. */
export function capturePassageVectorSource(
  db: Database.Database,
  row: { docAnchor: string; passageId: string; content: string },
): VectorSourceSnapshot | undefined {
  const parent = db
    .prepare(`SELECT ${PASSAGE_PARENT_POLICY_FIELDS.join(',')} FROM evidence_docs WHERE anchor=?`)
    .get(row.docAnchor) as Record<string, unknown> | undefined;
  if (
    !parent ||
    db
      .prepare('SELECT 1 FROM message_recall_index_suppressions WHERE doc_anchor=? AND passage_id=?')
      .get(row.docAnchor, row.passageId)
  )
    return;
  // Position/speaker/time are canonical publication metadata, not encoder input.
  return sourceSnapshot(
    'passages',
    JSON.stringify([row.docAnchor, row.passageId]),
    { doc_anchor: row.docAnchor, passage_id: row.passageId, content: row.content },
    parent,
  );
}

function sourceSnapshot(
  kind: VectorSourceSnapshot['kind'],
  key: string,
  row: Record<string, unknown>,
  parent?: Record<string, unknown>,
): VectorSourceSnapshot {
  const canonical = {
    row: Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    ...(parent ? { parent } : {}),
  };
  return {
    kind,
    key,
    revisionHash: createHash('sha256').update(JSON.stringify(canonical)).digest('hex'),
    sourceHash: typeof row.source_hash === 'string' ? row.source_hash : '',
    text: kind === 'documents' ? `${row.title} ${row.summary ?? ''}` : String(row.content),
  };
}

/** Caller holds the original writer queue; vector+proof commit in one short transaction. */
export function commitVectorSource(
  db: Database.Database,
  vectorStore: VectorStore | PassageVectorStore,
  snapshot: VectorSourceSnapshot,
  vector: Float32Array,
  model: EmbedModelInfo,
): boolean {
  return db.transaction(() => {
    const live = captureVectorSource(db, snapshot.kind, snapshot.key);
    if (!live || live.revisionHash !== snapshot.revisionHash) return false;
    const tables = vectorStore.tables;
    if (model.generationId && tables.generationId !== model.generationId) return false;
    if (vector.length !== model.dim || !vector.every(Number.isFinite)) throw new Error('Invalid vector projection');
    if (model.representationFingerprint) {
      const row = db
        .prepare(`SELECT value FROM ${tables.metadata} WHERE key='embedding_representation_fingerprint'`)
        .get() as { value: string } | undefined;
      if (row?.value !== model.representationFingerprint) return false;
      if (model.generationId === 'g1') {
        const registry = db.prepare('SELECT fingerprint FROM vector_generations WHERE id=?').get('g1') as
          | { fingerprint: string }
          | undefined;
        if (registry?.fingerprint !== model.representationFingerprint) return false;
      }
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
      if (Math.abs(norm - 1) > 0.001) throw new Error('Invalid vector normalization');
    }
    vectorStore.upsert(snapshot.key, vector);
    if (snapshot.kind === 'documents')
      db.prepare(
        `INSERT OR REPLACE INTO ${tables.documentSources}(anchor,source_hash,revision_hash) VALUES(?,?,?)`,
      ).run(snapshot.key, snapshot.sourceHash, snapshot.revisionHash);
    else
      db.prepare(`INSERT OR REPLACE INTO ${tables.passageSources}(passage_key,revision_hash) VALUES(?,?)`).run(
        snapshot.key,
        snapshot.revisionHash,
      );
    return true;
  })();
}

/** Ordinary proofs also record mutations if a native backend is unavailable. */
export function installVectorSourceBindings(db: Database.Database): void {
  // Reopening must replace older ordinary fact definitions atomically. Native
  // physical triggers remain connection-private and are prepared afterwards.
  db.transaction(() => {
    db.exec(
      "CREATE TABLE IF NOT EXISTS vector_generations(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('building','ready')))",
    );
    for (const id of ['g0', 'g1'] as const) {
      const tables = vectorGenerationTables(id);
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${tables.documentSources}(anchor TEXT PRIMARY KEY,source_hash TEXT NOT NULL,revision_hash TEXT)`,
      );
      const columns = db.prepare(`PRAGMA table_info(${tables.documentSources})`).all() as Array<{ name: string }>;
      if (!columns.some((col) => col.name === 'revision_hash'))
        db.exec(`ALTER TABLE ${tables.documentSources} ADD COLUMN revision_hash TEXT`);
      db.exec(`CREATE TABLE IF NOT EXISTS ${tables.passageSources}(passage_key TEXT PRIMARY KEY,revision_hash TEXT)`);
      db.exec(`CREATE TABLE IF NOT EXISTS ${tables.metadata}(key TEXT PRIMARY KEY,value TEXT NOT NULL)`);
      for (const operation of ['INSERT', 'UPDATE', 'DELETE'] as const) {
        const rows = operation === 'UPDATE' ? ['old', 'new'] : [operation === 'DELETE' ? 'old' : 'new'];
        const docWrites = rows
          .map(
            (row) =>
              `INSERT INTO ${tables.documentSources}(anchor,source_hash,revision_hash) VALUES(${row}.anchor,'','invalidated') ON CONFLICT(anchor) DO UPDATE SET source_hash='',revision_hash='invalidated';`,
          )
          .join('\n');
        const passageWrites = rows
          .map(
            (row) =>
              `INSERT INTO ${tables.passageSources}(passage_key,revision_hash) VALUES(json_array(${row}.doc_anchor,${row}.passage_id),'invalidated') ON CONFLICT(passage_key) DO UPDATE SET revision_hash='invalidated';`,
          )
          .join('\n');
        db.exec(`DROP TRIGGER IF EXISTS vector_${id}_document_${operation}; CREATE TRIGGER vector_${id}_document_${operation} AFTER ${operation} ON evidence_docs
        WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE name='${tables.documents}') BEGIN
        ${docWrites} ${sourceInvalidationFactSql(tables, 'documents')} END`);
        const passageChanged =
          operation === 'UPDATE'
            ? 'AND (old.doc_anchor IS NOT new.doc_anchor OR old.passage_id IS NOT new.passage_id OR old.content IS NOT new.content)'
            : '';
        db.exec(`DROP TRIGGER IF EXISTS vector_${id}_passage_${operation}; CREATE TRIGGER vector_${id}_passage_${operation} AFTER ${operation} ON evidence_passages
        WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE name='${tables.passages}') ${passageChanged} BEGIN
        ${passageWrites} ${sourceInvalidationFactSql(tables, 'passages')} END`);
      }
      const changed = PASSAGE_PARENT_POLICY_FIELDS.map((field) => `old.${field} IS NOT new.${field}`).join(' OR ');
      for (const operation of ['DELETE', 'UPDATE'] as const) {
        const predicate = operation === 'UPDATE' ? `AND (${changed})` : '';
        const anchors = operation === 'UPDATE' ? 'old.anchor,new.anchor' : 'old.anchor';
        db.exec(`DROP TRIGGER IF EXISTS vector_${id}_parent_${operation}; CREATE TRIGGER vector_${id}_parent_${operation} AFTER ${operation} ON evidence_docs
        WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE name='${tables.passages}') ${predicate} BEGIN
        INSERT INTO ${tables.passageSources}(passage_key,revision_hash)
        SELECT json_array(doc_anchor,passage_id),'invalidated' FROM evidence_passages WHERE doc_anchor IN (${anchors})
        ON CONFLICT(passage_key) DO UPDATE SET revision_hash='invalidated';
        ${sourceInvalidationFactSql(tables, 'passages')} END`);
      }
      for (const operation of ['INSERT', 'UPDATE'] as const)
        db.exec(`DROP TRIGGER IF EXISTS vector_${id}_suppression_${operation}; CREATE TRIGGER vector_${id}_suppression_${operation}
      AFTER ${operation} ON message_recall_index_suppressions
      WHEN EXISTS(SELECT 1 FROM sqlite_master WHERE name IN ('${tables.documents}','${tables.passages}')) BEGIN
      INSERT INTO ${tables.passageSources}(passage_key,revision_hash) VALUES(json_array(new.doc_anchor,new.passage_id),'invalidated') ON CONFLICT(passage_key) DO UPDATE SET revision_hash='invalidated';
      INSERT INTO ${tables.documentSources}(anchor,source_hash,revision_hash) VALUES(new.doc_anchor,'','invalidated') ON CONFLICT(anchor) DO UPDATE SET source_hash='',revision_hash='invalidated';
      ${sourceInvalidationFactSql(tables, 'documents')} ${sourceInvalidationFactSql(tables, 'passages')} END`);
    }
  })();
  prepareGenerationInvalidationConnection(db);
}

/** Never discard outage recovery facts while their physical vector may still exist. */
export function pruneDeletedDocumentProofs(db: Database.Database, anchor?: string): void {
  const exists = db.prepare('SELECT 1 FROM sqlite_master WHERE name=?');
  for (const id of ['g0', 'g1'] as const) {
    const tables = vectorGenerationTables(id);
    const physical = Boolean(exists.get(tables.documents));
    if (physical && !exists.get(`${tables.documents}_rowids`)) continue;
    const vectorAbsent = physical
      ? `AND NOT EXISTS(SELECT 1 FROM ${tables.documents}_rowids v WHERE v.id=${tables.documentSources}.anchor)`
      : '';
    const target = anchor === undefined ? '' : 'AND anchor=?';
    db.prepare(
      `DELETE FROM ${tables.documentSources} WHERE anchor NOT IN (SELECT anchor FROM evidence_docs) ${vectorAbsent} ${target}`,
    ).run(...(anchor === undefined ? [] : [anchor]));
  }
}
