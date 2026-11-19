import { z } from 'zod';
import type { EmbedModelInfo, IEmbeddingService } from '../../memory/interfaces.js';
import { createSearchEmbeddingCapability } from '../../memory/search-embedding-capability.js';
import { currentPluginCallContext } from '../carrier/plugin-call-context.js';

const queryText = z.string().trim().min(1).max(2000);

export interface MemoryQueryEmbedding {
  model: Pick<EmbedModelInfo, 'modelId' | 'modelRev' | 'dim' | 'generationId' | 'representationFingerprint'>;
  vector: number[];
}

/** Borrow the existing provider for just the query authorized by the Host. */
export function createMemoryEmbeddingHost(options: {
  pluginInstanceId: string;
  assertActivation(): void;
  getEmbedding(): IEmbeddingService | undefined;
}) {
  return {
    async embedQuery(query: string): Promise<MemoryQueryEmbedding | null> {
      const text = queryText.parse(query);
      options.assertActivation();
      const caller = currentPluginCallContext(options.pluginInstanceId);
      if (!caller || caller.memorySearch?.query !== text) throw new Error('memory_embedding_access_denied');
      const { signal } = caller.memorySearch;
      signal?.throwIfAborted();
      await caller.assertCurrent();

      const service = options.getEmbedding();
      if (!service) return null;
      const embedding = createSearchEmbeddingCapability(service, () => options.getEmbedding() === service);
      let result: { model: EmbedModelInfo; vector: number[] } | undefined;
      try {
        await embedding.reprobeIfNeeded(signal);
        if (embedding.isReady()) {
          const model = { ...embedding.getModelInfo() };
          const [value] = await embedding.embedQueries([text], signal);
          if (value) result = { model, vector: Array.from(value) };
        }
      } catch {
        // An unavailable sidecar lets the worker take the existing lexical downgrade.
        signal?.throwIfAborted();
      }
      await caller.assertCurrent();
      signal?.throwIfAborted();
      options.assertActivation();
      if (
        !result ||
        !embedding.isReady() ||
        result.model.dim <= 0 ||
        result.vector.length !== result.model.dim ||
        !result.vector.every(Number.isFinite) ||
        JSON.stringify(embedding.getModelInfo()) !== JSON.stringify(result.model)
      ) {
        return null;
      }

      const { modelId, modelRev, dim, generationId, representationFingerprint } = result.model;
      return { model: { modelId, modelRev, dim, generationId, representationFingerprint }, vector: result.vector };
    },
  };
}
