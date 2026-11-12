import type { EmbedModelInfo, IEmbeddingService } from './interfaces.js';
import { runMemoryVectorGenerationRead } from './MemoryProcess.js';
import { openVectorGeneration, type VectorBackend } from './open-vector-generation.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import { generationIdentity } from './vector-generation-identity.js';
import { inspectStoreVectorGeneration, reconcileStoreVectorGeneration } from './vector-generation-inspection.js';
import {
  deleteStillOrphanedVectors,
  type PendingVectorSources,
  readPendingVectorSources,
} from './vector-generation-pending.js';
import type { VectorGenerationCoverage } from './vector-generation-readiness.js';
import { captureVectorSource, commitVectorSource } from './vector-source-binding.js';

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
      await this.store.runExclusive(() => {
        signal.throwIfAborted();
        if (!isCurrent()) throw new Error('Shadow encoder retired');
        return reconcileStoreVectorGeneration(this.store, model, { signal, deadlineAt: options.deadlineAt });
      });
      let committed = 0;
      let batches = 0;
      let pending: PendingVectorSources | undefined;
      for (let batch = 0; batch < options.maxBatches; batch++) {
        signal.throwIfAborted();
        if (!isCurrent()) throw new Error('Shadow encoder retired');
        if (
          !pending ||
          (!pending.sources.length && !pending.orphanDocuments.length && !pending.orphanPassages.length)
        ) {
          const limit = Math.min(64, batchSize * (options.maxBatches - batch));
          // One bounded candidate page serves several encoder batches. Expensive
          // anti-joins run in the existing killable maintenance child, outside
          // the writer queue and never on the API connection for file stores.
          pending = this.store.usesIsolatedProcesses()
            ? await runMemoryVectorGenerationRead<PendingVectorSources>(
                { kind: 'vector-generation-read', operation: 'pending', dbPath: this.store.getDb().name, model, limit },
                { signal, deadlineAt: options.deadlineAt },
              )
            : readPendingVectorSources(this.store.getDb(), model, limit);
          signal.throwIfAborted();
        }
        if (!pending.sources.length && !pending.orphanDocuments.length && !pending.orphanPassages.length) break;
        const page = pending;
        const sources = await Promise.race([
          this.store.runExclusive(() => {
            if (!isCurrent()) throw new Error('Shadow encoder retired');
            deleteStillOrphanedVectors(this.store.getDb(), backend, {
              orphanDocuments: page.orphanDocuments.splice(0, batchSize),
              orphanPassages: page.orphanPassages.splice(0, batchSize),
            });
            // A queued page is never authority to encode a forgotten, revoked
            // or changed source. Retain the ordinary post-encode CAS as well.
            return page.sources
              .splice(0, batchSize)
              .filter(
                (source) =>
                  captureVectorSource(this.store.getDb(), source.kind, source.key)?.revisionHash ===
                  source.revisionHash,
              );
          }),
          aborted,
        ]);
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
        this.store.runExclusive(async () => {
          const proof = await inspectStoreVectorGeneration(this.store, model, {
            allowBuilding: true,
            signal,
            deadlineAt: options.deadlineAt,
          });
          return this.store
            .getDb()
            .transaction(() => {
              signal.throwIfAborted();
              if (!isCurrent()) throw new Error('Shadow encoder retired');
              const coverage: VectorGenerationCoverage = proof.isCurrent()
                ? proof.coverage
                : { ...proof.coverage, ready: false, sourceCutHash: undefined, reason: 'concurrent_mutation' };
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
            })
            .immediate();
        }),
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
        const backend = openVectorGeneration(db, model, { create: true, reconcile: false });
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
}
