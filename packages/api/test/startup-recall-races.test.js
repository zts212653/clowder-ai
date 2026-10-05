import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { IndexBuilder } from '../dist/domains/memory/IndexBuilder.js';
import { PassageVectorStore } from '../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../dist/domains/memory/SqliteEvidenceStore.js';
import { VectorStore } from '../dist/domains/memory/VectorStore.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('recall during startup catch-up', () => {
  const secret = 'saffronsecretwithdrawn';
  let store, builder, readMessages;
  beforeEach(async () => {
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    readMessages = async () => [{ id: 'old', threadId: 'chat', content: secret, timestamp: 1000 }];
    builder = new IndexBuilder(
      store,
      '.',
      undefined,
      undefined,
      async () => [{ id: 'chat', title: secret, participants: [], lastActiveAt: 1000 }],
      (...args) => readMessages(...args),
      undefined,
      { discover: () => [] },
    );
    await builder.rebuild();
  });
  afterEach(() => store.close());

  for (const commit of [true, false]) {
    it(`purges title immediately while catch-up is blocked, then ${commit ? 'commits' : 'restores'} recall`, async () => {
      const entered = deferred(),
        release = deferred();
      const previous = readMessages;
      readMessages = async (...args) => {
        entered.resolve();
        await release.promise;
        return previous(...args);
      };
      const refresh = builder.refreshThreadIndex();
      await entered.promise;
      try {
        const lease = await builder.suppressMessagePassage('chat', 'old');
        assert.equal((await store.search(secret)).length, 0, 'prepared recall must immediately hide derived title');
        assert.equal(store.getDb().prepare('SELECT count(*) AS n FROM doc_aliases WHERE alias = ?').get(secret).n, 0);
        if (commit) {
          await builder.finalizeMessagePassageSuppression(lease);
          assert.equal((await store.search(secret)).length, 0);
        } else {
          await builder.releaseMessagePassageSuppression(lease);
          assert.equal((await store.search(secret)).length, 1);
          assert.equal(store.getDb().prepare('SELECT count(*) AS n FROM doc_aliases WHERE alias = ?').get(secret).n, 1);
        }
      } finally {
        release.resolve();
        await refresh;
      }
    });
  }

  function configureBlockedEmbedding() {
    store.getDb().exec(`
      CREATE TABLE evidence_vectors (anchor TEXT PRIMARY KEY, embedding BLOB);
      CREATE TABLE passage_vectors (passage_key TEXT PRIMARY KEY, embedding BLOB);
    `);
    const entered = deferred(),
      release = deferred();
    let first = true;
    builder.setEmbedDeps({
      vectorStore: new VectorStore(store.getDb(), 1),
      passageVectorStore: new PassageVectorStore(store.getDb(), 1),
      embedding: {
        isReady: () => true,
        reprobeIfNeeded: async () => {},
        getModelInfo: () => ({ modelId: 'fixture', modelRev: '1', dim: 1 }),
        embed: async (texts) => {
          if (first && texts.some((text) => text.includes(secret))) {
            first = false;
            entered.resolve();
            await release.promise;
          }
          return texts.map((text) => new Float32Array([text.includes(secret) ? 1 : 0]));
        },
      },
    });
    return { entered, release };
  }

  it('discards document vectors computed before recall committed', async () => {
    const { entered, release } = configureBlockedEmbedding();
    const vectors = builder.embedMissingDocumentVectors();
    await entered.promise;
    try {
      const lease = await builder.suppressMessagePassage('chat', 'old');
      await builder.finalizeMessagePassageSuppression(lease);
    } finally {
      release.resolve();
      await vectors;
    }
    assert.equal(
      store.getDb().prepare('SELECT count(*) AS n FROM evidence_vectors').get().n,
      0,
      'a completed recall must not be overwritten by stale embedding output',
    );
    const next = await builder.embedMissingDocumentVectors();
    assert.equal(next.docsEmbedded, 1, 'the current safe projection must still be eligible for catch-up');
  });

  it('discards passage vectors computed before recall removed their source', async () => {
    const { entered, release } = configureBlockedEmbedding();
    builder.startPassageEmbeddingWarmup();
    await entered.promise;
    try {
      const lease = await builder.suppressMessagePassage('chat', 'old');
      await builder.finalizeMessagePassageSuppression(lease);
    } finally {
      release.resolve();
      while (builder.isPassageWarmupActive()) await yieldTurn();
    }
    assert.equal(store.getDb().prepare('SELECT count(*) AS n FROM passage_vectors').get().n, 0);
  });
});
