import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as sqliteVec from 'sqlite-vec';

function makeEmbedding({ fail = false } = {}) {
  let calls = 0;
  return {
    isReady: () => true,
    reprobeIfNeeded: async () => {},
    embed: async (texts) => {
      calls++;
      if (fail) throw new Error('embedding offline');
      return texts.map((text, index) => {
        const seed = text.length + index;
        return new Float32Array([seed % 7, seed % 5, seed % 3, 1]);
      });
    },
    getModelInfo: () => ({ modelId: 'test-passage-embedding', modelRev: 'v1', dim: 4 }),
    getCallCount: () => calls,
  };
}

describe('IndexBuilder passage embeddings', () => {
  let tmpDir;
  let docsDir;
  let store;
  let vectorStore;
  let passageVectorStore;

  async function createBuilder({ messages, embedding = makeEmbedding() }) {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');
    const threads = [
      {
        id: 'thread_embed1',
        title: 'Embedding thread',
        participants: ['codex'],
        threadMemory: { summary: 'Passage vector test thread.' },
        lastActiveAt: Date.now(),
      },
    ];

    return new IndexBuilder(
      store,
      docsDir,
      { embedding, vectorStore, passageVectorStore },
      undefined,
      () => threads,
      () => messages,
    );
  }

  beforeEach(async () => {
    tmpDir = join(tmpdir(), `f209-pass-embed-${randomUUID().slice(0, 8)}`);
    docsDir = join(tmpDir, 'docs');
    mkdirSync(join(docsDir, 'features'), { recursive: true });

    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { PassageVectorStore } = await import('../../dist/domains/memory/PassageVectorStore.js');
    const { VectorStore } = await import('../../dist/domains/memory/VectorStore.js');
    const { ensurePassageVectorTable, ensureVectorTable } = await import('../../dist/domains/memory/schema.js');

    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();

    const db = store.getDb();
    sqliteVec.load(db);
    ensureVectorTable(db, 4);
    ensurePassageVectorTable(db, 4);
    vectorStore = new VectorStore(db, 4);
    passageVectorStore = new PassageVectorStore(db, 4);
  });

  afterEach(() => {
    store?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('embeds message passages during rebuild', async () => {
    const messages = [
      {
        id: 'msg_embed_001',
        content: 'The grandmother appointment was moved to Tuesday.',
        catId: 'user',
        threadId: 'thread_embed1',
        timestamp: Date.now() - 1000,
      },
      {
        id: 'msg_embed_002',
        content: 'We should remember the hospital transportation detail.',
        catId: 'codex',
        threadId: 'thread_embed1',
        timestamp: Date.now(),
      },
    ];
    const builder = await createBuilder({ messages });

    await builder.rebuild();

    const db = store.getDb();
    const passageCount = db.prepare('SELECT count(*) as c FROM evidence_passages').get().c;
    assert.equal(passageCount, 2);
    assert.equal(passageVectorStore.count(), 2, 'rebuild should embed every indexed passage');
  });

  it('embeds late-arriving dirty-thread passages without full rebuild', async () => {
    const messages = [
      {
        id: 'msg_dirty_001',
        content: 'Initial passage before dirty flush.',
        catId: 'codex',
        threadId: 'thread_embed1',
        timestamp: Date.now() - 1000,
      },
    ];
    const builder = await createBuilder({ messages });
    await builder.rebuild();
    assert.equal(passageVectorStore.count(), 1);

    messages.push({
      id: 'msg_dirty_002',
      content: 'Late-arriving passage should get a vector too.',
      catId: 'user',
      threadId: 'thread_embed1',
      timestamp: Date.now(),
    });

    const refreshCalls = [];
    const originalRefresh = store.refreshEntityMentions.bind(store);
    store.refreshEntityMentions = async (anchors) => {
      refreshCalls.push(anchors);
      await originalRefresh(anchors);
    };

    builder.markThreadDirty('thread_embed1');
    await builder.flushDirtyThreads();

    const db = store.getDb();
    const passageCount = db.prepare('SELECT count(*) as c FROM evidence_passages').get().c;
    assert.equal(passageCount, 2);
    assert.equal(passageVectorStore.count(), 2, 'dirty flush should backfill missing passage vectors');
    assert.equal(refreshCalls.length, 1, 'dirty flush should refresh entity mentions once per dirty batch');
  });

  it('fails open when passage embedding throws', async () => {
    const messages = [
      {
        id: 'msg_fail_001',
        content: 'Lexical passage indexing must survive embedding failure.',
        catId: 'codex',
        threadId: 'thread_embed1',
        timestamp: Date.now(),
      },
    ];
    const builder = await createBuilder({ messages, embedding: makeEmbedding({ fail: true }) });

    await builder.rebuild();

    const passages = store.searchPassages('Lexical');
    assert.equal(passages.length, 1);
    assert.equal(passageVectorStore.count(), 0);
  });
});
