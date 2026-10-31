import type { IEmbeddingService } from './interfaces.js';

export type SearchEmbeddingCapability = IEmbeddingService & { isCurrent(): boolean; assertCurrent(): void };

/** A borrowed query capability; provider readiness cannot reopen a retired projection. */
export function createSearchEmbeddingCapability(
  embedding: IEmbeddingService,
  isCurrent: () => boolean,
): SearchEmbeddingCapability {
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error('Vector projection is not ready');
  };
  return {
    isCurrent,
    assertCurrent,
    async load(signal) {
      assertCurrent();
      await embedding.load(signal);
      assertCurrent();
    },
    async reprobeIfNeeded(signal) {
      assertCurrent();
      await embedding.reprobeIfNeeded(signal);
      assertCurrent();
    },
    async embed(texts, signal) {
      assertCurrent();
      const vectors = await embedding.embed(texts, signal);
      assertCurrent();
      return vectors;
    },
    isReady: () => isCurrent() && embedding.isReady(),
    getModelInfo: () => embedding.getModelInfo(),
    dispose() {}, // The lifecycle owns the provider.
  };
}
