import type Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import {
  type VectorGenerationTables,
  validateVectorGenerationTables,
  vectorGenerationTables,
} from './vector-generation-tables.js';
import { PASSAGE_PARENT_POLICY_FIELDS } from './vector-source-fields.js';

const EPOCH = 'vector_invalidation_epoch';
const QUARANTINE = 'vector_invalidation_quarantined';
export interface GenerationInvalidationState {
  epoch: string;
  quarantined: boolean;
}

export function generationInvalidationState(
  db: Database.Database,
  input: VectorGenerationTables,
): GenerationInvalidationState {
  const tables = validateVectorGenerationTables(input);
  const rows = db
    .prepare(`SELECT key,value FROM ${tables.metadata} WHERE key IN (?,?)`)
    .all(EPOCH, QUARANTINE) as Array<{ key: string; value: string }>;
  const values = new Map(rows.map((row) => [row.key, row.value]));
  return { epoch: values.get(EPOCH) ?? '0', quarantined: values.get(QUARANTINE) === '1' };
}

export function generationInvalidationCurrent(
  db: Database.Database,
  tables: VectorGenerationTables,
  captured: GenerationInvalidationState,
): boolean {
  if (captured.quarantined) return false;
  try {
    const current = generationInvalidationState(db, tables);
    return !current.quarantined && current.epoch === captured.epoch;
  } catch {
    return false;
  }
}

function advanceEpoch(db: Database.Database, tables: VectorGenerationTables): void {
  db.prepare(
    `INSERT INTO ${tables.metadata}(key,value) VALUES(?,'1') ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1`,
  ).run(EPOCH);
}

export function quarantineGenerationInvalidations(db: Database.Database): void {
  const exists = db.prepare('SELECT 1 FROM sqlite_master WHERE name=?');
  db.transaction(() => {
    for (const id of ['g0', 'g1'] as const) {
      const names = vectorGenerationTables(id);
      if (exists.get(names.documents) || exists.get(names.passages)) {
        db.exec(`CREATE TABLE IF NOT EXISTS ${names.metadata}(key TEXT PRIMARY KEY,value TEXT NOT NULL)`);
        advanceEpoch(db, names);
        db.prepare(
          `INSERT INTO ${names.metadata}(key,value) VALUES(?,'1') ON CONFLICT(key) DO UPDATE SET value='1'`,
        ).run(QUARANTINE);
      }
    }
  })();
}

/** Each canonical writer connection registers existing virtual tables even with embedding off. */
export function prepareGenerationInvalidationConnection(db: Database.Database): void {
  const exists = db.prepare('SELECT 1 FROM sqlite_master WHERE name=?');
  const tables = (['g0', 'g1'] as const).map((id) => vectorGenerationTables(id));
  if (!tables.some((names) => exists.get(names.documents) || exists.get(names.passages))) return;
  try {
    if (!db.prepare("SELECT 1 FROM pragma_module_list WHERE name='vec0'").get()) sqliteVec.load(db);
    for (const names of tables) {
      installGenerationVectorTriggers(db, names, 'documents');
      installGenerationVectorTriggers(db, names, 'passages');
    }
  } catch {
    quarantineGenerationInvalidations(db);
  }
}

function readyMarker(tables: VectorGenerationTables, kind: 'documents' | 'passages'): string {
  validateVectorGenerationTables(tables);
  if (kind !== 'documents' && kind !== 'passages') throw new Error('Invalid vector source kind');
  return `cat_cafe_vector_ready_${tables.generationId}_${kind}`;
}

/** Persistent facts use connection-local capability, not mere extension presence. */
export function sourceInvalidationFactSql(input: VectorGenerationTables, kind: 'documents' | 'passages'): string {
  const tables = validateVectorGenerationTables(input);
  const missing = `EXISTS(SELECT 1 FROM sqlite_master WHERE name='${tables[kind]}') AND NOT EXISTS(SELECT 1 FROM pragma_table_info('${readyMarker(tables, kind)}','temp'))`;
  // Retirement is unconditional. A healthy physical delete cannot retract rows
  // already returned by native KNN in a different connection.
  return `INSERT INTO ${tables.metadata}(key,value) VALUES('${EPOCH}','1')
    ON CONFLICT(key) DO UPDATE SET value=CAST(value AS INTEGER)+1;
    INSERT INTO ${tables.metadata}(key,value) SELECT '${QUARANTINE}','1' WHERE ${missing}
    ON CONFLICT(key) DO UPDATE SET value='1';`;
}

