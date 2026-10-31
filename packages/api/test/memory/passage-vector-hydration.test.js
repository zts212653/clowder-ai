import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as sqliteVec from 'sqlite-vec';
import { PassageVectorStore, passageVectorKey } from '../../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable, ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';

describe('passage vector hydration at the message candidate limit', () => {
  let store;
  let vectors;
  let insert;
  const start = Date.parse('2026-10-01T00:00:00Z');
  const options = { visibleThreadIds: ['visible', 'other'], sort: 'time', candidateLimit: 2000 };

  beforeEach(async () => {
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const db = store.getDb();
    sqliteVec.load(db);
    assert.equal(ensureVectorTable(db, 3), true);
    assert.equal(ensurePassageVectorTable(db, 3), true);
    vectors = new PassageVectorStore(db, 3);
    store.setEmbedDeps({
      mode: 'on',
      vectorStore: new VectorStore(db, 3),
      passageVectorStore: vectors,
      embedding: {
        isReady: () => true,
        reprobeIfNeeded: async () => {},
        embed: async () => [new Float32Array([1, 0, 0])],
        getModelInfo: () => ({ modelId: 'fixture', modelRev: '1', dim: 3 }),
      },
    });
    await store.upsert(
      ['visible', 'other'].map((id) => ({
        anchor: `thread-${id}`,
        kind: 'thread',
        status: 'active',
        title: id,
        updatedAt: '2026-10-01T00:00:00Z',
      })),
    );
    insert = db.prepare(
      'INSERT INTO evidence_passages (doc_anchor, passage_id, content, created_at) VALUES (?, ?, ?, ?)',
    );
    db.transaction(() => {
      for (let i = 0; i < 2000; i++) {
        const anchor = i % 2 === 0 ? 'thread-visible' : 'thread-other';
        const id = `msg-${String(i).padStart(4, '0')}`;
        insert.run(anchor, id, `Unrelated fixture body ${i}`, new Date(start + i * 1000).toISOString());
        vectors.upsert(passageVectorKey(anchor, id), new Float32Array([1, i / 2000, 0]));
      }
    })();
  });

  afterEach(() => store.close());

  for (const mode of ['semantic', 'hybrid']) {
    it(`hydrates all 2000 native NN hits without degrading ${mode} to lexical`, async () => {
      const result = await store.searchMessagePassages('musical recollection', { ...options, mode });
      assert.equal(result.meta.effectiveMode, mode);
      assert.equal(result.meta.degraded, false);
      assert.equal(result.meta.semanticCandidatesLimited, true);
      assert.equal(result.passages.length, 2000);
      assert.equal(result.passages[0].messageId, '0000');
      assert.equal(result.passages.at(-1).messageId, '1999');
      assert.equal(result.passages.at(-1).content, 'Unrelated fixture body 1999');
    });
  }

  it('retains exact thread, inclusive date and source filters with 2000 vector hits', async () => {
    const result = await store.searchMessagePassages('musical recollection', {
      ...options,
      mode: 'semantic',
      threadId: 'visible',
      dateFrom: '2026-10-01T02:00:02+02:00',
      dateTo: '2026-10-01T00:00:10Z',
      excludeSource: { threadId: 'visible', messageId: '0006' },
    });
    assert.equal(result.meta.degraded, false);
    assert.deepEqual(
      result.passages.map((p) => p.messageId),
      ['0002', '0004', '0008', '0010'],
    );
    assert.ok(result.passages.every((p) => p.threadId === 'visible'));
  });

  it('preserves composite coordinates without admitting cross-product rows or SQL syntax', async () => {
    vectors.clearAll();
    const left = "msg-pair-a' OR 1=1 --";
    const right = 'msg-pair-b';
    for (const [anchor, id] of [
      ['thread-visible', left],
      ['thread-other', right],
      ['thread-visible', right],
      ['thread-other', left],
    ])
      insert.run(anchor, id, `${anchor}/${id}`, '2026-09-01T00:00:00Z');
    vectors.upsert(passageVectorKey('thread-visible', left), new Float32Array([1, 0, 0]));
    vectors.upsert(passageVectorKey('thread-other', right), new Float32Array([0.9, 0.1, 0]));
    const result = await store.searchMessagePassages('musical recollection', { ...options, mode: 'semantic' });
    assert.equal(result.meta.degraded, false);
    assert.deepEqual(
      result.passages.map((p) => [p.threadId, p.messageId]),
      [
        ['other', 'pair-b'],
        ['visible', "pair-a' OR 1=1 --"],
      ],
    );
  });
});
