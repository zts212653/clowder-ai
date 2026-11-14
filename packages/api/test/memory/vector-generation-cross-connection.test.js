import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { openVectorGeneration } from '../../dist/domains/memory/open-vector-generation.js';
import { PassageVectorStore, passageVectorKey } from '../../dist/domains/memory/PassageVectorStore.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import {
  prepareGenerationInvalidationConnection,
  reconcileGenerationInvalidations,
} from '../../dist/domains/memory/vector-generation-invalidation.js';
import { captureVectorSource, commitVectorSource } from '../../dist/domains/memory/vector-source-binding.js';

const unit = (dim) => Float32Array.from({ length: dim }, (_, i) => Number(i === 0));
async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'generation-cross-connection-'));
  const path = join(root, 'evidence.sqlite');
  const store = new SqliteEvidenceStore(path);
  await store.initialize();
  // A real second writer is opened before vector tables exist; its loader alone later fails.
  const writerStore = new SqliteEvidenceStore(path);
  await writerStore.initialize();
  const writer = writerStore.getDb();
  writer.pragma('busy_timeout=5000');
  await store.upsert([
    {
      anchor: 'thread-neutral',
      title: 'Original',
      summary: 'body',
      kind: 'thread',
      status: 'active',
      sourceHash: 'h1',
      updatedAt: '2026-11-09',
    },
  ]);
  store
    .getDb()
    .prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)')
    .run('thread-neutral', 'msg-neutral', 'Original passage', '2026-11-09');
  const models = [
    { modelId: 'neutral-g0', modelRev: '1', dim: 4, generationId: 'g0' },
    { modelId: 'neutral-g1', modelRev: '1', dim: 6, generationId: 'g1', representationFingerprint: 'a'.repeat(64) },
  ];
  const backends = models.map((model) => {
    const backend = openVectorGeneration(store.getDb(), model, { create: true });
    backend.vectorStore.initMeta(model);
    if (model.generationId === 'g1')
      store
        .getDb()
        .prepare("INSERT INTO vector_generations VALUES('g1',?,'ready')")
        .run(model.representationFingerprint);
    for (const [kind, key, target] of [
      ['documents', 'thread-neutral', backend.vectorStore],
      ['passages', passageVectorKey('thread-neutral', 'msg-neutral'), backend.passageVectorStore],
    ])
      assert.equal(
        commitVectorSource(
          store.getDb(),
          target,
          captureVectorSource(store.getDb(), kind, key),
          unit(model.dim),
          model,
        ),
        true,
      );
    return backend;
  });
  const reader = new Database(path, { readonly: true });
  writer.loadExtension = () => {
    throw new Error('controlled missing native extension on writer B');
  };
  const fault = () => prepareGenerationInvalidationConnection(writer);
  const recover = () => {
    for (const backend of backends) reconcileGenerationInvalidations(store.getDb(), backend.vectorStore.tables);
  };
  const embedding = {
    load: async () => {},
    reprobeIfNeeded: async () => {},
    isReady: () => true,
    getModelInfo: () => models[0],
    embed: async (texts) => texts.map(() => unit(4)),
  };
  store.setEmbedDeps({ ...backends[0], embedding, mode: 'on' });
  t.after(() => {
    reader.close();
    writerStore.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { store, writerStore, writer, reader, models, backends, fault, recover };
}

test('native-unavailable writer quarantines live handles and new readonly openers in both generations', async (t) => {
  const f = await fixture(t);
  const readers = f.models.map((model) => openVectorGeneration(f.reader, model));
  for (let i = 0; i < 2; i++) assert.equal(readers[i].vectorStore.search(unit(f.models[i].dim), 1).length, 1);
  const borrowed = f.store.searchEmbedding();
  f.fault();
  f.writer.prepare("UPDATE evidence_docs SET title='Modified',source_hash='h2' WHERE anchor='thread-neutral'").run();
  for (let i = 0; i < 2; i++) {
    const live = readers[i];
    const fresh = openVectorGeneration(f.reader, f.models[i]);
    assert.deepEqual(live.vectorStore.search(unit(f.models[i].dim), 1), []);
    assert.deepEqual(live.passageVectorStore.search(unit(f.models[i].dim), 1), []);
    assert.deepEqual(fresh.vectorStore.search(unit(f.models[i].dim), 1), []);
    assert.deepEqual(fresh.passageVectorStore.search(unit(f.models[i].dim), 1), []);
  }
  assert.equal(borrowed.isCurrent(), false);
  f.recover();
  assert.equal(borrowed.isCurrent(), false, 'recovery cannot revive a capability borrowed before quarantine');
  for (let i = 0; i < 2; i++)
    assert.deepEqual(openVectorGeneration(f.reader, f.models[i]).vectorStore.search(unit(f.models[i].dim), 1), []);
  assert.equal((await f.store.getByAnchor('thread-neutral')).title, 'Modified');
});

test('a native result prepared before quarantine is discarded even if recovery precedes return', async (t) => {
  const f = await fixture(t);
  let observed = 0;
  const before = f.store.searchEmbedding();
  const passages = new PassageVectorStore(f.store.getDb(), 4, (query) => {
    const rows = query();
    observed = rows.length;
    f.fault();
    f.writer.prepare("UPDATE evidence_passages SET content='Changed' WHERE doc_anchor='thread-neutral'").run();
    f.recover();
    return rows;
  });
  assert.deepEqual(passages.search(unit(4), 1), []);
  assert.equal(observed, 1, 'the fixture used an actual native KNN result before invalidating it');
  assert.equal(before.isCurrent(), false);
});

for (const action of ['delete', 'forget'])
  test(`native-unavailable ${action} remains canonical and retires both generations`, async (t) => {
    const f = await fixture(t);
    const before = f.store.searchEmbedding();
    const readers = f.models.map((model) => openVectorGeneration(f.reader, model));
    f.fault();
    if (action === 'delete') await f.writerStore.deleteByAnchor('thread-neutral');
    else {
      const builder = new IndexBuilder(f.writerStore, '/unused');
      const lease = await builder.suppressMessagePassage('neutral', 'neutral');
      await builder.finalizeMessagePassageSuppression(lease);
      assert.equal(
        f.writer.prepare("SELECT state FROM message_recall_index_suppressions WHERE doc_anchor='thread-neutral'").get()
          .state,
        'committed',
      );
    }
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(readers[i].vectorStore.search(unit(f.models[i].dim), 1), []);
      assert.deepEqual(readers[i].passageVectorStore.search(unit(f.models[i].dim), 1), []);
    }
    f.recover();
    assert.equal(before.isCurrent(), false);
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(readers[i].vectorStore.search(unit(f.models[i].dim), 1), []);
      assert.deepEqual(readers[i].passageVectorStore.search(unit(f.models[i].dim), 1), []);
    }
  });

