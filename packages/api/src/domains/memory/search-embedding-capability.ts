import type { IEmbeddingService } from './interfaces.js';
import { queryEmbeddingInput } from './query-embedding-input.js';

export type SearchEmbeddingCapability = IEmbeddingService & {
  embedQueries: IEmbeddingService['embed'];
  isCurrent(): boolean;
  assertCurrent(): void;
};

/** A borrowed query capability; provider readiness cannot reopen a retired projection. */
export function createSearchEmbeddingCapability(
  embedding: IEmbeddingService,
  isCurrent: () => boolean,
): SearchEmbeddingCapability {
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error('Vector projection is not ready');
  };
  const embed: IEmbeddingService['embed'] = async (texts, signal) => {
    assertCurrent();
    const vectors = await embedding.embed(texts, signal);
    assertCurrent();
    return vectors;
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
    // Parent RPC forwarding also borrows this capability. Its payload was
    // prepared by the worker query boundary and must remain byte-for-byte raw.
    embed,
    async embedQueries(texts, signal) {
      assertCurrent();
      const modelId = embedding.getModelInfo().modelId;
      return embed(
        texts.map((text) => queryEmbeddingInput(text, modelId)),
        signal,
      );
    },
    isReady: () => isCurrent() && embedding.isReady(),
    getModelInfo: () => embedding.getModelInfo(),
    dispose() {}, // The lifecycle owns the provider.
  };
}
