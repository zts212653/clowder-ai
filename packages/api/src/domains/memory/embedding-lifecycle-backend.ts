import { type EmbeddingDeployment, resolveRetainedG0Endpoint } from './embedding-generation-config.js';
import type { EmbedConfig, EmbedModelInfo, IEmbeddingService } from './interfaces.js';
import type { EmbeddingActivationFailure } from './MemoryEmbeddingLifecycle.js';
import { openVectorGeneration, type VectorBackend } from './open-vector-generation.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import { vectorIdentityMatches } from './vector-generation-identity.js';
import {
  prepareGenerationInvalidationConnection,
  reconcileGenerationInvalidations,
} from './vector-generation-invalidation.js';
import { inspectVectorGeneration } from './vector-generation-readiness.js';
import { vectorGenerationTables } from './vector-generation-tables.js';

export class VectorBackendUnavailableError extends Error {
  constructor(readonly reason: EmbeddingActivationFailure) {
    super(reason);
  }
}

export async function initializeVectorBackend(
  store: SqliteEvidenceStore,
  dim: number,
  model?: EmbedModelInfo,
): Promise<VectorBackend> {
  try {
    const backend = openVectorGeneration(store.getDb(), model ?? { modelId: 'unknown', modelRev: 'unknown', dim }, {
      create: !model?.generationId || model.generationId === 'g0',
    });
    // Preserve existing sparse-layout maintenance, scoped to the proposed fixed table.
    try {
      await store.repackPassageVectors({ generationId: model?.generationId ?? 'g0' });
    } catch {
      /* Optional layout maintenance. */
    }
    return backend;
  } catch {
    throw new VectorBackendUnavailableError('vector_table_unavailable');
  }
}

/** Produces a verified cohort, never publishes or selects it. The lifecycle remains sole owner. */
export async function prepareLifecycleBindings(
  stores: SqliteEvidenceStore[],
  model: EmbedModelInfo,
  initialize: (store: SqliteEvidenceStore, dim: number, model?: EmbedModelInfo) => Promise<VectorBackend>,
  isCurrent: () => boolean,
  enabledStores: () => SqliteEvidenceStore[],
  coverageRequired = true,
): Promise<Map<SqliteEvidenceStore, VectorBackend> | undefined> {
  const bindings = new Map<SqliteEvidenceStore, VectorBackend>();
  for (const store of stores) {
    if (typeof store.getDb === 'function')
      await store.runExclusive(() => {
        prepareGenerationInvalidationConnection(store.getDb());
        const tables = vectorGenerationTables(model.generationId ?? 'g0');
        if (store.getDb().prepare('SELECT 1 FROM sqlite_master WHERE name=?').get(tables.documents))
          reconcileGenerationInvalidations(store.getDb(), tables);
      });
    if (!isCurrent()) return;
    if (coverageRequired && !inspectVectorGeneration(store.getDb(), model).ready)
      throw new VectorBackendUnavailableError('generation_not_ready');
    const backend = await initialize(store, model.dim, model);
    if (!coverageRequired && !vectorIdentityMatches(store.getDb(), model)) backend.vectorStore.initMeta(model);
    bindings.set(store, backend);
    if (!isCurrent()) return;
  }
  const current = enabledStores();
  if (current.length !== stores.length || current.some((store) => !bindings.has(store)))
    throw new VectorBackendUnavailableError('generation_not_ready');
  if (
    stores.some((store) =>
      coverageRequired
        ? !inspectVectorGeneration(store.getDb(), model).ready
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
