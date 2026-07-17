import { EmbeddingService } from './EmbeddingService.js';
import { IndexBuilder } from './IndexBuilder.js';
import type { EmbedConfig, IEmbeddingService } from './interfaces.js';
import { PassageVectorStore } from './PassageVectorStore.js';
import { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import { ensurePassageVectorTable, ensureVectorTable } from './schema.js';
import { VectorStore } from './VectorStore.js';

export type EmbeddingRuntimeMode = EmbedConfig['embedMode'];
export type ActiveEmbeddingRuntimeMode = Exclude<EmbeddingRuntimeMode, 'off'>;
export type EmbeddingRuntimeStatus = 'off' | 'activating' | 'configured' | 'ready' | 'degraded';
export type EmbeddingActivationFailure = 'service_not_ready' | 'sqlite_vec_unavailable' | 'vector_table_unavailable';

export interface EmbeddingActivationResult {
  ok: boolean;
  status: EmbeddingRuntimeStatus;
  mode: EmbeddingRuntimeMode;
  reason?: EmbeddingActivationFailure;
}

interface VectorBackend {
  vectorStore: VectorStore;
  passageVectorStore: PassageVectorStore;
}

interface MemoryEmbeddingLifecycleOptions {
  createEmbeddingService?: (config: EmbedConfig) => IEmbeddingService;
  initializeVectorBackend?: (store: SqliteEvidenceStore, dim: number) => Promise<VectorBackend>;
  getDependentStores?: () => Iterable<SqliteEvidenceStore>;
}

class VectorBackendUnavailableError extends Error {
  constructor(readonly reason: EmbeddingActivationFailure) {
    super(reason);
  }
}

async function initializeVectorBackend(store: SqliteEvidenceStore, dim: number): Promise<VectorBackend> {
  try {
    const sqliteVec = await import('sqlite-vec');
    sqliteVec.load(store.getDb());
  } catch {
    throw new VectorBackendUnavailableError('sqlite_vec_unavailable');
  }

  const documentTableReady = ensureVectorTable(store.getDb(), dim);
  const passageTableReady = ensurePassageVectorTable(store.getDb(), dim);
  if (!documentTableReady || !passageTableReady) {
    throw new VectorBackendUnavailableError('vector_table_unavailable');
  }

  return {
    vectorStore: new VectorStore(store.getDb(), dim),
    passageVectorStore: new PassageVectorStore(store.getDb(), dim),
  };
}

/**
 * Owns the process-local projection from persisted embedding intent to live
 * memory dependencies. It does not persist configuration or delete vectors.
 */
export class MemoryEmbeddingLifecycle {
  private mode: EmbeddingRuntimeMode = 'off';
  private status: EmbeddingRuntimeStatus = 'off';
  private reason: EmbeddingActivationFailure | undefined;
  private service: IEmbeddingService | undefined;
  private vectorStore: VectorStore | undefined;
  private passageVectorStore: PassageVectorStore | undefined;
  private activation: Promise<EmbeddingActivationResult> | undefined;
  private generation = 0;
  private readonly createEmbeddingService: (config: EmbedConfig) => IEmbeddingService;
  private readonly initializeVectorBackend: (store: SqliteEvidenceStore, dim: number) => Promise<VectorBackend>;
  private readonly getDependentStores: () => Iterable<SqliteEvidenceStore>;

  constructor(
    private readonly store: SqliteEvidenceStore,
    private readonly indexBuilder: IndexBuilder,
    private readonly config: EmbedConfig,
    options: MemoryEmbeddingLifecycleOptions = {},
  ) {
    this.createEmbeddingService =
      options.createEmbeddingService ?? ((embedConfig) => new EmbeddingService(embedConfig));
    this.initializeVectorBackend = options.initializeVectorBackend ?? initializeVectorBackend;
    this.getDependentStores = options.getDependentStores ?? (() => [store]);
  }

  activate(mode: ActiveEmbeddingRuntimeMode): Promise<EmbeddingActivationResult> {
    this.mode = mode;
    this.reason = undefined;

    if (this.status === 'ready' && this.service && this.vectorStore && this.passageVectorStore) {
      this.bindDependencies();
      return Promise.resolve(this.snapshot(true));
    }
    if (this.activation) return this.activation;

    const generation = ++this.generation;
    this.status = 'activating';
    const activation = this.activateOnce(generation).finally(() => {
      if (this.activation === activation) this.activation = undefined;
    });
    this.activation = activation;
    return activation;
  }

  deactivate(): void {
    this.generation++;
    this.activation = undefined;
    this.mode = 'off';
    this.status = 'off';
    this.reason = undefined;
    this.clearDependencies();
    this.service?.dispose();
    this.service = undefined;
    this.vectorStore = undefined;
    this.passageVectorStore = undefined;
  }

  getMode(): EmbeddingRuntimeMode {
    return this.mode;
  }

  getStatus(): EmbeddingRuntimeStatus {
    return this.status;
  }

  getFailureReason(): EmbeddingActivationFailure | undefined {
    return this.reason;
  }

  getService(): IEmbeddingService | undefined {
    return this.service;
  }

  getVectorStore(): VectorStore | undefined {
    return this.vectorStore;
  }

  getPassageVectorStore(): PassageVectorStore | undefined {
    return this.passageVectorStore;
  }

  private async activateOnce(generation: number): Promise<EmbeddingActivationResult> {
    const service = this.service ?? this.createEmbeddingService(this.config);
    this.service = service;
    try {
      await service.load();
    } catch {
      // A provider implementation may throw even though the built-in HTTP
      // client is fail-open. Normalize both paths to configured/not-ready.
    }

    if (!this.isCurrent(generation)) {
      service.dispose();
      return this.snapshot(false);
    }
    if (!service.isReady()) {
      this.status = 'configured';
      this.reason = 'service_not_ready';
      return this.snapshot(false);
    }

    try {
      const backend = await this.initializeVectorBackend(this.store, this.config.embedDim);
      if (!this.isCurrent(generation)) {
        service.dispose();
        return this.snapshot(false);
      }
      this.vectorStore = backend.vectorStore;
      this.passageVectorStore = backend.passageVectorStore;
      this.bindDependencies();
      this.status = 'ready';
      this.reason = undefined;
      return this.snapshot(true);
    } catch (error) {
      if (!this.isCurrent(generation)) return this.snapshot(false);
      this.status = 'degraded';
      this.reason = error instanceof VectorBackendUnavailableError ? error.reason : 'sqlite_vec_unavailable';
      this.vectorStore = undefined;
      this.passageVectorStore = undefined;
      this.clearDependencies();
      return this.snapshot(false);
    }
  }

  private bindDependencies(): void {
    if (!this.service || !this.vectorStore || !this.passageVectorStore || this.mode === 'off') return;
    const deps = {
      embedding: this.service,
      vectorStore: this.vectorStore,
      passageVectorStore: this.passageVectorStore,
    };
    this.indexBuilder.setEmbedDeps(deps);
    this.store.setEmbedDeps({ ...deps, mode: this.mode });
  }

  private clearDependencies(): void {
    this.indexBuilder.setEmbedDeps(undefined);
    const stores = new Set<SqliteEvidenceStore>([this.store]);
    for (const store of this.getDependentStores()) stores.add(store);
    for (const store of stores) store.setEmbedDeps(undefined);
  }

  private isCurrent(generation: number): boolean {
    return this.generation === generation && this.mode !== 'off';
  }

  private snapshot(ok: boolean): EmbeddingActivationResult {
    return {
      ok,
      status: this.status,
      mode: this.mode,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }
}
