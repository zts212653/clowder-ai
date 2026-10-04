import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as sqliteVec from 'sqlite-vec';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { PassageVectorStore } from '../../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable, ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('dirty messages across threads are lexically searchable while document embedding is blocked', async () => {
  const docs = mkdtempSync(join(tmpdir(), 'f322-dirty-flush-'));
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  const db = store.getDb();
  sqliteVec.load(db);
  ensureVectorTable(db, 4);
  ensurePassageVectorTable(db, 4);
  const vectorStore = new VectorStore(db, 4);
  const passageVectorStore = new PassageVectorStore(db, 4);
  const embeddingEntered = deferred();
  const releaseEmbedding = deferred();
  const threads = ['first', 'second'].map((id) => ({
    id,
    title: `Thread ${id}`,
    participants: ['codex61-sol'],
    lastActiveAt: 1790910000000,
  }));
  const messages = threads.map((thread) => ({
    id: `message-${thread.id}`,
    threadId: thread.id,
    catId: 'codex61-sol',
    content: `freshnesstoken${thread.id}`,
    timestamp: thread.lastActiveAt,
  }));
  const builder = new IndexBuilder(
    store,
    docs,
    {
      vectorStore,
      passageVectorStore,
      embedding: {
        isReady: () => true,
        reprobeIfNeeded: async () => {},
        getModelInfo: () => ({ modelId: 'blocking-fixture', modelRev: '1', dim: 4 }),
        embed: async (texts) => {
          embeddingEntered.resolve();
          await releaseEmbedding.promise;
          return texts.map(() => new Float32Array([1, 0, 0, 0]));
        },
      },
    },
    undefined,
    () => threads,
    (threadId) => messages.filter((message) => message.threadId === threadId),
  );
  for (const thread of threads) builder.markThreadDirty(thread.id);
  const flush = builder.flushDirtyThreads();
  try {
    await embeddingEntered.promise;
    assert.equal(passageVectorStore.count(), 0, 'the embedding barrier is still closed');
    for (const message of messages) {
      assert.deepEqual(
        store.searchPassages(message.content).map((hit) => hit.passageId),
        [`msg-${message.id}`],
        'lexical recall must not wait for this or another thread document vector',
      );
    }
    releaseEmbedding.resolve();
    assert.equal(await flush, 2);
    assert.equal(vectorStore.count(), 2, 'document vectors still commit after the barrier opens');
    assert.equal(passageVectorStore.count(), 2, 'message vectors still commit after the barrier opens');
  } finally {
    releaseEmbedding.resolve();
    await flush;
    store.close();
    rmSync(docs, { recursive: true, force: true });
  }
});
