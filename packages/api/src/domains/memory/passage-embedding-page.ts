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
  /** Restricts the page to these row ids: rows an earlier walk found without a vector and could not embed. */
  onlyIds?: readonly number[],
): { lastId: number; metadataRows: number; passages: PassageEmbeddingRow[]; skippedIds: number[] } | undefined {
  const where = ['id > ?'];
  const params: unknown[] = [lastId];
  if (docAnchors?.length) {
    where.push(`doc_anchor IN (${docAnchors.map(() => '?').join(',')})`);
    params.push(...docAnchors);
  }
  if (onlyIds) {
    where.push(`id IN (${onlyIds.map(() => '?').join(',')})`);
    params.push(...onlyIds);
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
  const embeddable = passages.filter((passage) => passage.sourceSnapshot);
  // Without a vector and not embeddable now: no parent document, or a withdrawn message. Such a row
  // can become embeddable later without changing, so the caller keeps its id to look at it again.
  const taken = new Set(embeddable.map((passage) => passageVectorKey(passage.docAnchor, passage.passageId)));
  const skippedIds = missing
    .filter((row) => !taken.has(passageVectorKey(row.docAnchor, row.passageId)))
    .map((row) => row.id);
  return { lastId: last.id, metadataRows: rows.length, passages: embeddable, skippedIds };
}
