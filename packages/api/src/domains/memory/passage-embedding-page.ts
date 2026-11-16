import type Database from 'better-sqlite3';
import type { PassageEmbeddingRow } from './embed-utils.js';
import { type PassageVectorStore, passageVectorKey } from './PassageVectorStore.js';
import { capturePassageVectorSource } from './vector-source-binding.js';
import { ELIGIBLE_VECTOR_PASSAGE } from './vector-source-fields.js';

/** Inspect a bounded metadata page; only missing vectors require passage bodies. */
export function readPassageEmbeddingPage(
  db: Database.Database,
  vectors: PassageVectorStore,
  lastId: number,
  limit: number,
  docAnchors?: readonly string[],
): { lastId: number; metadataRows: number; passages: PassageEmbeddingRow[] } | undefined {
  const where = ['id > ?'];
  const params: unknown[] = [lastId];
  if (docAnchors?.length) {
    where.push(`doc_anchor IN (${docAnchors.map(() => '?').join(',')})`);
    params.push(...docAnchors);
  }
  const rows = db
    .prepare(`SELECT id, doc_anchor AS docAnchor, passage_id AS passageId
      FROM evidence_passages WHERE ${where.join(' AND ')} ORDER BY id LIMIT ?`)
    .all(...params, limit) as Array<{ id: number; docAnchor: string; passageId: string }>;
  const last = rows.at(-1);
  if (!last) return undefined;
  const existing = vectors.existingKeys(rows.map((row) => passageVectorKey(row.docAnchor, row.passageId)));
  const missing = rows.filter((row) => !existing.has(passageVectorKey(row.docAnchor, row.passageId)));
  const passages = missing.length
    ? (db
        .prepare(`SELECT p.doc_anchor AS docAnchor, p.passage_id AS passageId, p.content FROM evidence_passages p
          WHERE p.id IN (${missing.map(() => '?').join(',')}) AND (${ELIGIBLE_VECTOR_PASSAGE}) ORDER BY p.id`)
        .all(...missing.map(({ id }) => id)) as PassageEmbeddingRow[])
    : [];
  for (const passage of passages) passage.sourceSnapshot = capturePassageVectorSource(db, passage);
  return { lastId: last.id, metadataRows: rows.length, passages: passages.filter((passage) => passage.sourceSnapshot) };
}
