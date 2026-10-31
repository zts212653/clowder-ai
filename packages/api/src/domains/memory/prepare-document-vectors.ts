import type Database from 'better-sqlite3';
import type { IEmbeddingService } from './interfaces.js';
import type { PassageVectorStore } from './PassageVectorStore.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import type { VectorStore } from './VectorStore.js';

interface DocumentEmbeddingDeps {
  embedding: IEmbeddingService;
  vectorStore: VectorStore;
  passageVectorStore?: PassageVectorStore;
}

function prepareModel(db: Database.Database, deps: DocumentEmbeddingDeps) {
  const { embedding, vectorStore, passageVectorStore } = deps;
  const model = embedding.getModelInfo();
  const meta = vectorStore.getMeta();
  const hasVectors = vectorStore.count() > 0 || Boolean(passageVectorStore && passageVectorStore.count() > 0);
  const modelChanged = !vectorStore.checkMetaConsistency(model).consistent || (hasVectors && !meta.embedding_model_id);
  if (modelChanged) {
    vectorStore.clearAll();
    passageVectorStore?.clearAll();
    db.prepare('DELETE FROM document_vector_sources').run();
  }
  return model;
}

function prepareSources(
  db: Database.Database,
  vectorStore: VectorStore,
  pendingAnchors: ReadonlySet<string>,
  force: boolean,
): string[] {
  // Preparation needs hashes and membership only. Summaries are hydrated
  // later for each small provider batch, never for the warm corpus here.
  const rows = db
    .prepare(`SELECT d.anchor, d.source_hash AS sourceHash, s.source_hash AS vectorSourceHash
      FROM evidence_docs d LEFT JOIN document_vector_sources s ON s.anchor=d.anchor ORDER BY d.anchor`)
    .all() as Array<{ anchor: string; sourceHash: string | null; vectorSourceHash: string | null }>;
  const vectors = new Set(
    (db.prepare('SELECT anchor FROM evidence_vectors').all() as Array<{ anchor: string }>).map((row) => row.anchor),
  );
  const stamp = db.prepare('INSERT OR REPLACE INTO document_vector_sources (anchor, source_hash) VALUES (?, ?)');
  const unstamp = db.prepare('DELETE FROM document_vector_sources WHERE anchor=?');
  const pending: string[] = [];
  for (const row of rows) {
    const sourceHash = row.sourceHash ?? '';
    const hasVector = vectors.has(row.anchor);
    const sourcePending = pendingAnchors.has(row.anchor);
    // A model reset leaves no vectors to adopt. Otherwise retain the existing
    // V48 proof: unchanged indexed source and no canonical mutation pending.
    const adoptLegacy = !force && row.vectorSourceHash === null && hasVector && !sourcePending;
    if (adoptLegacy) {
      row.vectorSourceHash = sourceHash;
      stamp.run(row.anchor, row.vectorSourceHash);
    }
    const untrusted = sourcePending || row.vectorSourceHash !== sourceHash;
    if (untrusted && hasVector) vectorStore.delete(row.anchor);
    if (untrusted && row.vectorSourceHash !== null) unstamp.run(row.anchor);
    if (force || untrusted || !hasVector) pending.push(row.anchor);
  }
  return pending;
}

/** Validate persisted projections before either serving them or calling the provider. */
export function prepareDocumentVectors(
  store: SqliteEvidenceStore,
  deps: DocumentEmbeddingDeps,
  pendingAnchors: ReadonlySet<string>,
  isCurrent: () => boolean,
  force = false,
): Promise<string[]> {
  const publishProjection = store.invalidateVectorProjection();
  return store.runExclusive(() => {
    if (!isCurrent()) return [];
    const db = store.getDb();
    const pending = db.transaction(() => {
      const model = prepareModel(db, deps);
      const pending = prepareSources(db, deps.vectorStore, pendingAnchors, force);
      // This records model ownership, not completed source coverage. It also
      // keeps a later failed batch from resetting valid cold partial work.
      deps.vectorStore.initMeta(model);
      return pending;
    })();
    if (isCurrent()) publishProjection();
    return pending;
  });
}
