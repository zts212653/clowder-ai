import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { IndexBuilder } from '../dist/domains/memory/IndexBuilder.js';
import { SqliteEvidenceStore } from '../dist/domains/memory/SqliteEvidenceStore.js';

describe('F264 Gap F recalled-body evidence purge', () => {
  const threadId = 'thread-f264-recall-index';
  const messageId = 'message-f264-recall-index';
  const recalledBody = 'saffron aurora recalled body';
  let messages;
  let store;
  let builder;
  const vectorOps = {
    docDeletes: [],
    docUpserts: [],
    passageDeletes: [],
    passageUpserts: [],
    embeddedTexts: [],
  };

  function resetVectorOps() {
    for (const entries of Object.values(vectorOps)) entries.length = 0;
  }

  before(async () => {
    messages = [
      {
        id: messageId,
        content: recalledBody,
        threadId,
        timestamp: 1_000,
      },
    ];
    store = new SqliteEvidenceStore(':memory:');
    await store.initialize();
    // The unit harness spies on vector boundaries without loading sqlite-vec.
    // IndexBuilder still uses this table to decide whether a passage needs embedding.
    store.getDb().exec('CREATE TABLE IF NOT EXISTS passage_vectors (passage_key TEXT PRIMARY KEY, embedding BLOB)');
    builder = new IndexBuilder(
      store,
      process.cwd(),
      {
        embedding: {
          async load() {},
          async embed(texts) {
            vectorOps.embeddedTexts.push(...texts);
            return texts.map(() => new Float32Array([1]));
          },
          isReady() {
            return true;
          },
          async reprobeIfNeeded() {},
          getModelInfo() {
            return { modelId: 'test', modelRev: '1', dim: 1 };
          },
          dispose() {},
        },
        vectorStore: {
          delete(anchor) {
            vectorOps.docDeletes.push(anchor);
          },
          upsert(anchor) {
            vectorOps.docUpserts.push(anchor);
          },
        },
        passageVectorStore: {
          delete(key) {
            vectorOps.passageDeletes.push(key);
          },
          upsert(key) {
            vectorOps.passageUpserts.push(key);
          },
        },
      },
      undefined,
      () => [
        {
          id: threadId,
          // A generated thread title may be derived from the first user message.
          // True recall must not leave that derived copy searchable.
          title: recalledBody,
          participants: ['owner-1'],
          lastActiveAt: 1_000,
        },
      ],
      () => messages,
      undefined,
      { discover: () => [] },
    );
    builder.markThreadDirty(threadId);
    await builder.flushDirtyThreads();
    resetVectorOps();
  });

  after(() => store.close());

  it('suppresses before CAS, blocks rebuild resurrection, and reconciles either terminal verdict', async () => {
    const db = store.getDb();
    const beforePassage = db
      .prepare('SELECT content FROM evidence_passages WHERE doc_anchor = ? AND passage_id = ?')
      .get(`thread-${threadId}`, `msg-${messageId}`);
    assert.equal(beforePassage.content, recalledBody);
    assert.match((await store.getByAnchor(`thread-${threadId}`)).summary, /saffron aurora/);

    const firstLease = await builder.suppressMessagePassage(threadId, messageId);

    let afterPassage = db
      .prepare('SELECT content FROM evidence_passages WHERE doc_anchor = ? AND passage_id = ?')
      .get(`thread-${threadId}`, `msg-${messageId}`);
    assert.equal(afterPassage, undefined);
    assert.doesNotMatch((await store.getByAnchor(`thread-${threadId}`)).summary, /saffron aurora/);
    assert.equal((await store.search(recalledBody)).length, 0);
    const docAnchor = `thread-${threadId}`;
    const passageKey = JSON.stringify([docAnchor, `msg-${messageId}`]);
    assert.ok(vectorOps.docDeletes.includes(docAnchor), 'document vector is invalidated before canonical CAS');
    assert.ok(vectorOps.passageDeletes.includes(passageKey), 'message passage vector is invalidated before CAS');
    assert.equal(vectorOps.passageUpserts.length, 0, 'suppressed body is not re-embedded');
    assert.ok(
      vectorOps.embeddedTexts.every((text) => !text.includes(recalledBody)),
      'the sanitized document vector cannot contain the recalled body',
    );

    await builder.rebuild({ force: true });
    afterPassage = db
      .prepare('SELECT content FROM evidence_passages WHERE doc_anchor = ? AND passage_id = ?')
      .get(`thread-${threadId}`, `msg-${messageId}`);
    assert.equal(afterPassage, undefined, 'a concurrent rebuild cannot recreate a suppressed passage');

    resetVectorOps();
    assert.equal(await builder.releaseMessagePassageSuppression(firstLease), true);
    const restored = db
      .prepare('SELECT content FROM evidence_passages WHERE doc_anchor = ? AND passage_id = ?')
      .get(`thread-${threadId}`, `msg-${messageId}`);
    assert.equal(restored.content, recalledBody, 'pre-CAS crash reconciliation restores an uncommitted source');
    assert.ok(vectorOps.docDeletes.includes(docAnchor));
    assert.ok(vectorOps.docUpserts.includes(docAnchor), 'rollback re-embeds the exact restored document');
    assert.ok(vectorOps.passageDeletes.includes(passageKey));
    assert.ok(vectorOps.passageUpserts.includes(passageKey), 'rollback re-embeds the exact restored passage');

    await builder.suppressMessagePassage(threadId, messageId);
    messages = [];
    resetVectorOps();
    assert.deepEqual(await builder.reconcileMessageRecallSuppressions(() => true), { retained: 1, released: 0 });
    assert.equal(
      db
        .prepare('SELECT content FROM evidence_passages WHERE doc_anchor = ? AND passage_id = ?')
        .get(`thread-${threadId}`, `msg-${messageId}`),
      undefined,
    );
    assert.doesNotMatch((await store.getByAnchor(`thread-${threadId}`)).summary, /saffron aurora/);
    assert.equal((await store.search(recalledBody)).length, 0);
    assert.ok(vectorOps.docDeletes.includes(docAnchor));
    assert.ok(vectorOps.passageDeletes.includes(passageKey));
    assert.equal(vectorOps.passageUpserts.length, 0, 'committed recall never restores the passage vector');
  });

  it('keeps a committed suppression when a losing concurrent lease releases', async () => {
    messages = [
      {
        id: messageId,
        content: recalledBody,
        threadId,
        timestamp: 1_000,
      },
    ];
    builder.markThreadDirty(threadId);
    await builder.flushDirtyThreads();

    const losingLease = await builder.suppressMessagePassage(threadId, messageId);
    const winningLease = await builder.suppressMessagePassage(threadId, messageId);
    await builder.finalizeMessagePassageSuppression(winningLease);
    assert.equal(await builder.releaseMessagePassageSuppression(losingLease), false);

    const rows = store
      .getDb()
      .prepare(
        `SELECT state FROM message_recall_index_suppressions
         WHERE doc_anchor = ? AND passage_id = ?`,
      )
      .all(`thread-${threadId}`, `msg-${messageId}`);
    assert.ok(rows.length > 0);
    assert.ok(rows.every((row) => row.state === 'committed'));
    assert.equal(
      store
        .getDb()
        .prepare('SELECT content FROM evidence_passages WHERE doc_anchor = ? AND passage_id = ?')
        .get(`thread-${threadId}`, `msg-${messageId}`),
      undefined,
    );
  });
});
