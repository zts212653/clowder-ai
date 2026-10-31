import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { ProjectionCheckpointBackpressureError } from '../../dist/domains/memory/projection-checkpoints.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'index-checkpoint-retry-'));
  const docs = join(root, 'docs');
  mkdirSync(join(docs, 'features'), { recursive: true });
  const path = join(root, 'evidence.sqlite');
  const store = new SqliteEvidenceStore(path);
  await store.initialize();
  const reader = new Database(path, { readonly: true });
  t.after(() => {
    reader.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { docs, path, store, db: store.getDb(), reader };
}

for (const reopen of [false, true]) {
  test(`message retry repairs passage mentions after checkpoint backpressure (reopen=${reopen})`, async (t) => {
    const { docs, path, store, db, reader } = await fixture(t);
    await store.upsertEntities([
      {
        entityId: 'concept:alias',
        type: 'concept',
        canonicalName: 'RepairToken',
        aliases: ['repairtoken'],
        provenance: [{ source: 'fixture' }],
        updatedAt: '2026-01-01',
      },
    ]);
    const messages = Array.from({ length: 16 }, (_, i) => ({
      id: `m${i}`,
      threadId: 'fixture',
      content: `repairtoken message ${i}`,
      timestamp: Date.UTC(2026, 0, 1) + i,
    }));
    const builder = new IndexBuilder(
      store,
      docs,
      undefined,
      undefined,
      () => [{ id: 'fixture', title: 'Fixture', participants: [], lastActiveAt: 1 }],
      (_id, limit = 2000) => messages.slice(-limit),
    );
    await assert.rejects(
      builder.refreshThreadIndex({
        onProgress: (phase) => {
          if (phase === 'thread-passages') {
            reader.exec('BEGIN');
            reader.prepare('SELECT count(*) FROM evidence_passages').get();
          }
        },
      }),
      ProjectionCheckpointBackpressureError,
    );
    assert.equal(db.prepare("SELECT count(*) AS n FROM evidence_passages WHERE passage_id LIKE 'msg-%'").get().n, 16);
    assert.equal(db.prepare('SELECT count(*) AS n FROM entity_mention_pending_docs').get().n, 1);
    reader.exec('ROLLBACK');
    const retryStore = reopen ? new SqliteEvidenceStore(path) : store;
    if (reopen) {
      store.close();
      await retryStore.initialize();
      t.after(() => retryStore.close());
    } else await builder.refreshThreadIndex();
    const mentions = retryStore
      .getDb()
      .prepare("SELECT count(*) AS n FROM entity_mentions WHERE entity_id='concept:alias' AND source='passage'")
      .get().n;
    t.diagnostic(JSON.stringify({ committedMessages: 16, passageMentionsAfterSuccessfulRetry: mentions }));
    assert.equal(mentions, 16, 'successful retry must publish mentions for all committed messages');
    assert.equal(retryStore.getDb().prepare('SELECT count(*) AS n FROM entity_mention_pending_docs').get().n, 0);
  });
}

for (const entry of ['rebuild', 'incremental']) {
  for (const reopen of [false, true]) {
    test(`document retry repairs remaining passages after ${entry} backpressure (reopen=${reopen})`, async (t) => {
      const { docs, path, store, db, reader } = await fixture(t);
      const first = join(docs, 'features', 'F001-a.md');
      const second = join(docs, 'features', 'F002-b.md');
      const write = (path, id, text) => writeFileSync(path, `---\nfeature_ids: [${id}]\n---\n# Fixture\n\n${text}`);
      write(first, 'F001', 'oldfirst');
      write(second, 'F002', 'oldsecond');
      const builder = new IndexBuilder(store, docs);
      await builder.rebuild({ deferThreadIndexing: true });
      write(first, 'F001', 'newfirst');
      write(second, 'F002', 'newsecond');
      const run = store.runCheckpointedBatch.bind(store);
      let once = true;
      const hook = t.mock.method(store, 'runCheckpointedBatch', (fn) => {
        if (once) {
          once = false;
          reader.exec('BEGIN');
          reader.prepare('SELECT count(*) FROM evidence_passages').get();
        }
        return run(fn);
      });
      await assert.rejects(
        entry === 'rebuild'
          ? builder.rebuild({ deferThreadIndexing: true })
          : builder.incrementalUpdate([first, second]),
        ProjectionCheckpointBackpressureError,
      );
      hook.mock.restore();
      assert.ok(db.prepare("SELECT source_hash FROM evidence_docs WHERE anchor='F001'").get().source_hash);
      assert.equal(db.prepare("SELECT source_hash FROM evidence_docs WHERE anchor='F002'").get().source_hash, null);
      reader.exec('ROLLBACK');
      const retryStore = reopen ? new SqliteEvidenceStore(path) : store;
      if (reopen) {
        store.close();
        await retryStore.initialize();
        t.after(() => retryStore.close());
      }
      const retryBuilder = reopen ? new IndexBuilder(retryStore, docs) : builder;
      const result = await retryBuilder.rebuild({ deferThreadIndexing: true });
      const rows = retryStore
        .getDb()
        .prepare('SELECT doc_anchor, content FROM evidence_passages ORDER BY doc_anchor, position')
        .all();
      t.diagnostic(JSON.stringify({ result, passagesAfterSuccessfulRetry: rows }));
      assert.ok(rows.some((row) => row.doc_anchor === 'F001' && row.content.includes('newfirst')));
      assert.ok(
        rows.some((row) => row.doc_anchor === 'F002' && row.content.includes('newsecond')),
        'successful retry must finish the second document',
      );
    });
  }
}

test('dirty thread retry keeps unfinished passage work scheduled after backpressure', async (t) => {
  const { docs, store, db, reader } = await fixture(t);
  const threads = ['fixture', 'unprocessed', 'concurrent'];
  const builder = new IndexBuilder(
    store,
    docs,
    undefined,
    undefined,
    () => threads.map((id) => ({ id, title: id, participants: [], lastActiveAt: 1 })),
    (id) =>
      Array.from({ length: 32 }, (_, i) => ({
        id: `${id}-${i}`,
        threadId: id,
        content: `message ${i}`,
        timestamp: Date.UTC(2026, 0, 1) + i,
      })),
  );
  const run = store.runCheckpointedBatch.bind(store);
  let once = true;
  const hook = t.mock.method(store, 'runCheckpointedBatch', (fn) => {
    if (once) {
      once = false;
      builder.markThreadDirty('concurrent');
      reader.exec('BEGIN');
      reader.prepare('SELECT count(*) FROM evidence_passages').get();
    }
    return run(fn);
  });
  builder.markThreadDirty('fixture');
  builder.markThreadDirty('unprocessed');
  await assert.rejects(builder.flushDirtyThreads(), ProjectionCheckpointBackpressureError);
  hook.mock.restore();
  reader.exec('ROLLBACK');
  await builder.flushDirtyThreads();
  for (const id of threads) {
    const count = db
      .prepare("SELECT count(*) AS n FROM evidence_passages WHERE doc_anchor=? AND passage_id LIKE 'msg-%'")
      .get(`thread-${id}`).n;
    assert.equal(count, 32, `dirty retry must retain ${id}`);
  }
});

test('transcript retry publishes committed mentions before advancing the file checkpoint', async (t) => {
  const { docs, store, db, reader } = await fixture(t);
  await store.upsertEntities([
    {
      entityId: 'concept:alias',
      type: 'concept',
      canonicalName: 'RepairToken',
      aliases: ['repairtoken'],
      provenance: [{ source: 'fixture' }],
      updatedAt: '2026-01-01',
    },
  ]);
  await store.upsert([
    {
      anchor: 'thread-fixture',
      kind: 'thread',
      status: 'active',
      title: 'Fixture',
      updatedAt: '2026-01-01',
    },
  ]);
  const transcriptRoot = join(docs, 'transcripts');
  const session = join(transcriptRoot, 'threads', 'fixture', 'codex', 'sessions', 's1');
  mkdirSync(session, { recursive: true });
  writeFileSync(
    join(session, 'events.jsonl'),
    Array.from({ length: 32 }, (_, i) =>
      JSON.stringify({
        invocationId: `inv-${i}`,
        catId: 'codex',
        t: Date.UTC(2026, 0, 1) + i,
        event: { type: 'text', content: `repairtoken transcript ${i}` },
      }),
    ).join('\n'),
  );
  const builder = new IndexBuilder(store, docs, undefined, transcriptRoot);
  reader.exec('BEGIN');
  reader.prepare('SELECT count(*) FROM evidence_passages').get();
  await assert.rejects(builder.backfillPassagesFromTranscript('fixture'), ProjectionCheckpointBackpressureError);
  assert.equal(db.prepare('SELECT count(*) AS n FROM evidence_passages').get().n, 16);
  assert.equal(db.prepare('SELECT count(*) AS n FROM transcript_backfill_files').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM entity_mention_pending_docs').get().n, 1);
  reader.exec('ROLLBACK');
  assert.equal(await builder.backfillPassagesFromTranscript('fixture'), 16);
  assert.equal(db.prepare("SELECT count(*) AS n FROM entity_mentions WHERE source='passage'").get().n, 32);
  assert.equal(db.prepare('SELECT count(*) AS n FROM entity_mention_pending_docs').get().n, 0);
  assert.equal(db.prepare('SELECT count(*) AS n FROM transcript_backfill_files').get().n, 1);
});
