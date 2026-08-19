import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

/** Poll a predicate until it is true or the timeout elapses (for fire-and-forget assertions). */
async function waitFor(predicate, { timeout = 2000, interval = 10 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitFor: predicate not satisfied within ${timeout}ms`);
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
    // F209: passage vectors warm up asynchronously after rebuild() (fire-and-forget).
    builder.startPassageEmbeddingWarmup();
    await waitFor(() => passageVectorStore.count() === 2);
    assert.equal(passageVectorStore.count(), 2, 'rebuild should embed every indexed passage (background warm-up)');
  });

  it('deleteByAnchor removes markdown passage vectors with the passages', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');
    mkdirSync(join(docsDir, 'architecture'), { recursive: true });
    writeFileSync(
      join(docsDir, 'architecture', 'vector-delete.md'),
      `---
title: Vector Delete
doc_kind: architecture
---

# Vector Delete

The vectorcleanuptoken appears only in this markdown passage.
`,
    );

    const builder = new IndexBuilder(store, docsDir, { embedding: makeEmbedding(), vectorStore, passageVectorStore });
    await builder.rebuild();
    builder.startPassageEmbeddingWarmup();
    await waitFor(() => passageVectorStore.count() > 0);

    await store.deleteByAnchor('doc:architecture/vector-delete');
    assert.equal(store.searchPassages('vectorcleanuptoken').length, 0);
    assert.equal(passageVectorStore.count(), 0, 'deleting a markdown doc must remove its stale passage vectors');
  });

  it('deleteByAnchor fails open when persisted passage vectors exist but sqlite-vec is not loaded', async () => {
    const { SqliteEvidenceStore } = await import('../../dist/domains/memory/SqliteEvidenceStore.js');
    const { passageVectorKey } = await import('../../dist/domains/memory/PassageVectorStore.js');
    const { ensurePassageVectorTable } = await import('../../dist/domains/memory/schema.js');
    const dbPath = join(tmpDir, 'persisted-passage-vectors.sqlite');
    const anchor = 'doc:architecture/unavailable-vector';
    const passageId = 'md-0';

    const seedStore = new SqliteEvidenceStore(dbPath);
    await seedStore.initialize();
    sqliteVec.load(seedStore.getDb());
    assert.equal(ensurePassageVectorTable(seedStore.getDb(), 4), true);
    await seedStore.upsert([
      {
        anchor,
        kind: 'architecture',
        status: 'active',
        title: 'Unavailable Vector Cleanup',
        summary: 'Lexical cleanup must survive persisted vec0 tables.',
        sourcePath: 'docs/architecture/unavailable-vector.md',
        updatedAt: '2026-07-05T00:00:00Z',
      },
    ]);
    seedStore
      .getDb()
      .prepare(
        'INSERT INTO evidence_passages (doc_anchor, passage_id, content, speaker, position, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        anchor,
        passageId,
        'unavailablevectortoken appears in this markdown passage.',
        null,
        0,
        '2026-07-05T00:00:00Z',
      );
    seedStore
      .getDb()
      .prepare('INSERT INTO passage_vectors (passage_key, embedding) VALUES (?, ?)')
      .run(passageVectorKey(anchor, passageId), new Float32Array([1, 0, 0, 0]));
    seedStore.close();

    const lexicalOnlyStore = new SqliteEvidenceStore(dbPath);
    await lexicalOnlyStore.initialize();
    await assert.doesNotReject(() => lexicalOnlyStore.deleteByAnchor(anchor));
    assert.equal(await lexicalOnlyStore.getByAnchor(anchor), null);
    assert.equal(lexicalOnlyStore.searchPassages('unavailablevectortoken').length, 0);
    lexicalOnlyStore.close();
  });

  it('does not churn unchanged markdown passage vectors on rebuild', async () => {
    const { IndexBuilder } = await import('../../dist/domains/memory/IndexBuilder.js');
    mkdirSync(join(docsDir, 'architecture'), { recursive: true });
    writeFileSync(
      join(docsDir, 'architecture', 'unchanged-doc.md'),
      `---
title: Unchanged Doc
doc_kind: architecture
---

# Unchanged Doc

The unchangedvectortoken remains stable across warm rebuilds.
`,
    );

    const builder = new IndexBuilder(store, docsDir, { embedding: makeEmbedding(), vectorStore, passageVectorStore });
    await builder.rebuild();
    builder.startPassageEmbeddingWarmup();
    await waitFor(() => passageVectorStore.count() > 0);
    const warmCount = passageVectorStore.count();

    await builder.rebuild();
    assert.equal(
      passageVectorStore.count(),
      warmCount,
      'unchanged markdown docs should not delete/reinsert md-* passages and lose warm passage vectors',
    );
  });

  it('does not block rebuild() on passage embedding — fire-and-forget (F209 regression)', async () => {
    // Single message → one passage that must be embedded. With the regression
    // (`await embedMissingPassages()` before listen) rebuild() would hang here.
    const messages = [
      {
        id: 'msg_block_001',
        content: 'Startup must not wait for this passage vector to be computed.',
        catId: 'user',
        threadId: 'thread_embed1',
        timestamp: Date.now(),
      },
    ];
    const builder = await createBuilder({ messages });

    // Gate ONLY passage embedding — the path the F209 fix makes non-blocking. (Doc/thread
    // embedding stays a legitimate synchronous await inside rebuild(), so we must not gate it.)
    let releaseEmbed;
    const gate = new Promise((resolve) => {
      releaseEmbed = resolve;
    });
    const originalEmbedMissing = builder.embedMissingPassages.bind(builder);
    builder.embedMissingPassages = async (...args) => {
      await gate;
      return originalEmbedMissing(...args);
    };

    const rebuildPromise = builder.rebuild();
    let timer;
    try {
      const outcome = await Promise.race([
        rebuildPromise.then(
          () => 'resolved',
          () => 'rejected',
        ),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve('blocked'), 1000);
        }),
      ]);
      clearTimeout(timer);
      assert.equal(outcome, 'resolved', 'rebuild() must resolve without waiting for passage embedding');

      // Canonical lexical passage is indexed synchronously inside rebuild()...
      const db = store.getDb();
      assert.equal(db.prepare('SELECT count(*) as c FROM evidence_passages').get().c, 1);
      // ...but the semantic vector is still pending while passage embedding is gated.
      assert.equal(passageVectorStore.count(), 0, 'passage vectors must warm up after listen(), not before');
      builder.startPassageEmbeddingWarmup();
    } finally {
      clearTimeout(timer);
      releaseEmbed();
      await rebuildPromise.catch(() => {});
    }

    // Once the embedding backend responds, the vector lands in the background.
    await waitFor(() => passageVectorStore.count() === 1);
    assert.equal(passageVectorStore.count(), 1);
  });

  it('defers the passage embedding scan itself off the rebuild critical path (F209 regression)', async () => {
    const messages = [
      {
        id: 'msg_scan_001',
        content: 'Startup must not run passage-vector scan before rebuild resolves.',
        catId: 'user',
        threadId: 'thread_embed1',
        timestamp: Date.now(),
      },
    ];
    const builder = await createBuilder({ messages });

    let scanStarted = false;
    builder.embedMissingPassages = async () => {
      scanStarted = true;
      const stopAt = Date.now() + 250;
      while (Date.now() < stopAt) {
        // Simulate the synchronous pre-await DB scan/diff on a large store.
      }
    };

    await builder.rebuild();

    assert.equal(scanStarted, false, 'rebuild() must schedule passage-vector scan after it resolves');
    builder.startPassageEmbeddingWarmup();
    await waitFor(() => scanStarted);
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
    // F209: initial rebuild embeds passages in the background.
    builder.startPassageEmbeddingWarmup();
    await waitFor(() => passageVectorStore.count() === 1);

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
