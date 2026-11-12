import type { IEmbeddingService } from './interfaces.js';
import type { PassageVectorStore } from './PassageVectorStore.js';
import { prepareDocumentVectors } from './prepare-document-vectors.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import type { VectorStore } from './VectorStore.js';
import { inspectVectorGeneration } from './vector-generation-readiness.js';
import { captureVectorSource, commitVectorSource } from './vector-source-binding.js';

interface CurrentDocumentDeps {
  embedding: IEmbeddingService;
  vectorStore: VectorStore;
  passageVectorStore?: PassageVectorStore;
}

/** All regular index producers share source capture, owned admission and atomic proof writes. */
export async function embedCurrentDocuments(
  store: SqliteEvidenceStore,
  deps: CurrentDocumentDeps,
  pendingAnchors: Set<string>,
  ownsBinding: () => boolean,
  force = false,
): Promise<number> {
  const { embedding, vectorStore } = deps;
  await embedding.reprobeIfNeeded();
  const model = structuredClone(embedding.getModelInfo());
  const signature = JSON.stringify(model);
  const isCurrent = () => {
    try {
      return ownsBinding() && embedding.isReady() && JSON.stringify(embedding.getModelInfo()) === signature;
    } catch {
      return false;
    }
  };
  if (!isCurrent()) return 0;
  if (model.generationId === 'g1')
    await store.runExclusive(() => {
      if (!isCurrent()) return;
      const db = store.getDb();
      const existing = db.prepare('SELECT fingerprint FROM vector_generations WHERE id=?').get('g1') as
        | { fingerprint: string }
        | undefined;
      if (!model.representationFingerprint || (existing && existing.fingerprint !== model.representationFingerprint))
        throw new Error('Generation representation changed');
      db.prepare(
        "INSERT INTO vector_generations(id,fingerprint,state) VALUES('g1',?,'building') ON CONFLICT(id) DO NOTHING",
      ).run(model.representationFingerprint);
    });
  if (!isCurrent()) return 0;
  const pending = await prepareDocumentVectors(store, deps, pendingAnchors, isCurrent, force);
  let committed = 0;
  for (let offset = 0; offset < pending.length; offset += 8) {
    if (!isCurrent()) break;
    const sources = pending.slice(offset, offset + 8).flatMap((key) => {
      const source = captureVectorSource(store.getDb(), 'documents', key);
      return source ? [source] : [];
    });
    if (!sources.length) continue;
    const vectors = await embedding.embed(sources.map((source) => source.text));
    if (vectors.length !== sources.length) throw new Error('Incomplete document encoder batch');
    committed += await store.runExclusive(() => {
      if (!isCurrent()) return 0;
      return store.getDb().transaction(() => {
        let n = 0;
        for (let i = 0; i < sources.length; i++)
          if (commitVectorSource(store.getDb(), vectorStore, sources[i], vectors[i], model)) {
            pendingAnchors.delete(sources[i].key);
            n++;
          }
        return n;
      })();
    });
  }
  if (model.generationId === 'g1')
    await store.runExclusive(() => {
      if (isCurrent() && inspectVectorGeneration(store.getDb(), model, { allowBuilding: true }).ready)
        store
          .getDb()
          .prepare("UPDATE vector_generations SET state='ready' WHERE id='g1' AND fingerprint=?")
          .run(model.representationFingerprint);
    });
  return committed;
}