for (const mode of ['semantic', 'hybrid'])
  test(`in-flight ${mode} worker retires the pre-fault capability with the original caller lifetime`, async (t) => {
    const f = await fixture(t);
    let calls = 0;
    const caller = new AbortController();
    const embedding = {
      load: async () => {},
      reprobeIfNeeded: async () => {},
      isReady: () => true,
      getModelInfo: () => f.models[0],
      embed: async (texts) => {
        calls++;
        f.fault();
        f.writer
          .prepare("UPDATE evidence_passages SET content='Current replacement' WHERE doc_anchor='thread-neutral'")
          .run();
        f.recover();
        return texts.map(() => unit(4));
      },
    };
    f.store.setEmbedDeps({ ...f.backends[0], embedding, mode: 'on' });
    const reads = [];
    const deadlineAt = Date.now() + 10000;
    const result = await f.store.searchMessagePassages('Original passage', {
      mode,
      visibleThreadIds: ['neutral'],
      candidateOrder: 'relevance',
      signal: caller.signal,
      deadlineAt,
      onReadSnapshot: (s) => reads.push(s),
    });
    assert.equal(result.meta.effectiveMode, 'lexical');
    assert.equal(result.meta.degraded, true);
    assert.ok(result.passages.every((p) => p.content !== 'Original passage'));
    assert.equal(calls, 1, 'retirement cannot obtain another model request during lexical recovery');
    assert.equal(caller.signal.aborted, false);
    assert.ok(reads.at(-1).pid > 0, 'the boundary includes a real file worker');
    assert.ok(Date.now() < deadlineAt);
  });

test('caller cancellation still wins a concurrent quarantine and recovery', async (t) => {
  const f = await fixture(t);
  const caller = new AbortController();
  let calls = 0;
  const embedding = {
    load: async () => {},
    reprobeIfNeeded: async () => {},
    isReady: () => true,
    getModelInfo: () => f.models[0],
    embed: async (texts) => {
      calls++;
      f.fault();
      f.writer.prepare("UPDATE evidence_passages SET content='Current' WHERE doc_anchor='thread-neutral'").run();
      f.recover();
      caller.abort(new DOMException('caller left', 'AbortError'));
      return texts.map(() => unit(4));
    },
  };
  f.store.setEmbedDeps({ ...f.backends[0], embedding, mode: 'on' });
  await assert.rejects(
    f.store.searchMessagePassages('Original', {
      mode: 'hybrid',
      visibleThreadIds: ['neutral'],
      signal: caller.signal,
      deadlineAt: Date.now() + 10000,
    }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1);
});

test('recovery on a healthy connection cannot break later writes on the unavailable connection', async (t) => {
  const f = await fixture(t);
  f.fault();
  f.writer.prepare("UPDATE evidence_docs SET title='First change' WHERE anchor='thread-neutral'").run();
  prepareGenerationInvalidationConnection(f.store.getDb());
  f.recover();
  assert.doesNotThrow(() =>
    f.writer.prepare("UPDATE evidence_docs SET title='Second change' WHERE anchor='thread-neutral'").run(),
  );
  for (let i = 0; i < 2; i++)
    assert.deepEqual(openVectorGeneration(f.reader, f.models[i]).vectorStore.search(unit(f.models[i].dim), 1), []);
  assert.equal((await f.store.getByAnchor('thread-neutral')).title, 'Second change');
});
