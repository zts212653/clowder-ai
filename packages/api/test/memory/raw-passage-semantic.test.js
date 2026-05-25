import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import * as sqliteVec from 'sqlite-vec';

function createEmbedding(vector) {
  return {
    isReady: () => true,
    reprobeIfNeeded: async () => {},
    embed: async () => [vector],
    getModelInfo: () => ({ modelId: 'test-raw-passage', modelRev: 'v1', dim: 3 }),
  };
}

describe('raw passage semantic and hybrid retrieval', () => {
  let store;
  let passageVectorStore;
  let vectorStore;

  beforeEach(async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { PassageVectorStore, passageVectorKey } = await import('../../dist/domains/memory/PassageVectorStore.js');
    const { VectorStore } = await import('../../dist/domains/memory/VectorStore.js');
    const { ensurePassageVectorTable, ensureVectorTable } = await import('../../dist/domains/memory/schema.js');

    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const db = store.getDb();
    sqliteVec.load(db);
    ensureVectorTable(db, 3);
    ensurePassageVectorTable(db, 3);
    vectorStore = new VectorStore(db, 3);
    passageVectorStore = new PassageVectorStore(db, 3);

    await store.upsert([
      {
        anchor: 'thread-thread_semantic',
        kind: 'thread',
        status: 'active',
        title: 'Family logistics thread',
        summary: 'Care coordination without the literal query terms.',
        updatedAt: '2026-05-20T00:00:00Z',
      },
      {
        anchor: 'thread-thread_lexical',
        kind: 'thread',
        status: 'active',
        title: 'Appointment thread',
        summary: 'Literal appointment keyword appears here.',
        updatedAt: '2026-05-20T00:00:00Z',
      },
      {
        anchor: 'thread-thread_old',
        kind: 'thread',
        status: 'active',
        title: 'Old logistics thread',
        summary: 'Older related coordination.',
        updatedAt: '2026-05-01T00:00:00Z',
      },
    ]);

    const insertPassage = db.prepare(`
      INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    insertPassage.run(
      'thread-thread_semantic',
      'msg-before',
      'Earlier note about pickup timing.',
      'user',
      0,
      '2026-05-20T09:00:00Z',
    );
    insertPassage.run(
      'thread-thread_semantic',
      'msg-semantic',
      'Grandmother hospital transportation moved to Tuesday morning.',
      'codex',
      1,
      '2026-05-20T10:00:00Z',
    );
    insertPassage.run(
      'thread-thread_semantic',
      'msg-after',
      'Follow-up note about confirming the driver.',
      'user',
      2,
      '2026-05-20T11:00:00Z',
    );
    insertPassage.run(
      'thread-thread_lexical',
      'msg-lexical',
      'The appointment keyword should be found by passage BM25.',
      'opus',
      0,
      '2026-05-20T12:00:00Z',
    );
    insertPassage.run(
      'thread-thread_old',
      'msg-old',
      'Older grandmother transportation detail outside the requested date window.',
      'codex',
      0,
      '2026-05-01T10:00:00Z',
    );

    passageVectorStore.upsert(passageVectorKey('thread-thread_semantic', 'msg-semantic'), new Float32Array([1, 0, 0]));
    passageVectorStore.upsert(passageVectorKey('thread-thread_lexical', 'msg-lexical'), new Float32Array([0, 1, 0]));
    passageVectorStore.upsert(passageVectorKey('thread-thread_old', 'msg-old'), new Float32Array([0.95, 0.05, 0]));

    store.setEmbedDeps({
      embedding: createEmbedding(new Float32Array([1, 0, 0])),
      vectorStore,
      passageVectorStore,
      mode: 'on',
    });
  });

  it('semantic raw mode finds passage vectors when literal query tokens are absent', async () => {
    const results = await store.search('care logistics', {
      depth: 'raw',
      mode: 'semantic',
      scope: 'threads',
      limit: 1,
      contextWindow: 1,
    });

    assert.equal(results.length, 1);
    assert.equal(results[0].anchor, 'thread-thread_semantic');
    assert.equal(results[0].passages?.[0]?.passageId, 'msg-semantic');
    assert.equal(results[0].passages?.[0]?.docAnchor, 'thread-thread_semantic');
    assert.equal(results[0].passages?.[0]?.threadId, 'thread_semantic');
    assert.equal(results[0].passages?.[0]?.messageId, 'semantic');
    assert.equal(results[0].passages?.[0]?.context?.length, 2);
    assert.equal(results[0].drillDown?.tool, 'cat_cafe_get_thread_context');
    assert.equal(results[0].drillDown?.params.threadId, 'thread_semantic');
    assert.equal(results[0].drillDown?.params.messageId, 'semantic');
    assert.equal(results[0].drillDown?.params.before, '3');
    assert.equal(results[0].drillDown?.params.after, '3');
  });

  it('hybrid raw mode fuses lexical-only and semantic-only passage hits', async () => {
    const results = await store.search('appointment', {
      depth: 'raw',
      mode: 'hybrid',
      scope: 'threads',
      limit: 2,
    });
    const anchors = results.map((r) => r.anchor);

    assert.ok(anchors.includes('thread-thread_semantic'), 'semantic-only passage should appear via passage NN');
    assert.ok(anchors.includes('thread-thread_lexical'), 'lexical passage should appear via passage BM25');
    assert.ok(
      results.every((r) => r.passages?.length),
      'raw hybrid results should carry passage anchors',
    );
  });

  it('semantic raw mode respects thread and date filters', async () => {
    const threadFiltered = await store.search('care logistics', {
      depth: 'raw',
      mode: 'semantic',
      scope: 'threads',
      threadId: 'thread_lexical',
      limit: 5,
    });
    assert.deepEqual(
      threadFiltered.map((r) => r.anchor),
      ['thread-thread_lexical'],
    );

    const dateFiltered = await store.search('care logistics', {
      depth: 'raw',
      mode: 'semantic',
      scope: 'threads',
      dateFrom: '2026-05-15T00:00:00Z',
      limit: 5,
    });
    assert.ok(!dateFiltered.some((r) => r.anchor === 'thread-thread_old'));
  });

  it('searchWithMeta reports passage embedding degradation for raw semantic fallback', async () => {
    store.setEmbedDeps({
      embedding: { isReady: () => false, embed: async () => [], getModelInfo: () => ({}) },
      vectorStore,
      passageVectorStore,
      mode: 'on',
    });

    const result = await store.searchWithMeta('appointment', {
      depth: 'raw',
      mode: 'semantic',
      scope: 'threads',
      limit: 2,
    });

    assert.equal(result.meta.degraded, true);
    assert.equal(result.meta.degradeReason, 'passage_embedding_unavailable');
    assert.equal(result.meta.effectiveMode, 'lexical');
    assert.ok(
      result.items.some((r) => r.anchor === 'thread-thread_lexical'),
      'lexical fallback still returns results',
    );
  });

  it('raw semantic mode re-probes embedding readiness before degrading', async () => {
    let ready = false;
    let reprobeCalls = 0;
    store.setEmbedDeps({
      embedding: {
        isReady: () => ready,
        reprobeIfNeeded: async () => {
          reprobeCalls++;
          ready = true;
        },
        embed: async () => [new Float32Array([1, 0, 0])],
        getModelInfo: () => ({ modelId: 'test-raw-passage', modelRev: 'v1', dim: 3 }),
      },
      vectorStore,
      passageVectorStore,
      mode: 'on',
    });

    const result = await store.searchWithMeta('care logistics', {
      depth: 'raw',
      mode: 'semantic',
      scope: 'threads',
      limit: 1,
    });

    assert.equal(reprobeCalls, 1);
    assert.equal(result.meta.degraded, false);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].anchor, 'thread-thread_semantic');
    assert.equal(result.items[0].passages?.[0]?.passageId, 'msg-semantic');
  });

  it('searchWithMeta reports passage vector search errors for raw hybrid fallback', async () => {
    store.setEmbedDeps({
      embedding: createEmbedding(new Float32Array([1, 0, 0])),
      vectorStore,
      passageVectorStore: {
        search: () => {
          throw new Error('vec0 unavailable');
        },
      },
      mode: 'on',
    });

    const result = await store.searchWithMeta('appointment', {
      depth: 'raw',
      mode: 'hybrid',
      scope: 'threads',
      limit: 2,
    });

    assert.equal(result.meta.degraded, true);
    assert.equal(result.meta.degradeReason, 'passage_vector_search_error');
    assert.equal(result.meta.effectiveMode, 'lexical');
    assert.ok(
      result.items.some((r) => r.anchor === 'thread-thread_lexical'),
      'lexical fallback still returns results',
    );
  });
});
