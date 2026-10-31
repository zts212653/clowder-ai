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

async function activateAndEmbed(t, store, builder, anchor) {
  const texts = [];
  const lifecycle = new MemoryEmbeddingLifecycle(
    store,
    builder,
    {
      embedMode: 'off',
      embedModel: 'fixture',
      embedDim: 4,
      embedTimeoutMs: 100,
      maxModelMemMb: 32,
    },
    {
      createEmbeddingService: () => ({
        load: async () => {},
        dispose() {},
        isReady: () => true,
        reprobeIfNeeded: async () => {},
        getModelInfo: () => ({ modelId: 'fixture', modelRev: '1', dim: 4 }),
        embed: async (batch) => {
          texts.push(...batch);
          return batch.map(() => new Float32Array([0, 1, 0, 0]));
        },
      }),
    },
  );
  t.after(() => lifecycle.deactivate());
  assert.equal((await lifecycle.activate('on')).ok, true);
  await builder.embedMissingPassages([anchor]);
  return texts;
}

test('message content changes invalidate persisted vectors even while embedding is inactive', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'review-pr5388-'));
  const docs = join(root, 'docs');
  mkdirSync(join(docs, 'features'), { recursive: true });
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  const db = store.getDb();
  sqliteVec.load(db);
  assert.equal(ensurePassageVectorTable(db, 4), true);
  const vectors = new PassageVectorStore(db, 4);
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });

  const thread = { id: 'stable', title: 'Stable', lastActiveAt: 1000, participants: [] };
  const messages = [
    {
      id: 'message-0',
      threadId: 'stable',
      content: 'Original searchable text',
      timestamp: 1000,
    },
  ];
  const builder = new IndexBuilder(
    store,
    docs,
    undefined,
    undefined,
    () => [thread],
    () => messages,
  );
  await builder.rebuild();
  const key = passageVectorKey('thread-stable', 'msg-message-0');
  vectors.upsert(key, new Float32Array([1, 0, 0, 0]));

  messages[0].catId = 'codex61-sol';
  messages[0].timestamp = 2000;
  builder.markThreadDirty('stable');
  await builder.flushDirtyThreads();
  assert.equal(vectors.count(), 1, 'metadata-only refresh should retain the vector while embedding is off');

  messages[0].content = 'Changed searchable text';
  builder.markThreadDirty('stable');
  await builder.flushDirtyThreads();
  assert.equal(
    db.prepare('SELECT content FROM evidence_passages WHERE passage_id=?').get('msg-message-0').content,
    'Changed searchable text',
  );
  assert.equal(vectors.count(), 0, 'changed text invalidates its vector while still off');
  assert.deepEqual(await activateAndEmbed(t, store, builder, 'thread-stable'), ['Changed searchable text']);
  assert.equal(vectors.count(), 1);
  assert.equal(vectors.search(new Float32Array([0, 1, 0, 0]), 1)[0].distance, 0);
});

test('an off-at-boot refresh cannot preserve a stale vec0 row until later activation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'review-pr5388-restart-'));
  const docs = join(root, 'docs');
  const dbPath = join(root, 'evidence.sqlite');
  mkdirSync(join(docs, 'features'), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const thread = { id: 'restart', title: 'Restart', lastActiveAt: 1000, participants: [] };
  const messages = [{ id: 'message-0', threadId: 'restart', content: 'Old body', timestamp: 1000 }];

  const first = new SqliteEvidenceStore(dbPath);
  await first.initialize();
  sqliteVec.load(first.getDb());
  assert.equal(ensurePassageVectorTable(first.getDb(), 4), true);
  const firstBuilder = new IndexBuilder(
    first,
    docs,
    undefined,
    undefined,
    () => [thread],
    () => messages,
  );
  await firstBuilder.rebuild();
  new PassageVectorStore(first.getDb(), 4).upsert(
    passageVectorKey('thread-restart', 'msg-message-0'),
    new Float32Array([1, 0, 0, 0]),
  );
  first.close();

  const restarted = new SqliteEvidenceStore(dbPath);
  await restarted.initialize();
  assert.equal(restarted.getDb().prepare("SELECT 1 FROM pragma_module_list WHERE name='vec0'").get(), undefined);
  const restartedBuilder = new IndexBuilder(
    restarted,
    docs,
    undefined,
    undefined,
    () => [thread],
    () => messages,
  );
  messages[0].content = 'New body after off-at-boot refresh';
  restartedBuilder.markThreadDirty('restart');
  await restartedBuilder.flushDirtyThreads();

  sqliteVec.load(restarted.getDb());
  const persisted = new PassageVectorStore(restarted.getDb(), 4);
  assert.equal(persisted.count(), 0, 'cold off refresh cannot retain the old vector');
  assert.deepEqual(await activateAndEmbed(t, restarted, restartedBuilder, 'thread-restart'), [
    'New body after off-at-boot refresh',
  ]);
  restarted.close();
});

