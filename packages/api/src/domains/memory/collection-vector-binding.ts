import type { CollectionEmbedDeps } from './CollectionIndexBuilder.js';
import { resetLegacyCohort } from './embedding-cohort-recovery.js';
import type { IEmbeddingService } from './interfaces.js';
import { openVectorGeneration } from './open-vector-generation.js';
import type { SqliteEvidenceStore } from './SqliteEvidenceStore.js';
import { inspectVectorGeneration } from './vector-generation-readiness.js';

/** A newly indexed collection borrows the current recipe; it cannot choose another active generation. */
export async function prepareCollectionVectorBinding(
  store: SqliteEvidenceStore,
  resolveService: () => IEmbeddingService | undefined,
  resolveMode: () => 'on' | 'shadow' | undefined = () => 'shadow',
): Promise<{ deps: CollectionEmbedDeps; publish: () => boolean } | undefined> {
  const service = resolveService();
  if (!service?.isReady() || !resolveMode()) return;
  const model = structuredClone(service.getModelInfo());
  const signature = JSON.stringify(model);
  const currentService = (): IEmbeddingService | undefined => {
    try {
      return resolveService() === service &&
        service.isReady() &&
        resolveMode() &&
        JSON.stringify(service.getModelInfo()) === signature
        ? service
        : undefined;
    } catch {
      return;
    }
  };
  // This is an explicit canonical/secret-admitted collection rebuild, borrowing
  // only the lifecycle's current provider; it cannot select another geometry.
  if ((model.generationId ?? 'g0') === 'g0') await resetLegacyCohort([store], model, () => Boolean(currentService()));
  const backend = await store.runExclusive(() => {
    if (!currentService()) return;
    return openVectorGeneration(store.getDb(), model, { create: true });
  });
  if (!backend || !currentService()) return;
  return {
    deps: { getEmbeddingService: currentService, vectorStore: backend.vectorStore },
    publish: () => {
      const mode = resolveMode();
      if (
        !currentService() ||
        !mode ||
        (model.generationId === 'g1' && !inspectVectorGeneration(store.getDb(), model).ready)
      ) {
        store.setEmbedDeps(undefined);
        return false;
      }
      store.setEmbedDeps({ embedding: service, ...backend, mode });
      return true;
    },
  };
}
