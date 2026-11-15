import { type EmbeddingDeployment, resolveRetainedG0Endpoint } from './embedding-generation-config.js';
import type { EmbedConfig, EmbedModelInfo, IEmbeddingService } from './interfaces.js';
import type { EmbeddingActivationFailure } from './MemoryEmbeddingLifecycle.js';
import { openVectorGeneration, type VectorBackend } from './open-vector-generation.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import { vectorIdentityMatches } from './vector-generation-identity.js';
import {
  type GenerationReadOptions,
  inspectStoreVectorGeneration,
  reconcileStoreVectorGeneration,
  type VectorCoverageProof,
} from './vector-generation-inspection.js';
import { prepareGenerationInvalidationConnection } from './vector-generation-invalidation.js';

export class VectorBackendUnavailableError extends Error {
  constructor(readonly reason: EmbeddingActivationFailure) {
    super(reason);
  }
}

export type VectorBackendInitializer = (
  store: SqliteEvidenceStore,
  dim: number,
  model: EmbedModelInfo,
  lifetime: GenerationReadOptions,
) => Promise<VectorBackend>;

function assertBackendLifetime(lifetime: GenerationReadOptions): void {
  lifetime.signal?.throwIfAborted();
  if (lifetime.deadlineAt !== undefined && Date.now() >= lifetime.deadlineAt)
    throw new VectorBackendUnavailableError('generation_not_ready');
}

export async function initializeVectorBackend(
  store: SqliteEvidenceStore,
  dim: number,
  model?: EmbedModelInfo,
  lifetime: GenerationReadOptions = {},
): Promise<VectorBackend> {
  try {
    assertBackendLifetime(lifetime);
    const backend = openVectorGeneration(store.getDb(), model ?? { modelId: 'unknown', modelRev: 'unknown', dim }, {
      create: !model?.generationId || model.generationId === 'g0',
      reconcile: !store.usesIsolatedProcesses(),
    });
    // Preserve existing sparse-layout maintenance, scoped to the proposed fixed table.
    try {
      await store.repackPassageVectors({
        generationId: model?.generationId ?? 'g0',
        signal: lifetime.signal,
        deadlineAt: lifetime.deadlineAt,
      });
    } catch {
      // Optional layout failure may retain the complete old projection;
      // cancellation/deadline may never turn into a successful activation.
      assertBackendLifetime(lifetime);
    }
    assertBackendLifetime(lifetime);
    return backend;
  } catch (error) {
    assertBackendLifetime(lifetime);
    if (error instanceof VectorBackendUnavailableError) throw error;
    throw new VectorBackendUnavailableError('vector_table_unavailable');
  }
}

/** Produces a verified cohort, never publishes or selects it. The lifecycle remains sole owner. */
export async function prepareLifecycleBindings(
  stores: SqliteEvidenceStore[],
  model: EmbedModelInfo,
  initialize: VectorBackendInitializer,
  isCurrent: () => boolean,
  enabledStores: () => SqliteEvidenceStore[],
  coverageRequired = true,
  lifetime: GenerationReadOptions = {},
): Promise<Map<SqliteEvidenceStore, VectorBackend> | undefined> {
  const bindings = new Map<SqliteEvidenceStore, VectorBackend>();
  const proofs = new Map<SqliteEvidenceStore, VectorCoverageProof>();
  for (const store of stores) {
    if (typeof store.getDb === 'function')
      await store.runExclusive(async () => {
        prepareGenerationInvalidationConnection(store.getDb());
        await reconcileStoreVectorGeneration(store, model, lifetime);
      });
    if (!isCurrent()) return;
    if (coverageRequired) {
      const proof = await store.runExclusive(() => inspectStoreVectorGeneration(store, model, lifetime));
      if (!proof.coverage.ready || !proof.isCurrent()) throw new VectorBackendUnavailableError('generation_not_ready');
      proofs.set(store, proof);
    }
    const backend = await initialize(store, model.dim, model, {
      ...lifetime,
      deadlineAt: lifetime.deadlineAt ?? Date.now() + 15_000,
    });
    if (!coverageRequired && !vectorIdentityMatches(store.getDb(), model)) backend.vectorStore.initMeta(model);
    bindings.set(store, backend);
    if (coverageRequired && !proofs.get(store)?.isCurrent())
      proofs.set(store, await store.runExclusive(() => inspectStoreVectorGeneration(store, model, lifetime)));
    if (!isCurrent()) return;
  }
  const current = enabledStores();
  if (current.length !== stores.length || current.some((store) => !bindings.has(store)))
    throw new VectorBackendUnavailableError('generation_not_ready');
  if (
    stores.some((store) =>
      coverageRequired
        ? !proofs.get(store)?.coverage.ready || !proofs.get(store)?.isCurrent()
        : !vectorIdentityMatches(store.getDb(), model),
    )
  )
    throw new VectorBackendUnavailableError('generation_not_ready');
  return bindings;
}

/** A cold G1 boot can borrow only a verified, explicitly addressed retained G0 provider. */
export async function loadLegacyEmbeddingService(
  store: SqliteEvidenceStore,
  base: EmbedConfig,
  create: (config: EmbedConfig) => IEmbeddingService,
  isCurrent: () => boolean,
  deployment: EmbeddingDeployment,
): Promise<IEmbeddingService | undefined> {
  const endpoint = resolveRetainedG0Endpoint(deployment);
  if (!endpoint) return;
  const meta = Object.fromEntries(
    (store.getDb().prepare('SELECT key,value FROM embedding_meta').all() as Array<{ key: string; value: string }>).map(
      (row) => [row.key, row.value],
    ),
  );
  const dim = Number(meta.embedding_dim);
  if (!meta.embedding_model_id || !Number.isSafeInteger(dim) || dim < 1) return;
  const candidate = create({
    ...base,
    embedModel: meta.embedding_model_id,
    embedDim: dim,
    generationId: 'g0',
    representationFingerprint: undefined,
    queryInstruction: undefined,
    embedModelRev: undefined,
    embedUrl: endpoint,
  });
  try {
    await candidate.load();
  } catch {
    candidate.dispose();
    return;
  }
  if (!isCurrent()) {
    candidate.dispose();
    return;
  }
  const model = candidate.getModelInfo();
  if (
    !candidate.isReady() ||
    model.modelId !== meta.embedding_model_id ||
    model.dim !== dim ||
    (model.generationId ?? 'g0') !== 'g0'
  ) {
    candidate.dispose();
    return;
  }
  candidate.pinLoadedEndpoint?.();
  return candidate;
}
