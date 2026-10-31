import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

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
        if (failure === 'vector-error')
          store.setEmbedDeps({
            mode: 'on',
            embedding: {
              isReady: () => true,
              reprobeIfNeeded: async () => {},
              embed: async () => {
                throw new Error('vector offline');
              },
            },
            vectorStore: { search: () => [] },
          });
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