/** Only this healthy writer receives native triggers. Other writers can still mutate canonical rows. */
export function installGenerationVectorTriggers(
  db: Database.Database,
  input: VectorGenerationTables,
  kind: 'documents' | 'passages',
): void {
  const tables = validateVectorGenerationTables(input);
  const marker = readyMarker(tables, kind);
  const table = tables[kind];
  if (!db.prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(table)) return;
  const source = kind === 'documents' ? 'evidence_docs' : 'evidence_passages';
  const key = kind === 'documents' ? 'anchor' : 'passage_key';
  db.transaction(() => {
    // vec0 plans only `key = value` as a primary-key point lookup; a multi-value IN list or an
    // IN subquery scans every stored vector, once per changed canonical row on the writer thread.
    for (const operation of ['INSERT', 'UPDATE', 'DELETE'] as const) {
      const rows = operation === 'UPDATE' ? ['old', 'new'] : [operation === 'DELETE' ? 'old' : 'new'];
      const deletes = rows
        .map((row) => (kind === 'documents' ? `${row}.anchor` : `json_array(${row}.doc_anchor,${row}.passage_id)`))
        .map((value) => `DELETE FROM ${table} WHERE ${key}=${value};`)
        .join(' ');
      const name = `vector_${tables.generationId}_${kind}_physical_${operation}`;
      db.exec(`DROP TRIGGER IF EXISTS main.${name}`);
      const changed =
        kind === 'passages' && operation === 'UPDATE'
          ? 'WHEN old.doc_anchor IS NOT new.doc_anchor OR old.passage_id IS NOT new.passage_id OR old.content IS NOT new.content'
          : '';
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${name} AFTER ${operation} ON main.${source} ${changed}
        BEGIN ${deletes} END`);
    }
    if (kind === 'passages') {
      // A parent change names a set of passages. Each key passes through a connection-local queue
      // whose own trigger deletes it by point lookup; the queue is emptied in the same statement.
      const queue = `vector_${tables.generationId}_parent_invalidation_queue`;
      db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${queue}(passage_key TEXT NOT NULL)`);
      db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${queue}_drain AFTER INSERT ON temp.${queue}
        BEGIN DELETE FROM ${table} WHERE passage_key=new.passage_key; END`);
      const changed = PASSAGE_PARENT_POLICY_FIELDS.map((field) => `old.${field} IS NOT new.${field}`).join(' OR ');
      for (const operation of ['DELETE', 'UPDATE'] as const) {
        const predicate = operation === 'UPDATE' ? `WHEN ${changed}` : '';
        const anchors = operation === 'UPDATE' ? 'old.anchor,new.anchor' : 'old.anchor';
        const name = `vector_${tables.generationId}_parent_physical_${operation}`;
        db.exec(`DROP TRIGGER IF EXISTS main.${name}`);
        db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${name} AFTER ${operation} ON main.evidence_docs ${predicate}
          BEGIN INSERT INTO ${queue}(passage_key) SELECT json_array(doc_anchor,passage_id) FROM evidence_passages WHERE doc_anchor IN (${anchors}); DELETE FROM ${queue}; END`);
      }
      for (const operation of ['INSERT', 'UPDATE'] as const) {
        const name = `vector_${tables.generationId}_suppression_physical_${operation}`;
        db.exec(`DROP TRIGGER IF EXISTS main.${name}`);
        db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${name} AFTER ${operation} ON main.message_recall_index_suppressions
          BEGIN DELETE FROM ${table} WHERE passage_key=json_array(new.doc_anchor,new.passage_id); END`);
      }
    }
    if (kind === 'documents')
      for (const operation of ['INSERT', 'UPDATE'] as const) {
        const name = `vector_${tables.generationId}_document_suppression_physical_${operation}`;
        db.exec(`CREATE TEMP TRIGGER IF NOT EXISTS ${name} AFTER ${operation} ON main.message_recall_index_suppressions
        BEGIN DELETE FROM ${table} WHERE anchor=new.doc_anchor; END`);
      }
    db.exec(`CREATE TEMP TABLE IF NOT EXISTS ${marker}(ready INTEGER NOT NULL)`);
  })();
}

/** Flush only facts recorded while a native backend was unavailable, before publishing it. */
export function reconcileGenerationInvalidations(db: Database.Database, input: VectorGenerationTables): void {
  const tables = validateVectorGenerationTables(input);
  db.transaction(() => {
    for (const kind of ['documents', 'passages'] as const) {
      const source = kind === 'documents' ? tables.documentSources : tables.passageSources;
      const key = kind === 'documents' ? 'anchor' : 'passage_key';
      const exists = db.prepare('SELECT 1 FROM sqlite_master WHERE name=?');
      if (!exists.get(source) || !exists.get(tables[kind])) continue;
      db.exec(
        `DELETE FROM ${tables[kind]} WHERE ${key} IN (SELECT ${key} FROM ${source} WHERE revision_hash='invalidated')`,
      );
      db.exec(`DELETE FROM ${source} WHERE revision_hash='invalidated'`);
    }
    if (generationInvalidationState(db, tables).quarantined) {
      advanceEpoch(db, tables);
      db.prepare(`DELETE FROM ${tables.metadata} WHERE key=?`).run(QUARANTINE);
    }
  })();
}
