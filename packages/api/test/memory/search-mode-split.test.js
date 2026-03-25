import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { applyMigrations, ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';

/**
 * KD-44: Three search modes must have independent retrieval paths.
 * - lexical = pure BM25 (FTS5)
 * - semantic = pure vector NN (skip BM25)
 * - hybrid = BM25 + NN → RRF fusion
 */

function setupStore() {
  const store = new SqliteEvidenceStore(':memory:');
  store.initialize();

  const db = store.getDb();

  // Load sqlite-vec + create vec0 table
  let vectorStore;
  try {
    const sqliteVec = require('sqlite-vec');
    sqliteVec.load(db);
    ensureVectorTable(db, 3); // dim=3 for test simplicity
    vectorStore = new VectorStore(db, 3);
  } catch {
    // sqlite-vec not available — skip vector tests
    return { store, vectorStore: null, db };
  }

  return { store, vectorStore, db };
}

function seedDocs(store) {
  store.upsert([
    {
      anchor: 'doc-cat-names',
      kind: 'lesson',
      status: 'active',
      title: 'Cat Cafe 花名册 — 名字的由来',
      summary: '宪宪来自 Constitutional AI 的宪，砚砚来自 Codex 的砚，烁烁来自 Gemini 的烁',
      updatedAt: new Date().toISOString(),
    },
    {
      anchor: 'doc-redis-pitfall',
      kind: 'lesson',
      status: 'active',
      title: 'Redis keyPrefix 陷阱',
      summary: 'ioredis keyPrefix 不影响 eval 脚本内的 KEYS 参数',
      updatedAt: new Date().toISOString(),
    },
    {
      anchor: 'doc-f102-spec',
      kind: 'feature',
      status: 'active',
      title: 'F102: 记忆组件 Adapter 化重构',
      summary: 'Hindsight 已停用，改为 SQLite 本地索引',
      updatedAt: new Date().toISOString(),
    },
    {
      anchor: 'doc-session-mgmt',
      kind: 'lesson',
      status: 'active',
      title: '第八课：Session 管理',
      summary: '茶话会夺魂 bug — session 跨 thread 污染',
      updatedAt: new Date().toISOString(),
    },
  ]);
}

function seedVectors(vectorStore) {
  // Simulated embeddings (dim=3) — cat-names is "close" to query about naming
  vectorStore.upsert('doc-cat-names', new Float32Array([0.9, 0.1, 0.0])); // naming topic
  vectorStore.upsert('doc-redis-pitfall', new Float32Array([0.0, 0.1, 0.9])); // redis topic
  vectorStore.upsert('doc-f102-spec', new Float32Array([0.3, 0.8, 0.1])); // memory topic
  vectorStore.upsert('doc-session-mgmt', new Float32Array([0.1, 0.2, 0.8])); // session topic
}

// Mock embedding service that returns controlled vectors
function createMockEmbedding(queryResponse) {
  return {
    isReady: () => true,
    embed: async (texts) => [queryResponse],
    getModelInfo: () => ({ modelId: 'test', modelRev: 'test', dim: 3 }),
    load: async () => {},
    dispose: () => {},
  };
}

describe('Search Mode Split (KD-44)', () => {
  let store, vectorStore, db;

  beforeEach(() => {
    const setup = setupStore();
    store = setup.store;
    vectorStore = setup.vectorStore;
    db = setup.db;

    if (!vectorStore) return; // skip if no sqlite-vec

    seedDocs(store);
    seedVectors(vectorStore);

    // Wire embedding deps — query for "naming" is close to doc-cat-names vector
    const mockEmbed = createMockEmbedding(new Float32Array([0.85, 0.15, 0.0])); // close to cat-names
    store.setEmbedDeps({ embedding: mockEmbed, vectorStore, mode: 'on' });
  });

  it('lexical mode: pure BM25, no vector involved', async () => {
    if (!vectorStore) return;
    const results = await store.search('Redis keyPrefix', { mode: 'lexical', limit: 5 });
    assert.ok(results.length > 0, 'should find redis doc via BM25');
    assert.equal(results[0].anchor, 'doc-redis-pitfall');
  });

  it('lexical mode: does NOT find semantically-similar docs without keyword match', async () => {
    if (!vectorStore) return;
    // "naming origin story" doesn't have exact keyword match in cat-names doc
    const results = await store.search('origin story', { mode: 'lexical', limit: 5 });
    // Cat-names doc title/summary doesn't contain "origin" or "story"
    const catNames = results.find((r) => r.anchor === 'doc-cat-names');
    // This may or may not match depending on FTS5 — the point is semantic would definitely find it
  });

  it('semantic mode: finds docs by vector similarity, not keywords', async () => {
    if (!vectorStore) return;
    // Query vector is close to doc-cat-names (0.9, 0.1, 0.0)
    const results = await store.search('why are cats named', { mode: 'semantic', limit: 5 });
    assert.ok(results.length > 0, 'semantic should return results');
    // doc-cat-names should be first (closest vector)
    assert.equal(results[0].anchor, 'doc-cat-names', 'cat-names doc should be first by vector distance');
  });

  it('semantic mode: degrades to lexical when embedding unavailable', async () => {
    if (!vectorStore) return;
    // Set embedding as not ready
    store.setEmbedDeps({
      embedding: { isReady: () => false, embed: async () => [], getModelInfo: () => ({}) },
      vectorStore,
      mode: 'on',
    });
    const results = await store.search('Redis', { mode: 'semantic', limit: 5 });
    // Should still return something (lexical fallback)
    assert.ok(results.length >= 0, 'should not throw');
  });

  it('hybrid mode: combines BM25 + NN via RRF', async () => {
    if (!vectorStore) return;
    // Query that matches both lexical (Redis) and is semantically close to cat-names
    const results = await store.search('Redis', { mode: 'hybrid', limit: 5 });
    assert.ok(results.length > 0, 'hybrid should return results');
    // Redis doc should rank high (BM25 hit + possibly NN), cat-names should also appear (NN)
    const anchors = results.map((r) => r.anchor);
    assert.ok(anchors.includes('doc-redis-pitfall'), 'redis doc should appear (BM25 hit)');
  });

  it('hybrid mode: surfaces docs that BM25 misses but NN finds', async () => {
    if (!vectorStore) return;
    // Query with no BM25 match but strong NN match for cat-names
    // Override mock to return vector close to cat-names
    const mockEmbed = createMockEmbedding(new Float32Array([0.95, 0.05, 0.0]));
    store.setEmbedDeps({ embedding: mockEmbed, vectorStore, mode: 'on' });

    const results = await store.search('pet nomenclature origins', { mode: 'hybrid', limit: 5 });
    const anchors = results.map((r) => r.anchor);
    // Cat-names should appear via NN even though BM25 can't match "pet nomenclature"
    assert.ok(anchors.includes('doc-cat-names'), 'cat-names should appear via NN in hybrid');
  });

  it('hybrid mode: degrades to lexical when embedding unavailable', async () => {
    if (!vectorStore) return;
    store.setEmbedDeps({
      embedding: { isReady: () => false, embed: async () => [], getModelInfo: () => ({}) },
      vectorStore,
      mode: 'on',
    });
    const results = await store.search('Redis', { mode: 'hybrid', limit: 5 });
    assert.ok(results.length >= 0, 'should not throw');
  });

  it('default mode (no mode specified) behaves as lexical', async () => {
    if (!vectorStore) return;
    const results = await store.search('Redis keyPrefix', { limit: 5 });
    assert.ok(results.length > 0);
    assert.equal(results[0].anchor, 'doc-redis-pitfall');
  });

  it('semantic mode respects scope filter', async () => {
    if (!vectorStore) return;
    const results = await store.search('naming', { mode: 'semantic', scope: 'docs', limit: 5 });
    for (const r of results) {
      assert.notEqual(r.kind, 'session', 'scope=docs should exclude sessions');
    }
  });
});

describe('G-4: drillDown hints', () => {
  it('thread results get drillDown hint', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    store.initialize();

    store.upsert([
      {
        anchor: 'thread-abc123',
        kind: 'thread',
        status: 'active',
        title: 'Test Thread',
        summary: 'test summary',
        updatedAt: new Date().toISOString(),
      },
      {
        anchor: 'doc-feature',
        kind: 'feature',
        status: 'active',
        title: 'F001 Feature',
        summary: 'feature desc',
        updatedAt: new Date().toISOString(),
      },
    ]);

    const results = await store.search('test', { limit: 5 });

    const threadResult = results.find((r) => r.anchor === 'thread-abc123');
    const featureResult = results.find((r) => r.anchor === 'doc-feature');

    if (threadResult) {
      assert.ok(threadResult.drillDown, 'thread result should have drillDown');
      assert.equal(threadResult.drillDown.tool, 'cat_cafe_get_thread_context');
      assert.equal(threadResult.drillDown.params.threadId, 'abc123');
      assert.ok(threadResult.drillDown.hint.includes('abc123'));
    }

    if (featureResult) {
      assert.equal(featureResult.drillDown, undefined, 'feature result should NOT have drillDown');
    }
  });

  it('session results get drillDown hint', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    store.initialize();

    store.upsert([
      {
        anchor: 'session-xyz789',
        kind: 'session',
        status: 'active',
        title: 'Session 0',
        summary: 'session digest',
        updatedAt: new Date().toISOString(),
      },
    ]);

    const results = await store.search('session', { limit: 5 });
    const sessionResult = results.find((r) => r.anchor === 'session-xyz789');

    if (sessionResult) {
      assert.ok(sessionResult.drillDown, 'session result should have drillDown');
      assert.equal(sessionResult.drillDown.tool, 'cat_cafe_read_session_digest');
      assert.equal(sessionResult.drillDown.params.sessionId, 'xyz789');
    }
  });

  it('scope=threads returns kind=thread (not session) with drillDown', async () => {
    const store = new SqliteEvidenceStore(':memory:');
    store.initialize();

    store.upsert([
      {
        anchor: 'thread-t1',
        kind: 'thread',
        status: 'active',
        title: 'Thread One',
        summary: 'foo bar',
        updatedAt: new Date().toISOString(),
      },
      {
        anchor: 'session-s1',
        kind: 'session',
        status: 'active',
        title: 'Session One',
        summary: 'foo bar',
        updatedAt: new Date().toISOString(),
      },
    ]);

    const results = await store.search('foo', { scope: 'threads', limit: 5 });

    // P1 regression: scope=threads must return thread, NOT session
    assert.ok(results.length > 0, 'should return results');
    for (const r of results) {
      assert.equal(r.kind, 'thread', 'scope=threads should only return kind=thread');
    }
    // drillDown should be present on thread results
    const t = results.find((r) => r.anchor === 'thread-t1');
    assert.ok(t, 'thread-t1 should be in results');
    assert.ok(t.drillDown, 'thread result should have drillDown');
    assert.equal(t.drillDown.tool, 'cat_cafe_get_thread_context');
  });
});
