import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as sqliteVec from 'sqlite-vec';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { MemoryEmbeddingLifecycle } from '../../dist/domains/memory/MemoryEmbeddingLifecycle.js';
import { PassageVectorStore, passageVectorKey } from '../../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable, ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'memory-vector-layout-'));
  const docs = join(root, 'docs');
  mkdirSync(join(docs, 'features'), { recursive: true });
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  const db = store.getDb();
  sqliteVec.load(db);
  ensureVectorTable(db, 4);
  ensurePassageVectorTable(db, 4);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, db, docs, vectors: new PassageVectorStore(db, 4), documents: new VectorStore(db, 4) };
}

test('embedding replacement keeps its existing native slot and invalid replacement preserves the value', async (t) => {
  const f = await fixture(t);
  for (const [vectors, table, key] of [
    [f.vectors, 'passage_vectors', passageVectorKey('thread-x', 'msg-x')],
    [f.documents, 'evidence_vectors', 'F102'],
  ]) {
    vectors.upsert(key, new Float32Array([1, 0, 0, 0]));
    const slot = f.db.prepare(`SELECT rowid,chunk_id,chunk_offset FROM ${table}_rowids WHERE id=?`).get(key);
    vectors.upsert(key, new Float32Array([0, 1, 0, 0]));
    assert.deepEqual(
      f.db.prepare(`SELECT rowid,chunk_id,chunk_offset FROM ${table}_rowids WHERE id=?`).get(key),
      slot,
      'changing only an embedding must not punch a hole and append another physical slot',
    );
    const before = vectors.search(new Float32Array([0, 1, 0, 0]), 1);
    assert.throws(() => vectors.upsert(key, new Float32Array([1, 0])));
    assert.equal(vectors.count(), 1, 'failed replacement cannot delete the prior vector');
    assert.deepEqual(vectors.search(new Float32Array([0, 1, 0, 0]), 1), before);
  }
});

test('thread metadata and position refresh retain embeddings for unchanged searchable source text', async (t) => {
  const f = await fixture(t);
  const thread = { id: 'stable', title: 'Stable', lastActiveAt: 1000, participants: [] };
  const messages = Array.from({ length: 40 }, (_, i) => ({
    id: `message-${i}`,
    threadId: 'stable',
    content: `Unchanged source text ${i}`,
    timestamp: 1000 + i,
  }));
  const builder = new IndexBuilder(
    f.store,
    f.docs,
    undefined,
    undefined,
    () => [thread],
    () => messages,
  );
  await builder.rebuild();
  for (const message of messages)
    f.vectors.upsert(passageVectorKey('thread-stable', `msg-${message.id}`), new Float32Array([1, 0, 0, 0]));
  builder.setEmbedDeps({
    embedding: { isReady: () => false, getModelInfo: () => ({ modelId: 'fixture', modelRev: '1', dim: 4 }) },
    vectorStore: f.documents,
    passageVectorStore: f.vectors,
  });
  messages.unshift({ id: 'earlier', threadId: 'stable', content: 'New earlier message', timestamp: 999 });
  messages[1].catId = 'codex61-sol';
  messages[1].timestamp = 2000;
  builder.markThreadDirty('stable');
  await builder.flushDirtyThreads();
  assert.equal(f.vectors.count(), 40, 'position/speaker/timestamp updates do not change embedding input');
  assert.deepEqual(
    f.db.prepare("SELECT position,speaker,created_at FROM evidence_passages WHERE passage_id='msg-message-0'").get(),
    { position: 1, speaker: 'codex61-sol', created_at: '1970-01-01T00:00:02.000Z' },
  );
  messages[1].content = 'Changed actual searchable text';
  builder.markThreadDirty('stable');
  await builder.flushDirtyThreads();
  assert.equal(f.vectors.count(), 39);
  assert.equal(
    f.db
      .prepare('SELECT id FROM passage_vectors_rowids WHERE id=?')
      .get(passageVectorKey('thread-stable', 'msg-message-0')),
    undefined,
  );
});

test('canonical embedding activation packs a sparse projection without reembedding or changing unique NN results', async (t) => {
  const f = await fixture(t);
  const insert = f.db.prepare('INSERT INTO passage_vectors(passage_key,embedding) VALUES(?,?)');
  f.db.transaction(() => {
    for (let i = 0; i < 32 * 1024; i++) insert.run(`key-${i}`, new Float32Array([1, i / 32768, 0, 0]));
    for (let i = 0; i < 32 * 1024; i++) if (i % 1024) f.vectors.delete(`key-${i}`);
  })();
  const before = f.vectors.search(new Float32Array([1, 0, 0, 0]), 32);
  assert.equal(f.db.prepare('SELECT count(*) AS c FROM passage_vectors_chunks').get().c, 32);
  let embeddingCalls = 0;
  const lifecycle = new MemoryEmbeddingLifecycle(
    f.store,
    new IndexBuilder(f.store, f.docs),
    {
      embedMode: 'on',
      embedModel: 'fixture',
      embedDim: 4,
      embedTimeoutMs: 100,
      maxModelMemMb: 32,
    },
    {
      createEmbeddingService: () => ({
        load: async () => {},
        reprobeIfNeeded: async () => {},
        isReady: () => true,
        getModelInfo: () => ({ modelId: 'fixture', modelRev: '1', dim: 4 }),
        dispose() {},
        embed: async () => {
          embeddingCalls++;
          throw new Error('repacking cannot call an embedding model');
        },
      }),
    },
  );
  assert.equal((await lifecycle.activate('on')).ok, true);
  assert.equal(f.db.prepare('SELECT count(*) AS c FROM passage_vectors_chunks').get().c, 1);
  assert.equal(f.vectors.count(), 32);
  assert.deepEqual(f.vectors.search(new Float32Array([1, 0, 0, 0]), 32), before);
  assert.equal(embeddingCalls, 0);
  lifecycle.deactivate();
});
