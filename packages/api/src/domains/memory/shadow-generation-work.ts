import type { IEmbeddingService } from './interfaces.js';
import { type ShadowBuildOptions, ShadowVectorGenerationBuilder } from './ShadowVectorGenerationBuilder.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';

export interface ShadowGenerationResult {
  status: 'ready' | 'paused';
  stores: number;
  completedStores: number;
  committed: number;
}

/** Bounded serial work using the lifecycle's store cohort, provider and owned cancellation. */
export async function runShadowGenerationWork(
  stores: SqliteEvidenceStore[],
  embedding: IEmbeddingService,
  options: ShadowBuildOptions,
  cohortIsCurrent: () => boolean,
  loadProvider = true,
): Promise<ShadowGenerationResult> {
  let remaining = options.maxBatches;
  let committed = 0;
  let completedStores = 0;
  for (const store of stores) {
    options.signal?.throwIfAborted();
    if (!cohortIsCurrent() || !remaining) break;
    const result = await new ShadowVectorGenerationBuilder(store, embedding, loadProvider).build({
      ...options,
      maxBatches: remaining,
    });
    remaining -= result.batches;
    committed += result.committed;
    if (result.status === 'ready') completedStores++;
  }
  return {
    status: completedStores === stores.length && cohortIsCurrent() ? 'ready' : 'paused',
    stores: stores.length,
    completedStores,
    committed,
  };
}

/** A finite child scope; its controller stays in the lifecycle's single job slot. */
export function startShadowGenerationWork(
  stores: SqliteEvidenceStore[],
  embedding: IEmbeddingService,
  options: ShadowBuildOptions,
  cohortIsCurrent: () => boolean,
  disposeProvider = true,
): { controller: AbortController; result: Promise<ShadowGenerationResult> } {
  const controller = new AbortController();
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const result = runShadowGenerationWork(
    stores,
    embedding,
    { ...options, signal: controller.signal },
    () => !controller.signal.aborted && cohortIsCurrent(),
    disposeProvider,
  ).finally(() => {
    options.signal?.removeEventListener('abort', onAbort);
    if (disposeProvider) embedding.dispose();
  });
  return { controller, result };
}
