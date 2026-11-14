import type Database from 'better-sqlite3';
import type { EmbedModelInfo } from './interfaces.js';
import { type VectorBackend } from './open-vector-generation.js';
import { parsePassageVectorKey } from './PassageVectorStore.js';
import { missingVectorSource } from './vector-generation-identity.js';
import { vectorGenerationTables } from './vector-generation-tables.js';
import { captureVectorSource, type VectorSourceSnapshot } from './vector-source-binding.js';
import { ELIGIBLE_VECTOR_PASSAGE } from './vector-source-fields.js';

export interface PendingVectorSources {
  sources: VectorSourceSnapshot[];
  orphanDocuments: string[];
  orphanPassages: string[];
}

/** A bounded read-only page. File stores execute the complete snapshot in the killable maintenance child. */
export function readPendingVectorSources(
  db: Database.Database,
  model: EmbedModelInfo,
  limit: number,
): PendingVectorSources {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) throw new Error('Invalid vector recovery page');
  const tables = vectorGenerationTables(model.generationId ?? 'g0');
  const keys = (sql: string, n = limit) => (db.prepare(sql).all(n) as Array<{ key: string }>).map((row) => row.key);
  return db
    .transaction(() => {
      const orphanDocuments = keys(`SELECT v.id AS key FROM ${tables.documents}_rowids v
      LEFT JOIN evidence_docs d ON d.anchor=v.id WHERE d.anchor IS NULL LIMIT ?`);
      const orphanPassages = keys(`SELECT v.id AS key FROM ${tables.passages}_rowids v
      LEFT JOIN evidence_passages p ON p.doc_anchor=CASE WHEN json_valid(v.id) THEN json_extract(v.id,'$[0]') END
      AND p.passage_id=CASE WHEN json_valid(v.id) THEN json_extract(v.id,'$[1]') END
      WHERE p.id IS NULL OR NOT (${ELIGIBLE_VECTOR_PASSAGE}) LIMIT ?`);
      const documents = keys(`SELECT d.anchor AS key FROM evidence_docs d
      LEFT JOIN ${tables.documentSources} s ON s.anchor=d.anchor LEFT JOIN ${tables.documents}_rowids v ON v.id=d.anchor
      WHERE ${missingVectorSource('documents', tables.generationId)} ORDER BY d.anchor LIMIT ?`);
      const sources = documents.flatMap((key) => {
        const source = captureVectorSource(db, 'documents', key);
        return source ? [source] : [];
      });
      if (sources.length < limit)
        for (const key of keys(
          `SELECT json_array(p.doc_anchor,p.passage_id) AS key FROM evidence_passages p
        LEFT JOIN ${tables.passageSources} s ON s.passage_key=json_array(p.doc_anchor,p.passage_id)
        LEFT JOIN ${tables.passages}_rowids v ON v.id=json_array(p.doc_anchor,p.passage_id)
        WHERE (${ELIGIBLE_VECTOR_PASSAGE}) AND (${missingVectorSource('passages', tables.generationId)})
        ORDER BY p.id LIMIT ?`,
          limit - sources.length,
        )) {
          const source = captureVectorSource(db, 'passages', key);
          if (source) sources.push(source);
        }
      return { sources, orphanDocuments, orphanPassages };
    })
    .deferred();
}

/** The original writer rechecks each key: a delayed read must never delete a newly live source. */
export function deleteStillOrphanedVectors(
  db: Database.Database,
  backend: VectorBackend,
  pending: Pick<PendingVectorSources, 'orphanDocuments' | 'orphanPassages'>,
): number {
  let cleaned = 0;
  db.transaction(() => {
    for (const key of pending.orphanDocuments) {
      if (db.prepare('SELECT 1 FROM evidence_docs WHERE anchor=?').get(key)) continue;
      backend.vectorStore.delete(key);
      db.prepare(`DELETE FROM ${backend.vectorStore.tables.documentSources} WHERE anchor=?`).run(key);
      cleaned++;
    }
    for (const key of pending.orphanPassages) {
      let parsed: ReturnType<typeof parsePassageVectorKey> | undefined;
      try {
        parsed = parsePassageVectorKey(key);
      } catch {
        // Malformed native keys cannot name a canonical passage.
      }
      const eligible =
        parsed &&
        db
          .prepare(`SELECT 1 FROM evidence_passages p
        WHERE p.doc_anchor=? AND p.passage_id=? AND (${ELIGIBLE_VECTOR_PASSAGE})`)
          .get(parsed.docAnchor, parsed.passageId);
      if (eligible) continue;
      backend.passageVectorStore.delete(key);
      db.prepare(`DELETE FROM ${backend.vectorStore.tables.passageSources} WHERE passage_key=?`).run(key);
      cleaned++;
    }
  })();
  return cleaned;
}
