import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EmbedModelInfo } from './interfaces.js';
import { generationIdentity, missingVectorSource, vectorIdentityMatches } from './vector-generation-identity.js';
import { generationInvalidationState } from './vector-generation-invalidation.js';
import { generationVectorTableMatches, vectorGenerationTables } from './vector-generation-tables.js';
import { ELIGIBLE_VECTOR_PASSAGE } from './vector-source-fields.js';

export interface VectorGenerationCoverage {
  ready: boolean;
  sourceCutHash?: string;
  documents: number;
  passages: number;
  missingDocuments: number;
  missingPassages: number;
  orphanDocuments: number;
  orphanPassages: number;
}

export function inspectVectorGeneration(
  db: Database.Database,
  model: EmbedModelInfo,
  options: { allowBuilding?: boolean } = {},
): VectorGenerationCoverage {
  const read = () => inspectSnapshot(db, model, options);
  return db.inTransaction ? read() : db.transaction(read).deferred();
}

function inspectSnapshot(
  db: Database.Database,
  model: EmbedModelInfo,
  options: { allowBuilding?: boolean },
): VectorGenerationCoverage {
  const tables = vectorGenerationTables(model.generationId ?? 'g0');
  const count = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
  const documents = count('SELECT count(*) AS n FROM evidence_docs');
  const passages = count(`SELECT count(*) AS n FROM evidence_passages p WHERE ${ELIGIBLE_VECTOR_PASSAGE}`);
  const absent: VectorGenerationCoverage = {
    ready: false,
    documents,
    passages,
    missingDocuments: documents,
    missingPassages: passages,
    orphanDocuments: 0,
    orphanPassages: 0,
  };
  if (
    !generationVectorTableMatches(db, model.dim, 'documents', tables) ||
    !generationVectorTableMatches(db, model.dim, 'passages', tables)
  )
    return absent;
  if (generationInvalidationState(db, tables).quarantined) return absent;
  if (!vectorIdentityMatches(db, model)) return absent;
  const registry = db.prepare('SELECT fingerprint,state FROM vector_generations WHERE id=?').get(tables.generationId) as
    | { fingerprint: string; state: string }
    | undefined;
  const meta = db
    .prepare(`SELECT value FROM ${tables.metadata} WHERE key='embedding_representation_fingerprint'`)
    .get() as { value: string } | undefined;
  if (
    tables.generationId === 'g1' &&
    ((!options.allowBuilding && registry?.state !== 'ready') ||
      !model.representationFingerprint ||
      registry?.fingerprint !== model.representationFingerprint ||
      meta?.value !== model.representationFingerprint)
  )
    return absent;
  const missingDocuments = count(`SELECT count(*) AS n FROM evidence_docs d
    LEFT JOIN ${tables.documentSources} s ON s.anchor=d.anchor
    LEFT JOIN ${tables.documents}_rowids v ON v.id=d.anchor
    WHERE ${missingVectorSource('documents', tables.generationId)}`);
  const missingPassages = count(`SELECT count(*) AS n FROM evidence_passages p
    LEFT JOIN ${tables.passageSources} s ON s.passage_key=json_array(p.doc_anchor,p.passage_id)
    LEFT JOIN ${tables.passages}_rowids v ON v.id=json_array(p.doc_anchor,p.passage_id)
    WHERE (${ELIGIBLE_VECTOR_PASSAGE}) AND (${missingVectorSource('passages', tables.generationId)})`);
  const orphanDocuments = count(
    `SELECT count(*) AS n FROM ${tables.documents}_rowids v LEFT JOIN evidence_docs d ON d.anchor=v.id WHERE d.anchor IS NULL`,
  );
  const orphanPassages = count(`SELECT count(*) AS n FROM ${tables.passages}_rowids v LEFT JOIN evidence_passages p
    ON json_valid(v.id) AND p.doc_anchor=CASE WHEN json_valid(v.id) THEN json_extract(v.id,'$[0]') END
    AND p.passage_id=CASE WHEN json_valid(v.id) THEN json_extract(v.id,'$[1]') END WHERE p.id IS NULL OR NOT (${ELIGIBLE_VECTOR_PASSAGE})`);
  const ready = missingDocuments + missingPassages + orphanDocuments + orphanPassages === 0;
  let sourceCutHash: string | undefined;
  if (ready) {
    const digest = createHash('sha256').update(generationIdentity(model));
    for (const row of db
      .prepare(
        `SELECT 'document' AS kind,d.anchor AS key,s.revision_hash AS revision FROM evidence_docs d LEFT JOIN ${tables.documentSources} s ON s.anchor=d.anchor ORDER BY d.anchor`,
      )
      .iterate())
      digest.update(JSON.stringify(row) + '\n');
    for (const row of db
      .prepare(
        `SELECT 'passage' AS kind,json_array(p.doc_anchor,p.passage_id) AS key,s.revision_hash AS revision FROM evidence_passages p LEFT JOIN ${tables.passageSources} s ON s.passage_key=json_array(p.doc_anchor,p.passage_id) WHERE ${ELIGIBLE_VECTOR_PASSAGE} ORDER BY p.doc_anchor,p.passage_id`,
      )
      .iterate())
      digest.update(JSON.stringify(row) + '\n');
    sourceCutHash = digest.digest('hex');
  }
  return {
    ready,
    ...(sourceCutHash ? { sourceCutHash } : {}),
    documents,
    passages,
    missingDocuments,
    missingPassages,
    orphanDocuments,
    orphanPassages,
  };
}

/** Physical vector presence records prior enablement; an empty ordinary source table does not. */
export function hasVectorGeneration(db: Database.Database): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE name IN ('evidence_vectors','evidence_vectors_g1','passage_vectors','passage_vectors_g1') AND type='table' LIMIT 1",
      )
      .get(),
  );
}
