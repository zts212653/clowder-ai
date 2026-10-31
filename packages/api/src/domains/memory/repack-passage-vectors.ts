import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

export interface VectorRepackResult {
  status: 'packed' | 'unchanged' | 'unsupported';
  vectors: number;
  chunksBefore: number;
  chunksAfter: number;
}

/** Rebuild only the derived vec0 layout. Never change keys, floats, or the model.
 * sqlite-vec 0.1.9 resolves ties by ascending chunk, then descending offset.
 * Reverse each new chunk's insertion order to retain that exact priority. */
export function repackPassageVectors(db: Database.Database): VectorRepackResult {
  return db
    .transaction((): VectorRepackResult => {
      const layout = readVectorLayout(db);
      const { vectors, capacity } = layout;
      const result: VectorRepackResult = {
        status: 'unchanged',
        vectors,
        chunksBefore: layout.chunks,
        chunksAfter: layout.chunks,
      };
      if (!capacity || layout.chunks < 16 || layout.chunks <= 2 * Math.ceil(vectors / capacity)) return result;
      const schema = compatibleSchema(db, layout);
      if (!schema) return { ...result, status: 'unsupported' };
      stageVectorRows(db, capacity, vectors);
      replaceVectorProjection(db, schema, vectors);
      const chunksAfter = (db.prepare('SELECT count(*) AS n FROM passage_vectors_chunks').get() as { n: number }).n;
      return { ...result, status: 'packed', chunksAfter };
    })
    .immediate();
}

interface VectorLayout {
  chunks: number;
  capacity: number | null;
  maxCapacity: number | null;
  vectors: number;
}

function readVectorLayout(db: Database.Database): VectorLayout {
  const layout = db
    .prepare('SELECT count(*) AS chunks,min(size) AS capacity,max(size) AS maxCapacity FROM passage_vectors_chunks')
    .get() as Omit<VectorLayout, 'vectors'>;
  const vectors = (db.prepare('SELECT count(*) AS n FROM passage_vectors_rowids').get() as { n: number }).n;
  return { ...layout, vectors };
}

function compatibleSchema(db: Database.Database, layout: VectorLayout): string | undefined {
  const version = db.prepare('SELECT vec_version() AS version').get() as { version: string };
  const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='passage_vectors'").get() as { sql: string };
  if (
    version.version !== 'v0.1.9' ||
    layout.capacity !== layout.maxCapacity ||
    !/^CREATE VIRTUAL TABLE\s+passage_vectors\s+USING vec0\(\s*passage_key TEXT PRIMARY KEY,\s*embedding float\[\d+\]\s*\)$/i.test(
      schema.sql,
    )
  )
    return undefined;
  return schema.sql;
}

function stageVectorRows(db: Database.Database, capacity: number, vectors: number): void {
  db.exec(
    'CREATE TEMP TABLE passage_vector_repack (ordinal INTEGER PRIMARY KEY, passage_key TEXT UNIQUE, embedding BLOB)',
  );
  db.prepare(`
      INSERT INTO temp.passage_vector_repack(passage_key)
      SELECT id FROM (
        SELECT id,row_number() OVER (ORDER BY chunk_id,chunk_offset DESC) AS priority
        FROM passage_vectors_rowids
      ) ORDER BY (priority-1)/CAST(? AS INTEGER),priority DESC
    `).run(capacity);
  const keys = db.prepare(
    'SELECT ordinal,passage_key AS id FROM temp.passage_vector_repack WHERE ordinal>? ORDER BY ordinal LIMIT 1000',
  );
  const read = db.prepare('SELECT embedding FROM passage_vectors WHERE passage_key=?');
  const stage = db.prepare('UPDATE temp.passage_vector_repack SET embedding=? WHERE ordinal=?');
  let ordinal = 0;
  for (;;) {
    const page = keys.all(ordinal) as Array<{ ordinal: number; id: string }>;
    if (!page.length) break;
    for (const key of page) {
      const row = read.get(key.id) as { embedding: Buffer } | undefined;
      if (!row) throw new Error('Vector projection changed during repack');
      stage.run(row.embedding, key.ordinal);
      ordinal = key.ordinal;
    }
  }
  const staged = (db.prepare('SELECT count(*) AS n FROM temp.passage_vector_repack').get() as { n: number }).n;
  if (staged !== vectors) throw new Error('Vector repack count mismatch');
}

function replaceVectorProjection(db: Database.Database, schema: string, vectors: number): void {
  // vec0 has no xRename. Public DROP/CREATE plus INSERT share one transaction;
  // a failure or killed writer rolls back to the complete original projection.
  db.exec('DROP TABLE passage_vectors');
  db.exec(schema);
  db.exec(`INSERT INTO passage_vectors(passage_key,embedding)
      SELECT passage_key,embedding FROM temp.passage_vector_repack ORDER BY ordinal`);
  const copied = (db.prepare('SELECT count(*) AS n FROM passage_vectors_rowids').get() as { n: number }).n;
  if (copied !== vectors) throw new Error('Vector repack count mismatch');
  db.exec('DROP TABLE temp.passage_vector_repack');
}

/** A maintenance child opens the existing file; no migration or lifecycle writer. */
export function repackPassageVectorDatabase(dbPath: string): VectorRepackResult {
  const db = new Database(dbPath, { fileMustExist: true });
  try {
    db.pragma('busy_timeout=5000');
    db.pragma('temp_store=FILE');
    sqliteVec.load(db);
    return repackPassageVectors(db);
  } finally {
    db.close();
  }
}
