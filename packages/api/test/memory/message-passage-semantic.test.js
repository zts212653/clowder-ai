import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import * as sqliteVec from 'sqlite-vec';
import { PassageVectorStore, passageVectorKey } from '../../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable, ensureVectorTable } from '../../dist/domains/memory/schema.js';
import { VectorStore } from '../../dist/domains/memory/VectorStore.js';

describe('message-unit semantic admission', () => {
  let store;
  let vectors;
  let fail = false;
  let embedBarrier;
  const options = { visibleThreadIds: ['visible'], sort: 'time', candidateLimit: 10 };

  beforeEach(async () => {
    fail = false;
    embedBarrier = undefined;
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    const db = store.getDb();
    sqliteVec.load(db);
    ensureVectorTable(db, 3);
    ensurePassageVectorTable(db, 3);
    vectors = new PassageVectorStore(db, 3);
    store.setEmbedDeps({
      mode: 'on',
      vectorStore: new VectorStore(db, 3),
      passageVectorStore: vectors,
      embedding: {
        isReady: () => true,
        reprobeIfNeeded: async () => {},
        embed: async () => {
          if (embedBarrier) {
            embedBarrier.entered.resolve();
            await embedBarrier.release.promise;
          }
          if (fail) throw new Error('fixture provider unavailable');
          return [new Float32Array([1, 0, 0])];
        },
        getModelInfo: () => ({ modelId: 'fixture', modelRev: '1', dim: 3 }),
      },
    });
    await store.upsert(
      ['visible', 'private'].map((id) => ({
        anchor: `thread-${id}`,
        kind: 'thread',
        status: 'active',
        title: id,
        updatedAt: '2026-10-01T00:00:00.000Z',
      })),
    );
    const insert = db.prepare(
      'INSERT INTO evidence_passages (doc_anchor, passage_id, content, created_at) VALUES (?, ?, ?, ?)',
    );
    insert.run('thread-visible', 'msg-old', '导航 按消息找回原处', '2026-09-01T00:00:00.000Z');
    insert.run('thread-visible', 'msg-new', 'Return to the earlier discussion', '2026-10-01T00:00:00.000Z');
    insert.run('thread-private', 'msg-secret', 'Hidden navigation discussion', '2026-08-01T00:00:00.000Z');
    vectors.upsert(passageVectorKey('thread-private', 'msg-secret'), new Float32Array([1, 0, 0]));
    vectors.upsert(passageVectorKey('thread-visible', 'msg-new'), new Float32Array([0.9, 0.1, 0]));
    vectors.upsert(passageVectorKey('thread-visible', 'msg-old'), new Float32Array([0, 1, 0]));
  });

  afterEach(() => store.close());

  it('finds semantic messages without inventing lexical matches and retains multiple hits', async () => {
    const result = await store.searchMessagePassages('earlier recollection', { ...options, mode: 'semantic' });
    assert.deepEqual(
      result.passages.map((p) => p.messageId),
      ['old', 'new'],
    );
    assert.ok(result.passages.every((p) => p.match === 'semantic'));
    assert.equal(result.meta.semanticCandidatesLimited, true);
    assert.equal(result.meta.sourceCoverage, 'unknown');
  });

  it('filters ungranted NN hits before hybrid ranking can crowd out a valid lexical message', async () => {
    assert.equal(store.searchPassages('导航')[0]?.passageId, 'msg-old', 'the lexical control must match');
    const result = await store.searchMessagePassages('导航', { ...options, mode: 'hybrid', candidateLimit: 1 });
    assert.deepEqual(
      result.passages.map((p) => p.messageId),
      ['old'],
    );
  });

  it('keeps precise source exclusion for semantic-only hits', async () => {
    const result = await store.searchMessagePassages('earlier recollection', {
      ...options,
      mode: 'semantic',
      excludeSource: { threadId: 'visible', messageId: 'new' },
    });
    assert.deepEqual(
      result.passages.map((p) => p.messageId),
      ['old'],
    );
  });

  it('applies inclusive UTC date boundaries to semantic hydration as well as lexical candidates', async () => {
    const offset = await store.searchMessagePassages('earlier recollection', {
      ...options,
      mode: 'semantic',
      dateTo: '2026-08-31T20:00:00-04:00',
    });
    assert.deepEqual(
      offset.passages.map((p) => p.messageId),
      ['old'],
    );
    store
      .getDb()
      .prepare('UPDATE evidence_passages SET created_at=? WHERE passage_id=?')
      .run('2026-09-01T23:59:59.999Z', 'msg-old');
    const endOfDay = await store.searchMessagePassages('earlier recollection', {
      ...options,
      mode: 'semantic',
      dateTo: '2026-09-01',
    });
    assert.deepEqual(
      endOfDay.passages.map((p) => p.messageId),
      ['old'],
    );
  });

  it('reports provider failure as lexical degradation instead of authoritative semantic emptiness', async () => {
    fail = true;
    const result = await store.searchMessagePassages('导航', { ...options, mode: 'hybrid' });
    assert.deepEqual(
      result.passages.map((p) => p.messageId),
      ['old'],
    );
    assert.equal(result.meta.degradeReason, 'passage_vector_search_error');
    assert.equal(result.meta.effectiveMode, 'lexical');
  });

  it('does not resurrect a cached lexical hit when recall suppression starts during query embedding', async () => {
    const deferred = () => {
      let resolve;
      const promise = new Promise((r) => {
        resolve = r;
      });
      return { promise, resolve };
    };
    embedBarrier = { entered: deferred(), release: deferred() };
    const search = store.searchMessagePassages('导航', { ...options, mode: 'hybrid' });
    try {
      await embedBarrier.entered.promise;
      const db = store.getDb();
      db.transaction(() => {
        db.prepare(`INSERT INTO message_recall_index_suppressions
          (doc_anchor, passage_id, lease_id, state, prepared_at) VALUES (?, ?, ?, 'prepared', ?)`).run(
          'thread-visible',
          'msg-old',
          'query-recall-fixture',
          new Date().toISOString(),
        );
        db.prepare('DELETE FROM evidence_passages WHERE doc_anchor=? AND passage_id=?').run(
          'thread-visible',
          'msg-old',
        );
      })();
      embedBarrier.release.resolve();
      assert.ok(!(await search).passages.some((p) => p.messageId === 'old'));
    } finally {
      embedBarrier.release.resolve();
      await search;
    }
  });
});
