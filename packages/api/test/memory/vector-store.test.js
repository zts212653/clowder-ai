import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

describe('VectorStore', () => {
  let db;
  let store;

  beforeEach(async () => {
    db = new Database(':memory:');
    sqliteVec.load(db);
    const { applyMigrations, ensureVectorTable } = await import('../../dist/domains/memory/schema.js');
    applyMigrations(db);
    ensureVectorTable(db, 256);
    const { VectorStore } = await import('../../dist/domains/memory/VectorStore.js');
    store = new VectorStore(db, 256);
  });

  it('upsert + search returns nearest vector', () => {
    const vec = new Float32Array(256).fill(0.1);
    store.upsert('F042', vec);
    const results = store.search(vec, 5);
    assert.equal(results.length, 1);
    assert.equal(results[0].anchor, 'F042');
    assert.equal(typeof results[0].distance, 'number');
  });

  it('upsert overwrites existing vector (idempotent)', () => {
    const vec1 = new Float32Array(256).fill(0.1);
    const vec2 = new Float32Array(256).fill(0.9);
    store.upsert('F042', vec1);
    store.upsert('F042', vec2); // overwrite
    assert.equal(store.count(), 1);
    const results = store.search(vec2, 5);
    assert.equal(results[0].anchor, 'F042');
  });

  it('delete removes vector', () => {
    const vec = new Float32Array(256).fill(0.1);
    store.upsert('F042', vec);
    store.delete('F042');
    const results = store.search(vec, 5);
    assert.equal(results.length, 0);
  });

  it('search returns multiple results sorted by distance', () => {
    const base = new Float32Array(256).fill(0);
    base[0] = 1.0; // unit vector in dim 0
    store.upsert('close', base);

    const far = new Float32Array(256).fill(0);
    far[255] = 1.0; // orthogonal
    store.upsert('far', far);

    const results = store.search(base, 5);
    assert.equal(results.length, 2);
    assert.equal(results[0].anchor, 'close');
    assert.ok(results[0].distance < results[1].distance, 'close should be nearer');
  });

  it('initMeta stores model info', () => {
    store.initMeta({ modelId: 'qwen3-embedding-0.6b', modelRev: 'abc123', dim: 256 });
    const meta = store.getMeta();
    assert.equal(meta.embedding_model_id, 'qwen3-embedding-0.6b');
    assert.equal(meta.embedding_model_rev, 'abc123');
    assert.equal(meta.embedding_dim, '256');
  });

  it('initMeta overwrites existing meta', () => {
    store.initMeta({ modelId: 'model-a', modelRev: 'v1', dim: 128 });
    store.initMeta({ modelId: 'model-b', modelRev: 'v2', dim: 256 });
    const meta = store.getMeta();
    assert.equal(meta.embedding_model_id, 'model-b');
  });

  it('checkMetaConsistency detects model change', () => {
    store.initMeta({ modelId: 'qwen3-embedding-0.6b', modelRev: 'abc', dim: 256 });
    const result = store.checkMetaConsistency({ modelId: 'multilingual-e5-small', modelRev: 'xyz', dim: 384 });
    assert.equal(result.consistent, false);
    assert.ok(result.reason.includes('model'));
  });

  it('checkMetaConsistency detects dim change', () => {
    store.initMeta({ modelId: 'qwen3-embedding-0.6b', modelRev: 'abc', dim: 256 });
    const result = store.checkMetaConsistency({ modelId: 'qwen3-embedding-0.6b', modelRev: 'abc', dim: 128 });
    assert.equal(result.consistent, false);
    assert.ok(result.reason.includes('dim'));
  });

  it('checkMetaConsistency returns consistent when matching', () => {
    store.initMeta({ modelId: 'qwen3-embedding-0.6b', modelRev: 'abc', dim: 256 });
    const result = store.checkMetaConsistency({ modelId: 'qwen3-embedding-0.6b', modelRev: 'abc', dim: 256 });
    assert.equal(result.consistent, true);
  });

  it('checkMetaConsistency returns consistent when no prior meta', () => {
    const result = store.checkMetaConsistency({ modelId: 'qwen3-embedding-0.6b', modelRev: 'abc', dim: 256 });
    assert.equal(result.consistent, true);
    assert.ok(result.reason.includes('no prior'));
  });

  it('clearAll empties vectors + meta', () => {
    const vec = new Float32Array(256).fill(0.1);
    store.upsert('F042', vec);
    store.initMeta({ modelId: 'test', modelRev: 'v1', dim: 256 });
    store.clearAll();
    assert.equal(store.count(), 0);
    const meta = store.getMeta();
    assert.equal(Object.keys(meta).length, 0);
  });

  it('count returns number of vectors', () => {
    assert.equal(store.count(), 0);
    store.upsert('A', new Float32Array(256).fill(0.1));
    store.upsert('B', new Float32Array(256).fill(0.2));
    assert.equal(store.count(), 2);
  });
});
