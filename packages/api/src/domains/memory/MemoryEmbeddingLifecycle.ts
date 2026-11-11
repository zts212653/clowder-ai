import { EmbeddingService } from './EmbeddingService.js';
import { inspectCohortRecovery, requiresCohortCoverage, resetLegacyCohort } from './embedding-cohort-recovery.js';
import {
  type EmbeddingDeployment,
  generationEmbedConfig,
  readEmbeddingDeployment,
  requireLoopbackEmbeddingEndpoint,
} from './embedding-generation-config.js';
import {
  initializeVectorBackend,
  loadLegacyEmbeddingService,
  prepareLifecycleBindings,
  VectorBackendUnavailableError,
} from './embedding-lifecycle-backend.js';
import { IndexBuilder } from './IndexBuilder.js';
import type { EmbedConfig, EmbedModelInfo, IEmbeddingService } from './interfaces.js';
import type { VectorBackend } from './open-vector-generation.js';
import { PassageVectorStore } from './PassageVectorStore.js';
import type { ShadowBuildOptions } from './ShadowVectorGenerationBuilder.js';
import { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import { type ShadowGenerationResult, startShadowGenerationWork } from './shadow-generation-work.js';
import { VectorStore } from './VectorStore.js';
import { generationInvalidationState } from './vector-generation-invalidation.js';
import { hasVectorGeneration } from './vector-generation-readiness.js';

export type EmbeddingRuntimeMode = EmbedConfig['embedMode'];
export type ActiveEmbeddingRuntimeMode = Exclude<EmbeddingRuntimeMode, 'off'>;
export type EmbeddingRuntimeStatus = 'off' | 'activating' | 'configured' | 'ready' | 'degraded';
export type EmbeddingActivationFailure =
  | 'service_not_ready'
  | 'sqlite_vec_unavailable'
  | 'vector_table_unavailable'
  | 'generation_not_ready'
  | 'legacy_provider_not_ready';

export interface EmbeddingActivationResult {
  ok: boolean;
  status: EmbeddingRuntimeStatus;
  mode: EmbeddingRuntimeMode;
  reason?: EmbeddingActivationFailure;
}

interface MemoryEmbeddingLifecycleOptions {
  createEmbeddingService?: (config: EmbedConfig) => IEmbeddingService;
  initializeVectorBackend?: (store: SqliteEvidenceStore, dim: number, model?: EmbedModelInfo) => Promise<VectorBackend>;
  getDeployment?: () => EmbeddingDeployment;
  requireLegacyConsumer?: boolean;
  getDependentStores?: () => Iterable<SqliteEvidenceStore>;
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
  private catchUp: Promise<{ docsEmbedded: number; durationMs: number }> | undefined;
  private recoveryTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private activeConfig?: EmbedConfig;
  private activationKey?: string;
  private shadowWork?: { controller: AbortController; result: Promise<ShadowGenerationResult> };
  private readonly services = new Map<string, IEmbeddingService>();
  private readonly serviceConfigs = new Map<string, string>();
  private legacyConsumerService?: IEmbeddingService;
  private bindings = new Map<SqliteEvidenceStore, VectorBackend>();
  private readonly getDeployment: () => EmbeddingDeployment;
  private readonly requireLegacyConsumer: boolean;
  private readonly createEmbeddingService: (config: EmbedConfig) => IEmbeddingService;
  private readonly initializeVectorBackend: (
    store: SqliteEvidenceStore,
    dim: number,
    model?: EmbedModelInfo,
  ) => Promise<VectorBackend>;
  private readonly getDependentStores: () => Iterable<SqliteEvidenceStore>;

  constructor(
    private readonly store: SqliteEvidenceStore,
    private readonly indexBuilder: IndexBuilder,
    private readonly config: EmbedConfig,
    options: MemoryEmbeddingLifecycleOptions = {},
  ) {
    this.getDeployment = options.getDeployment ?? readEmbeddingDeployment;
    this.requireLegacyConsumer = options.requireLegacyConsumer ?? false;
    this.createEmbeddingService =
      options.createEmbeddingService ?? ((embedConfig) => new EmbeddingService(embedConfig));
    this.initializeVectorBackend = options.initializeVectorBackend ?? initializeVectorBackend;
    this.getDependentStores = options.getDependentStores ?? (() => [store]);
  }

  activate(
    mode: ActiveEmbeddingRuntimeMode,
    options: { rebuildLegacyModel?: string } = {},
  ): Promise<EmbeddingActivationResult> {
    this.mode = mode;
    this.reason = undefined;
    let config: EmbedConfig;
    try {
      config = generationEmbedConfig(this.config, this.getDeployment());
      if (config.generationId === 'g0' && options.rebuildLegacyModel) config.embedModel = options.rebuildLegacyModel;
    } catch {
      this.reason = 'generation_not_ready';
      if (!this.service) this.status = 'configured';
      return Promise.resolve(this.snapshot(false));
    }
    if (config.generationId === 'g1') this.legacyConsumerService?.pinLoadedEndpoint?.();
    const key = JSON.stringify([config, Boolean(options.rebuildLegacyModel)]);
    if (this.activation && this.activationKey === key) return this.activation;
    this.stopShadowBuild();
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    const generation = ++this.generation;
    this.activationKey = key;
    if (!this.service?.isReady()) this.status = 'activating';
    const activation = this.activateOnce(generation, config, Boolean(options.rebuildLegacyModel)).finally(() => {
      if (this.activation === activation) this.activation = undefined;
    });
    this.activation = activation;
    return activation;
  }

  deactivate(options: { retainLegacy?: boolean } = {}): void {
    const retained =
      options.retainLegacy && (this.service?.getModelInfo().generationId === 'g1' || !this.service)
        ? this.legacyConsumerService
        : undefined;
    this.stopShadowBuild();
    this.generation++;
    this.activation = undefined;
    this.catchUp = undefined;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    this.mode = 'off';
    this.status = 'off';
    this.reason = undefined;
    this.clearDependencies();
    for (const service of new Set([
      ...this.services.values(),
      ...(this.service ? [this.service] : []),
      ...(this.legacyConsumerService ? [this.legacyConsumerService] : []),
    ]))
      if (service !== retained) service.dispose();
    this.services.clear();
    this.serviceConfigs.clear();
    this.legacyConsumerService = retained;
    if (retained) this.services.set('g0', retained);
    this.bindings.clear();
    this.activeConfig = undefined;
    this.service = undefined;
    this.vectorStore = undefined;
    this.passageVectorStore = undefined;
  }

  getMode(): EmbeddingRuntimeMode {
    return this.mode;
  }

  getStatus(): EmbeddingRuntimeStatus {
    if (
      this.status === 'ready' &&
      (!this.service?.isReady() ||
        [...this.bindings].some(([store, backend]) => {
          try {
            return generationInvalidationState(store.getDb(), backend.vectorStore.tables).quarantined;
          } catch {
            return true;
          }
        }))
    )
      return 'degraded';
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

  /** Explicit operator work only: selecting/configuring a generation never calls this. */
  buildShadowGeneration(options: ShadowBuildOptions & { embedUrl: string }): Promise<ShadowGenerationResult> {
    if (this.shadowWork) return Promise.reject(new Error('A shadow build is already running'));
    const deployment = this.getDeployment();
    const target = deployment.buildTargetId;
    if (target !== 'g1' || this.service?.getModelInfo().generationId === target)
      return Promise.reject(new Error('Cannot shadow-build the active generation'));
    const config = generationEmbedConfig(this.config, deployment, target);
    config.embedUrl = requireLoopbackEmbeddingEndpoint(options.embedUrl);
    const stores = this.enabledStores();
    const cohortIsCurrent = () => {
      const current = this.enabledStores();
      return current.length === stores.length && current.every((store) => stores.includes(store));
    };
    const scope = startShadowGenerationWork(stores, this.createEmbeddingService(config), options, cohortIsCurrent);
    const result = scope.result.finally(() => {
      if (this.shadowWork?.controller === scope.controller) this.shadowWork = undefined;
    });
    this.shadowWork = { controller: scope.controller, result };
    return result;
  }

  stopShadowBuild(): void {
    this.shadowWork?.controller.abort(new DOMException('Shadow build stopped', 'AbortError'));
  }

  getGenerationStatus(): { desired: string; effective?: string; building: boolean } {
    let desired = 'unknown';
    try {
      desired = this.getDeployment().activeId;
    } catch {
      /* Invalid intent cannot become effective. */
    }
    return {
      desired,
      ...(this.service ? { effective: this.service.getModelInfo().generationId ?? 'g0' } : {}),
      building: Boolean(this.shadowWork),
    };
  }

  catchUpAfterReady(): Promise<{ docsEmbedded: number; durationMs: number }> {
    if (this.catchUp) return this.catchUp;
    clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
    const catchUp = this.catchUpOnce(this.generation).finally(() => {
      if (this.catchUp === catchUp) this.catchUp = undefined;
    });
    this.catchUp = catchUp;
    return catchUp;
  }

  private async catchUpOnce(generation: number): Promise<{ docsEmbedded: number; durationMs: number }> {
    try {
      return await this.indexBuilder.embedMissingDocumentVectors();
    } catch (error) {
      this.scheduleRecovery(generation);
      throw error;
    } finally {
      // A document timeout cannot suppress this independent accelerator. The
      // builder already coalesces passage work; retired generations start none.
      if (this.generation === generation) this.indexBuilder.startPassageEmbeddingWarmup();
    }
  }

  private scheduleRecovery(generation: number, recover: () => Promise<unknown> = () => this.catchUpAfterReady()): void {
    if (!this.isCurrent(generation) || this.recoveryTimer) return;
    // Reuse the startup/reprobe cadence. Source stamps select only unfinished
    // current documents; no lexical rescan, force rebuild or second queue.
    this.recoveryTimer = setTimeout(() => {
      this.recoveryTimer = undefined;
      if (!this.isCurrent(generation)) return;
      void recover().catch(() => {
        if (!this.isCurrent(generation)) return;
        console.warn('[memory] document vector recovery failed; retrying in 30s');
      });
    }, 30_000);
    this.recoveryTimer.unref();
  }

  private enabledStores(): SqliteEvidenceStore[] {
    return [...new Set([this.store, ...this.getDependentStores()])].filter(
      (store) => store === this.store || (typeof store.getDb === 'function' && hasVectorGeneration(store.getDb())),
    );
  }

  private async activateOnce(
    generation: number,
    config: EmbedConfig,
    rebuildLegacy: boolean,
  ): Promise<EmbeddingActivationResult> {
    const id = config.generationId ?? 'g0';
    const service =
      id === 'g0' &&
      this.legacyConsumerService &&
      this.legacyConsumerService.getModelInfo().modelId === config.embedModel &&
      this.legacyConsumerService.getModelInfo().dim === config.embedDim
        ? this.legacyConsumerService
        : this.activeConfig && JSON.stringify(this.activeConfig) === JSON.stringify(config)
          ? this.service!
          : ((this.serviceConfigs.get(id) === JSON.stringify(config) ? this.services.get(id) : undefined) ??
            this.createEmbeddingService(config));
    try {
      await service.load();
    } catch {
      /* Existing unavailable-provider semantics. */
    }
    if (!this.isCurrent(generation)) {
      if (service !== this.service && ![...this.services.values()].includes(service)) service.dispose();
      return this.snapshot(false);
    }
    const fail = (reason: EmbeddingActivationFailure): EmbeddingActivationResult => {
      if (service !== this.service && ![...this.services.values()].includes(service)) service.dispose();
      this.reason = reason;
      if (!this.service?.isReady()) {
        this.status = reason === 'service_not_ready' ? 'configured' : 'degraded';
        this.clearDependencies();
      }
      return this.snapshot(false);
    };
    if (!service.isReady()) return fail('service_not_ready');
    try {
      if (id !== 'g0' && this.requireLegacyConsumer && !(await this.ensureLegacyConsumer(generation))) {
        if (!this.isCurrent(generation)) {
          if (service !== this.service) service.dispose();
          return this.snapshot(false);
        }
        return fail('legacy_provider_not_ready');
      }
      if (!this.isCurrent(generation)) return this.snapshot(false);
      const model = service.getModelInfo();
      if (
        (model.generationId ?? 'g0') !== id ||
        (id === 'g0' && rebuildLegacy && model.modelId !== config.embedModel) ||
        model.dim !== config.embedDim ||
        (config.representationFingerprint && model.representationFingerprint !== config.representationFingerprint)
      )
        return fail('generation_not_ready');
      const stores = this.enabledStores();
      const coverageRequired = requiresCohortCoverage(stores, model);
      const recovery = await inspectCohortRecovery(
        stores,
        model,
        rebuildLegacy,
        () => this.isCurrent(generation),
        coverageRequired,
      );
      if (!this.isCurrent(generation)) return this.snapshot(false);
      if (recovery === 'blocked') return fail('generation_not_ready');
      if (recovery === 'repair') {
        this.indexBuilder.setEmbedDeps(undefined);
        for (const store of new Set([...stores, ...this.bindings.keys()])) store.setEmbedDeps(undefined);
        this.status = 'degraded';
        if (id === 'g0' && rebuildLegacy) await resetLegacyCohort(stores, model, () => this.isCurrent(generation));
        const currentCohort = () => {
          const current = this.enabledStores();
          return (
            this.isCurrent(generation) &&
            current.length === stores.length &&
            current.every((store) => stores.includes(store))
          );
        };
        const scope = startShadowGenerationWork(
          stores,
          service,
          { deadlineAt: Date.now() + 15_000, maxBatches: 8, batchSize: 2 },
          currentCohort,
          false,
        );
        this.shadowWork = scope;
        let repaired: ShadowGenerationResult;
        try {
          repaired = await scope.result;
        } finally {
          if (this.shadowWork === scope) this.shadowWork = undefined;
        }
        if (!this.isCurrent(generation)) return this.snapshot(false);
        if (repaired.status !== 'ready') {
          this.scheduleRecovery(generation, () =>
            this.activate(this.mode as ActiveEmbeddingRuntimeMode, {
              rebuildLegacyModel: rebuildLegacy ? config.embedModel : undefined,
            }),
          );
          return fail('generation_not_ready');
        }
      }
      const bindings = await prepareLifecycleBindings(
        stores,
        model,
        this.initializeVectorBackend,
        () => this.isCurrent(generation),
        () => this.enabledStores(),
        coverageRequired,
      );
      if (!bindings) {
        if (service !== this.service) service.dispose();
        return this.snapshot(false);
      }
      if (id !== 'g0') this.legacyConsumerService?.pinLoadedEndpoint?.();
      this.service = service;
      const previous = this.services.get(id);
      if (id === 'g0' && !this.legacyConsumerService) this.legacyConsumerService = service;
      this.services.set(id, service);
      this.serviceConfigs.set(id, JSON.stringify(config));
      if (previous && previous !== service && previous !== this.legacyConsumerService) previous.dispose();
      this.activeConfig = config;
      this.bindings = bindings;
      const backend = bindings.get(this.store)!;
      this.vectorStore = backend.vectorStore;
      this.passageVectorStore = backend.passageVectorStore;
      this.bindDependencies();
      this.status = 'ready';
      this.reason = undefined;
      return this.snapshot(true);
    } catch (error) {
      if (this.isCurrent(generation) && this.status === 'degraded')
        this.scheduleRecovery(generation, () =>
          this.activate(this.mode as ActiveEmbeddingRuntimeMode, {
            rebuildLegacyModel: rebuildLegacy ? config.embedModel : undefined,
          }),
        );
      return fail(
        error instanceof VectorBackendUnavailableError
          ? error.reason
          : id === 'g0'
            ? 'sqlite_vec_unavailable'
            : 'generation_not_ready',
      );
    }
  }

  /** Preserve the original G0 provider for borrowed non-index consumers. */
  getLegacyConsumerService(): IEmbeddingService | undefined {
    return this.legacyConsumerService;
  }

  private async ensureLegacyConsumer(generation: number): Promise<boolean> {
    const retained = this.legacyConsumerService;
    if (retained) {
      retained.pinLoadedEndpoint?.();
      try {
        await retained.load();
      } catch {
        return false;
      }
      if (!this.isCurrent(generation)) {
        if (this.legacyConsumerService !== retained) retained.dispose();
        return false;
      }
      return retained.isReady();
    }
    const candidate = await loadLegacyEmbeddingService(
      this.store,
      this.config,
      this.createEmbeddingService,
      () => this.isCurrent(generation),
      this.getDeployment(),
    );
    if (!candidate) return false;
    this.legacyConsumerService = candidate;
    this.services.set('g0', candidate);
    return true;
  }

  private bindDependencies(): void {
    if (!this.service || !this.vectorStore || !this.passageVectorStore || this.mode === 'off') return;
    this.indexBuilder.setEmbedDeps({
      embedding: this.service,
      vectorStore: this.vectorStore,
      passageVectorStore: this.passageVectorStore,
    });
    for (const [store, backend] of this.bindings) {
      const publish = store.invalidateVectorProjection();
      store.setEmbedDeps({ embedding: this.service, ...backend, mode: this.mode });
      publish();
    }
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
      status: this.getStatus(),
      mode: this.mode,
      ...(this.reason ? { reason: this.reason } : {}),
    };
  }
}
