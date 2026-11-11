import type { EmbedModelInfo, IEmbeddingService } from './interfaces.js';
import { openVectorGeneration, type VectorBackend } from './open-vector-generation.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import { generationIdentity, missingVectorSource } from './vector-generation-identity.js';
import { inspectVectorGeneration, type VectorGenerationCoverage } from './vector-generation-readiness.js';
import { captureVectorSource, commitVectorSource, type VectorSourceSnapshot } from './vector-source-binding.js';
import { ELIGIBLE_VECTOR_PASSAGE } from './vector-source-fields.js';

export interface ShadowBuildOptions {
  signal?: AbortSignal;
  deadlineAt: number;
  maxBatches: number;
  batchSize?: number;
}

/** Explicit work over the original writer queue. Construction never starts it. */
export class ShadowVectorGenerationBuilder {
  constructor(
    private readonly store: SqliteEvidenceStore,
    private readonly embedding: IEmbeddingService,
    private readonly loadProvider = true,
  ) {}

  async build(
    options: ShadowBuildOptions,
  ): Promise<VectorGenerationCoverage & { status: 'ready' | 'paused'; committed: number; batches: number }> {
    const batchSize = options.batchSize ?? 2;
    if (
      !Number.isSafeInteger(batchSize) ||
      batchSize < 1 ||
      batchSize > 8 ||
      !Number.isSafeInteger(options.maxBatches) ||
      options.maxBatches < 1 ||
      !Number.isFinite(options.deadlineAt)
    )
      throw new Error('Invalid bounded shadow build');
    const controller = new AbortController();
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const timer = setTimeout(
      () => controller.abort(new DOMException('Shadow build deadline exceeded', 'TimeoutError')),
      Math.max(0, options.deadlineAt - Date.now()),
    );
    if (Date.now() >= options.deadlineAt)
      controller.abort(new DOMException('Shadow build deadline exceeded', 'TimeoutError'));
    const signal = controller.signal;
    let rejectAborted!: (reason: unknown) => void;
    const aborted = new Promise<never>((_, reject) => {
      rejectAborted = reject;
    });
    const reject = () => rejectAborted(signal.reason);
    signal.addEventListener('abort', reject, { once: true });
    // Always handle the losing branch, including a late uncooperative provider.
    void aborted.catch(() => {});
    try {
      signal.throwIfAborted();
      if (this.loadProvider) await Promise.race([this.embedding.load(signal), aborted]);
      signal.throwIfAborted();
      if (!this.embedding.isReady()) throw new Error('Shadow encoder is not ready');
      const model = structuredClone(this.embedding.getModelInfo());
      model.generationId ??= 'g0';
      if (
        (model.generationId ?? 'g0') === 'g1' &&
        (!model.representationFingerprint || !/^[a-f0-9]{64}$/.test(model.representationFingerprint))
      )
        throw new Error('Shadow generation requires a complete representation identity');
      const signature = JSON.stringify(this.embedding.getModelInfo());
      const isCurrent = () =>
        !signal.aborted &&
        Date.now() < options.deadlineAt &&
        this.embedding.isReady() &&
        JSON.stringify(this.embedding.getModelInfo()) === signature;
      const backend = await Promise.race([this.prepare(model, isCurrent), aborted]);
      let committed = 0;
      let batches = 0;
      for (let batch = 0; batch < options.maxBatches; batch++) {
        signal.throwIfAborted();
        if (!isCurrent()) throw new Error('Shadow encoder retired');
        const pending = await Promise.race([
          this.store.runExclusive(() => {
            if (!isCurrent()) throw new Error('Shadow encoder retired');
            return this.readPending(backend, batchSize);
          }),
          aborted,
        ]);
        const { sources, cleaned } = pending;
        if (!sources.length && !cleaned) break;
        batches++;
        if (!sources.length) continue;
        const vectors = await Promise.race([
          this.embedding.embed(
            sources.map((source) => source.text),
            signal,
          ),
          aborted,
        ]);
        signal.throwIfAborted();
        if (!isCurrent()) throw new Error('Shadow encoder retired');
        if (vectors.length !== sources.length) throw new Error('Incomplete shadow encoder batch');
        committed += await Promise.race([
          this.store.runExclusive(() => {
            if (!isCurrent()) return 0;
            const db = this.store.getDb();
            return db.transaction(() => {
              const registry = db
                .prepare('SELECT fingerprint FROM vector_generations WHERE id=?')
                .get(backend.vectorStore.tables.generationId) as { fingerprint: string } | undefined;
              if (registry?.fingerprint !== generationIdentity(model)) throw new Error('Shadow generation changed');
              let n = 0;
              for (let i = 0; i < sources.length; i++) {
                const target = sources[i].kind === 'documents' ? backend.vectorStore : backend.passageVectorStore;
                if (commitVectorSource(db, target, sources[i], vectors[i], model)) n++;
              }
              return n;
            })();
          }),
          aborted,
        ]);
        // Permit normal query/ingest admission between finite writer transactions.
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      return await Promise.race([
        this.store.runExclusive(() =>
          this.store.getDb().transaction(() => {
            signal.throwIfAborted();
            if (!isCurrent()) throw new Error('Shadow encoder retired');
            const coverage = inspectVectorGeneration(this.store.getDb(), model, { allowBuilding: true });
            if (coverage.ready)
              this.store.getDb().transaction(() => {
                this.store
                  .getDb()
                  .prepare("UPDATE vector_generations SET state='ready' WHERE id=? AND fingerprint=?")
                  .run(backend.vectorStore.tables.generationId, generationIdentity(model));
                this.store
                  .getDb()
                  .prepare(
                    `INSERT OR REPLACE INTO ${backend.vectorStore.tables.metadata}(key,value) VALUES('last_verified_source_cut_hash',?)`,
                  )
                  .run(coverage.sourceCutHash!);
              })();
            return {
              ...coverage,
              committed,
              batches,
              status: coverage.ready ? ('ready' as const) : ('paused' as const),
            };
          })(),
        ),
        aborted,
      ]);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      signal.removeEventListener('abort', reject);
      controller.abort(new DOMException('Shadow build scope closed', 'AbortError'));
    }
  }

  private prepare(model: EmbedModelInfo, isCurrent: () => boolean): Promise<VectorBackend> {
    return this.store.runExclusive(() => {
      if (!isCurrent()) throw new Error('Shadow encoder retired before writer admission');
      const db = this.store.getDb();
      return db.transaction(() => {
        const existing = db.prepare('SELECT fingerprint FROM vector_generations WHERE id=?').get(model.generationId) as
          | { fingerprint: string }
          | undefined;
        if (existing && existing.fingerprint !== generationIdentity(model))
          throw new Error('Cannot reuse a generation with another representation');
        const backend = openVectorGeneration(db, model, { create: true });
        const meta = backend.vectorStore.getMeta();
        if (meta.embedding_model_id && !backend.vectorStore.checkMetaConsistency(model).consistent)
          throw new Error('Cannot overwrite another generation identity');
        backend.vectorStore.initMeta(model);
        db.prepare(
          "INSERT INTO vector_generations(id,fingerprint,state) VALUES(?,?,'building') ON CONFLICT(id) DO NOTHING",
        ).run(model.generationId, generationIdentity(model));
        return backend;
      })();
    });
  }

  private readPending(backend: VectorBackend, limit: number): { sources: VectorSourceSnapshot[]; cleaned: number } {
    const db = this.store.getDb();
    const tables = backend.vectorStore.tables;
    const orphanDocs = db
      .prepare(
        `SELECT v.id AS key FROM ${tables.documents}_rowids v LEFT JOIN evidence_docs d ON d.anchor=v.id WHERE d.anchor IS NULL LIMIT ?`,
      )
      .all(limit) as Array<{ key: string }>;
    const orphanPassages = db
      .prepare(
        `SELECT v.id AS key FROM ${tables.passages}_rowids v LEFT JOIN evidence_passages p ON p.doc_anchor=CASE WHEN json_valid(v.id) THEN json_extract(v.id,'$[0]') END AND p.passage_id=CASE WHEN json_valid(v.id) THEN json_extract(v.id,'$[1]') END WHERE p.id IS NULL OR NOT (${ELIGIBLE_VECTOR_PASSAGE}) LIMIT ?`,
      )
      .all(limit) as Array<{ key: string }>;
    db.transaction(() => {
      for (const { key } of orphanDocs) {
        backend.vectorStore.delete(key);
        db.prepare(`DELETE FROM ${tables.documentSources} WHERE anchor=?`).run(key);
      }
      for (const { key } of orphanPassages) {
        backend.passageVectorStore.delete(key);
        db.prepare(`DELETE FROM ${tables.passageSources} WHERE passage_key=?`).run(key);
      }
    })();
    const docs = db
      .prepare(`SELECT d.anchor AS key FROM evidence_docs d
      LEFT JOIN ${tables.documentSources} s ON s.anchor=d.anchor LEFT JOIN ${tables.documents}_rowids v ON v.id=d.anchor
      WHERE ${missingVectorSource('documents', tables.generationId)} ORDER BY d.anchor LIMIT ?`)
      .all(limit) as Array<{ key: string }>;
    const sources = docs.flatMap((row) => {
      const source = captureVectorSource(db, 'documents', row.key);
      return source ? [source] : [];
    });
    const cleaned = orphanDocs.length + orphanPassages.length;
    if (sources.length === limit) return { sources, cleaned };
    const passages = db
      .prepare(`SELECT json_array(p.doc_anchor,p.passage_id) AS key FROM evidence_passages p
      LEFT JOIN ${tables.passageSources} s ON s.passage_key=json_array(p.doc_anchor,p.passage_id)
      LEFT JOIN ${tables.passages}_rowids v ON v.id=json_array(p.doc_anchor,p.passage_id)
      WHERE (${ELIGIBLE_VECTOR_PASSAGE}) AND (${missingVectorSource('passages', tables.generationId)}) ORDER BY p.id LIMIT ?`)
      .all(limit - sources.length) as Array<{ key: string }>;
    for (const row of passages) {
      const source = captureVectorSource(db, 'passages', row.key);
      if (source) sources.push(source);
    }
    return { sources, cleaned };
  }
}
