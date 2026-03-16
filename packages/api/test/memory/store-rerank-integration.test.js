import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

describe('SqliteEvidenceStore — semantic rerank integration', () => {
  let store;
  let vectorStore;
  let mockEmbedding;

  beforeEach(async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { VectorStore } = await import('../../dist/domains/memory/VectorStore.js');
    const { applyMigrations, ensureVectorTable } = await import('../../dist/domains/memory/schema.js');

    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    // Load sqlite-vec and create evidence_vectors on the store's DB
    const db = store.getDb();
    sqliteVec.load(db);
    ensureVectorTable(db, 4); // tiny dim for test
    vectorStore = new VectorStore(db, 4);

    // Mock embedding service
    let embedCallCount = 0;
    mockEmbedding = {
      isReady: () => true,
      embed: async (texts) => {
        embedCallCount++;
        // Return deterministic vectors based on text content
        return texts.map((t) => {
          if (t.includes('Memory')) return new Float32Array([1, 0, 0, 0]);
          if (t.includes('Arch')) return new Float32Array([0, 1, 0, 0]);
          if (t.includes('Gateway')) return new Float32Array([0, 0, 1, 0]);
          return new Float32Array([0.5, 0.5, 0.5, 0.5]);
        });
      },
      getModelInfo: () => ({ modelId: 'test', modelRev: 'v1', dim: 4 }),
      dispose: () => {},
      load: async () => {},
      getEmbedCallCount: () => embedCallCount,
    };
  });

  it('mode=on reranks results by vector distance', async () => {
    // All 3 docs contain "Memory" so FTS returns all of them
    // AC-C8: rerank only reorders FTS candidates, never adds new ones
    await store.upsert([
      {
        anchor: 'F102',
        kind: 'feature',
        status: 'active',
        title: 'Memory Refactor',
        summary: 'Memory system core',
        updatedAt: '2026-01-01',
      },
      {
        anchor: 'F042',
        kind: 'feature',
        status: 'active',
        title: 'Memory Architecture',
        summary: 'Memory arch decisions',
        updatedAt: '2026-01-01',
      },
      {
        anchor: 'F088',
        kind: 'feature',
        status: 'active',
        title: 'Memory Gateway',
        summary: 'Memory gateway service',
        updatedAt: '2026-01-01',
      },
    ]);

    // Vector distances: F042 closest → F102 mid → F088 farthest from query "Memory"
    vectorStore.upsert('F042', new Float32Array([0.9, 0.1, 0, 0])); // closest to [1,0,0,0]
    vectorStore.upsert('F102', new Float32Array([0.5, 0.5, 0, 0])); // mid
    vectorStore.upsert('F088', new Float32Array([0, 0, 1, 0])); // orthogonal = farthest

    store.setEmbedDeps({ embedding: mockEmbedding, vectorStore, mode: 'on' });

    const results = await store.search('Memory');
    assert.ok(results.length >= 3, `expected >=3 results, got ${results.length}`);
    // Reranked order by vector distance: F042 < F102 < F088
    const f042Idx = results.findIndex((r) => r.anchor === 'F042');
    const f088Idx = results.findIndex((r) => r.anchor === 'F088');
    assert.ok(f042Idx >= 0, 'F042 should be in results');
    assert.ok(f088Idx >= 0, 'F088 should be in results');
    assert.ok(f042Idx < f088Idx, 'F042 (closer vector) should rank before F088');
  });

  it('mode=off skips rerank entirely', async () => {
    await store.upsert([
      {
        anchor: 'F102',
        kind: 'feature',
        status: 'active',
        title: 'Memory Refactor',
        summary: 'Memory system',
        updatedAt: '2026-01-01',
      },
    ]);
    vectorStore.upsert('F102', new Float32Array([1, 0, 0, 0]));

    store.setEmbedDeps({ embedding: mockEmbedding, vectorStore, mode: 'off' });

    const results = await store.search('Memory');
    assert.equal(results.length, 1);
    assert.equal(results[0].anchor, 'F102');
  });

  it('fail-open: returns lexical results when embedding throws', async () => {
    await store.upsert([
      {
        anchor: 'F102',
        kind: 'feature',
        status: 'active',
        title: 'Memory Refactor',
        summary: 'Memory system',
        updatedAt: '2026-01-01',
      },
    ]);

    const brokenEmbedding = {
      ...mockEmbedding,
      embed: async () => {
        throw new Error('model crashed');
      },
    };
    store.setEmbedDeps({ embedding: brokenEmbedding, vectorStore, mode: 'on' });

    // Should NOT throw — fail-open returns lexical results
    const results = await store.search('Memory');
    assert.equal(results.length, 1);
    assert.equal(results[0].anchor, 'F102');
  });

  it('mode=shadow returns lexical order (does not rerank)', async () => {
    await store.upsert([
      {
        anchor: 'F102',
        kind: 'feature',
        status: 'active',
        title: 'Memory Refactor',
        summary: 'Memory',
        updatedAt: '2026-01-01',
      },
      {
        anchor: 'F042',
        kind: 'feature',
        status: 'active',
        title: 'Architecture Memory',
        summary: 'Arch',
        updatedAt: '2026-01-01',
      },
    ]);
    vectorStore.upsert('F042', new Float32Array([0.99, 0.01, 0, 0])); // very close
    vectorStore.upsert('F102', new Float32Array([0.01, 0.01, 0.99, 0])); // far

    store.setEmbedDeps({ embedding: mockEmbedding, vectorStore, mode: 'shadow' });

    const results = await store.search('Memory');
    // Shadow mode: should return lexical order (F102 title-match first),
    // NOT reranked order
    assert.ok(results.length >= 1);
    // FTS should put F102 first (exact title match with better BM25)
    // The key assertion: results are NOT reranked
    assert.equal(results[0].anchor, 'F102');
  });

  it('skips rerank when embedding not ready', async () => {
    await store.upsert([
      {
        anchor: 'F102',
        kind: 'feature',
        status: 'active',
        title: 'Memory Refactor',
        summary: 'Memory',
        updatedAt: '2026-01-01',
      },
    ]);

    const notReady = { ...mockEmbedding, isReady: () => false };
    store.setEmbedDeps({ embedding: notReady, vectorStore, mode: 'on' });

    const results = await store.search('Memory');
    assert.equal(results.length, 1);
    assert.equal(results[0].anchor, 'F102');
  });
});
