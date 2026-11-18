import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';

const model = { modelId: 'degradation-fixture', modelRev: '1', dim: 3 };

for (const mode of ['semantic', 'hybrid']) {
  for (const failure of ['unavailable', 'vector-error']) {
    test(`summary ${mode} honestly reports ${failure} while retaining lexical results`, async () => {
      const store = new SqliteEvidenceStore(':memory:');
      await store.initialize();
      try {
        await store.upsert([
          {
            anchor: 'repair-note',
            kind: 'decision',
            status: 'active',
            title: 'piano repair',
            updatedAt: '2026-10-08T00:00:00Z',
          },
        ]);
        if (failure === 'vector-error') {
          new VectorStore(store.getDb(), model.dim).initMeta(model);
          store.setEmbedDeps({
            mode: 'on',
            embedding: {
              isReady: () => true,
              getModelInfo: () => model,
              reprobeIfNeeded: async () => {},
              embed: async () => {
                throw new Error('vector offline');
              },
            },
            vectorStore: { search: () => [] },
          });
        }
        const result = await store.searchWithMeta('piano', { mode });
        assert.deepEqual(
          result.items.map((item) => item.anchor),
          ['repair-note'],
        );
        assert.equal(result.meta.degraded, true);
        assert.equal(result.meta.effectiveMode, 'lexical');
        assert.equal(
          result.meta.degradeReason,
          failure === 'unavailable' ? 'passage_embedding_unavailable' : 'passage_vector_search_error',
        );
      } finally {
        store.close();
      }
    });
  }
}