test('document replacement retains unchanged text and invalidates changed or removed text while off', async (t) => {
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  t.after(() => store.close());
  const db = store.getDb();
  sqliteVec.load(db);
  ensurePassageVectorTable(db, 4);
  const vectors = new PassageVectorStore(db, 4);
  const builder = new IndexBuilder(store, '.');
  const source = {
    item: { anchor: 'F001', sourcePath: 'features/F001.md', updatedAt: '2026-01-01' },
    passages: ['Stable text', 'Removed text'],
  };
  await builder.indexDocumentPassages([source]);
  const keys = db
    .prepare('SELECT passage_id AS id FROM evidence_passages WHERE doc_anchor=? ORDER BY position')
    .all('F001');
  for (const k of keys) vectors.upsert(passageVectorKey('F001', k.id), new Float32Array([1, 0, 0, 0]));
  source.item.updatedAt = '2026-01-02';
  await builder.indexDocumentPassages([source]);
  assert.equal(vectors.count(), 2);
  source.passages = ['Changed document text'];
  await builder.indexDocumentPassages([source]);
  assert.equal(vectors.count(), 0);
  assert.deepEqual(await activateAndEmbed(t, store, builder, 'F001'), ['Changed document text']);
});

test('recall suppression removes persisted passage and document vectors with embedding off', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'off-recall-'));
  mkdirSync(join(root, 'features'));
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const messages = [{ id: 'one', threadId: 'stable', content: 'Recalled body', timestamp: 1000 }];
  const builder = new IndexBuilder(
    store,
    root,
    undefined,
    undefined,
    () => [{ id: 'stable', title: 'Stable', lastActiveAt: 1000, participants: [] }],
    () => messages,
  );
  await builder.rebuild();
  const db = store.getDb();
  sqliteVec.load(db);
  ensurePassageVectorTable(db, 4);
  ensureVectorTable(db, 4);
  const passages = new PassageVectorStore(db, 4),
    docs = new VectorStore(db, 4);
  passages.upsert(passageVectorKey('thread-stable', 'msg-one'), new Float32Array([1, 0, 0, 0]));
  docs.upsert('thread-stable', new Float32Array([1, 0, 0, 0]));
  const lease = await builder.suppressMessagePassage('stable', 'one');
  assert.equal(passages.count(), 0);
  assert.equal(docs.count(), 0);
  await builder.releaseMessagePassageSuppression(lease);
  assert.deepEqual(await activateAndEmbed(t, store, builder, 'thread-stable'), ['Recalled body']);
});

test('a vector-free index remains lexical without registering or creating vec0', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'plain-index-'));
  mkdirSync(join(root, 'features'));
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const messages = [{ id: 'one', threadId: 'plain', content: 'Old lexical body', timestamp: 1000 }];
  const builder = new IndexBuilder(
    store,
    root,
    undefined,
    undefined,
    () => [{ id: 'plain', lastActiveAt: 1000, participants: [] }],
    () => messages,
  );
  await builder.rebuild();
  messages[0].content = 'New lexical body';
  builder.markThreadDirty('plain');
  await builder.flushDirtyThreads();
  assert.equal(
    store.getDb().prepare('SELECT content FROM evidence_passages WHERE passage_id=?').get('msg-one').content,
    messages[0].content,
  );
  assert.equal(store.getDb().prepare("SELECT 1 FROM pragma_module_list WHERE name='vec0'").get(), undefined);
  assert.equal(store.getDb().prepare("SELECT 1 FROM sqlite_master WHERE name='passage_vectors'").get(), undefined);
});
