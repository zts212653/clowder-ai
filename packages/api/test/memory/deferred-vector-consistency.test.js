import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

async function fixture(t, initialModel = 'model-B', disk = false) {
  const root = mkdtempSync(join(tmpdir(), 'deferred-vector-consistency-'));
  mkdirSync(join(root, 'features'));
  const store = new SqliteEvidenceStore(disk ? join(root, 'evidence.sqlite') : ':memory:');
  await store.initialize();
  const db = store.getDb();
  sqliteVec.load(db);
  ensureVectorTable(db, 4);
  ensurePassageVectorTable(db, 4);
  const vectors = new VectorStore(db, 4);
  const passages = new PassageVectorStore(db, 4);
  let model = initialModel;
  const calls = [];
  const embedding = {
    reprobeIfNeeded: async () => {},
    isReady: () => true,
    getModelInfo: () => ({ modelId: model, modelRev: '1', dim: 4 }),
    embed: async (texts) => {
      calls.push(...texts);
      return texts.map((text) => {
        const lower = text.toLowerCase();
        if (lower.includes('gamma')) return new Float32Array([0, -1, 0, 0]);
        const alpha = lower.includes('alpha') || lower === 'queryneedle';
        return new Float32Array(alpha === (model === 'model-A') ? [1, 0, 0, 0] : [0, 1, 0, 0]);
      });
    },
  };
  const deps = { embedding, vectorStore: vectors, passageVectorStore: passages };
  const builder = new IndexBuilder(store, root, deps);
  store.setEmbedDeps({ ...deps, mode: 'on' });
  const write = (anchor, name) =>
    writeFileSync(
      join(root, 'features', `${anchor}.md`),
      `---\nanchor: ${anchor}\nstatus: active\n---\n# ${name}\n\nFind ${name} retained source content.\n`,
    );
  write('alpha-doc', 'Alpha');
  write('beta-doc', 'Beta');
  await builder.rebuild();
  calls.length = 0;
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    deps,
    db,
    builder,
    store,
    vectors,
    passages,
    calls,
    write,
    setModel: (value) => {
      model = value;
    },
  };
}

const deferred = { deferThreadIndexing: true, deferDocumentEmbedding: true };
// A non-literal query isolates native geometry from the existing passage/FTS augmentation.
const search = (f, mode = 'semantic') => f.store.searchWithMeta('queryneedle', { mode, limit: 1 });

test('deferred startup retires old model geometry before public semantic or hybrid search', async (t) => {
  const f = await fixture(t, 'model-A');
  f.setModel('model-B');
  await f.builder.rebuild(deferred);
  assert.equal(f.calls.length, 0, 'pre-listen consistency must not invoke embedding');
  const before = await search(f);
  assert.deepEqual(
    before.items.map((x) => x.anchor),
    [],
    'old model vectors must not participate before catch-up',
  );
  const hybrid = await search(f, 'hybrid');
  assert.deepEqual(
    hybrid.items.map((x) => x.anchor),
    [],
  );
  assert.equal(
    (await f.store.search('Alpha', { mode: 'lexical' }))[0].anchor,
    'alpha-doc',
    'canonical lexical evidence stays available',
  );
  const result = await f.builder.embedMissingDocumentVectors();
  assert.equal(result.docsEmbedded, 2);
  assert.deepEqual(
    (await search(f)).items.map((x) => x.anchor),
    ['alpha-doc'],
  );
});

test('deferred startup excludes changed source vectors while retaining current native vectors', async (t) => {
  const f = await fixture(t);
  const currentBeta = Buffer.from(
    f.db.prepare('SELECT embedding FROM evidence_vectors WHERE anchor=?').get('beta-doc').embedding,
  );
  f.builder.setEmbedDeps(undefined);
  f.write('alpha-doc', 'Gamma');
  await f.builder.rebuild({ deferThreadIndexing: true });
  const mismatch = await f.store.getIndexedSourceRevision('alpha-doc');
  assert.notEqual(mismatch.sourceHash, mismatch.vectorSourceHash);
  const restarted = new IndexBuilder(f.store, f.root, f.deps);
  await restarted.rebuild(deferred);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(
    (await search(f)).items.map((x) => x.anchor),
    ['beta-doc'],
    'stale alpha geometry cannot rank a current Gamma body',
  );
  assert.deepEqual(
    (await search(f, 'hybrid')).items.map((x) => x.anchor),
    ['beta-doc'],
  );
  assert.deepEqual(
    Buffer.from(f.db.prepare('SELECT embedding FROM evidence_vectors WHERE anchor=?').get('beta-doc').embedding),
    currentBeta,
  );
  const result = await restarted.embedMissingDocumentVectors();
  assert.equal(result.docsEmbedded, 1, 'only the changed source should require embedding');
  assert.deepEqual(
    (await search(f)).items.map((x) => x.anchor),
    ['beta-doc'],
  );
  const source = await f.store.getIndexedSourceRevision('alpha-doc');
  assert.equal(source.sourceHash, source.vectorSourceHash);
});

test('deferred startup still adopts unchanged legacy vectors through the existing source proof', async (t) => {
  const f = await fixture(t);
  f.db.prepare('DELETE FROM document_vector_sources').run();
  const restarted = new IndexBuilder(f.store, f.root, f.deps);
  await restarted.rebuild(deferred);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(
    (await search(f)).items.map((x) => x.anchor),
    ['alpha-doc'],
  );
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM document_vector_sources').get().n, 2);
  assert.equal((await restarted.embedMissingDocumentVectors()).docsEmbedded, 0);
});

test('cold metadata cannot relabel a passage-only old corpus as the current model', async (t) => {
  const f = await fixture(t, 'model-A');
  const doc = f.db.prepare('SELECT * FROM evidence_passages WHERE doc_anchor=? LIMIT 1').get('alpha-doc');
  f.passages.upsert(passageVectorKey(doc.doc_anchor, doc.passage_id), new Float32Array([1, 0, 0, 0]));
  f.db.exec("DELETE FROM evidence_vectors; DELETE FROM embedding_meta WHERE key LIKE 'embedding_%'");
  f.setModel('model-B');
  await f.builder.rebuild(deferred);
  assert.equal(f.calls.length, 0);
  assert.equal(f.passages.count(), 0, 'unattributed passage geometry is not safe under the current model');
  assert.deepEqual(await f.store.search('queryneedle', { mode: 'semantic', depth: 'raw', limit: 1 }), []);
});

// The API deliberately catches startup rebuild failures and continues listening.
// Native rollback must preserve bytes without making that old projection public.
for (const disk of [false, true]) {
  for (const change of ['model', 'source']) {
    test(`${disk ? 'worker' : 'local'} public search fails closed after ${change} preparation rollback and recovers`, async (t) => {
      const f = await fixture(t, change === 'model' ? 'model-A' : 'model-B', disk);
      if (change === 'model') f.setModel('model-B');
      else {
        f.builder.setEmbedDeps(undefined);
        f.write('alpha-doc', 'Gamma');
        await f.builder.rebuild({ deferThreadIndexing: true });
      }
      const builder = new IndexBuilder(f.store, f.root, f.deps);
      f.db.exec(`CREATE TRIGGER reject_vector_preparation BEFORE DELETE ON document_vector_sources
        BEGIN SELECT RAISE(ABORT, 'controlled projection preparation failure'); END`);
      await assert.rejects(builder.rebuild(deferred), /controlled projection preparation failure/);
      assert.equal(f.calls.length, 0, 'failed preparation must not call the provider');
      assert.equal(f.vectors.count(), 2, 'SQLite rollback preserves the existing corpus');
      if (change === 'model') assert.equal(f.vectors.getMeta().embedding_model_id, 'model-A');
      else {
        const revision = await f.store.getIndexedSourceRevision('alpha-doc');
        assert.notEqual(revision.sourceHash, revision.vectorSourceHash);
      }
      for (const mode of ['semantic', 'hybrid']) {
        const result = await search(f, mode);
        assert.equal(result.meta.degraded, true, `${mode} cannot consume an uncommitted projection`);
        assert.equal(result.meta.effectiveMode, 'lexical');
        assert.deepEqual(result.items, [], 'non-literal query must not get stale geometry');
      }
      const lexicalName = change === 'model' ? 'Alpha' : 'Gamma';
      assert.equal((await f.store.search(lexicalName, { mode: 'lexical' }))[0].anchor, 'alpha-doc');
      f.db.exec('DROP TRIGGER reject_vector_preparation');
      f.calls.length = 0;
      await builder.rebuild(deferred);
      assert.equal(f.calls.length, 0, 'recovery preparation still leaves embedding until after listen');
      assert.equal((await builder.embedMissingDocumentVectors()).docsEmbedded, change === 'model' ? 2 : 1);
      const recovered = await search(f);
      assert.equal(recovered.meta.degraded, false);
      assert.equal(recovered.items[0].anchor, change === 'model' ? 'alpha-doc' : 'beta-doc');
    });
  }
}

test('an earlier startup scan failure cannot bypass projection preparation', async (t) => {
  const f = await fixture(t, 'model-A');
  f.setModel('model-B');
  const failure = new Error('controlled source discovery failure');
  const builder = new IndexBuilder(f.store, f.root, f.deps, undefined, undefined, undefined, undefined, {
    discover() {
      throw failure;
    },
  });
  await assert.rejects(builder.rebuild(deferred), (error) => error === failure);
  const result = await search(f);
  assert.equal(result.meta.degraded, true);
  assert.deepEqual(result.items, []);
});

for (const disk of [false, true])
  test(`${disk ? 'worker' : 'local'} in-flight query cannot outlive a failed projection preparation generation`, async (t) => {
    const f = await fixture(t, 'model-A', disk);
    let entered;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const original = f.deps.embedding.embed;
    f.deps.embedding.embed = async (texts) => {
      if (texts[0] === 'queryneedle') {
        entered();
        await held;
      }
      return original(texts);
    };
    const query = search(f);
    await started;
    try {
      f.setModel('model-B');
      f.db.exec(`CREATE TRIGGER reject_vector_preparation BEFORE DELETE ON document_vector_sources
      BEGIN SELECT RAISE(ABORT, 'controlled projection preparation failure'); END`);
      await assert.rejects(f.builder.rebuild(deferred), /controlled projection preparation failure/);
    } finally {
      release();
    }
    const result = await query;
    assert.equal(result.meta.degraded, true);
    assert.deepEqual(result.items, []);
  });

test('normal rebuild failure also quarantines native passage search while keeping canonical passages', async (t) => {
  const f = await fixture(t, 'model-A');
  const row = f.db.prepare('SELECT doc_anchor, passage_id FROM evidence_passages LIMIT 1').get();
  f.passages.upsert(passageVectorKey(row.doc_anchor, row.passage_id), new Float32Array([0, 1, 0, 0]));
  f.setModel('model-B');
  f.db.exec(`CREATE TRIGGER reject_vector_preparation BEFORE DELETE ON document_vector_sources
    BEGIN SELECT RAISE(ABORT, 'controlled projection preparation failure'); END`);
  await f.builder.rebuild({ deferThreadIndexing: true }); // Existing lexical fail-open owner catches it.
  for (const mode of ['semantic', 'hybrid']) {
    const result = await f.store.searchWithMeta('queryneedle', { mode, depth: 'raw', limit: 1 });
    assert.equal(result.meta.degraded, true);
    assert.deepEqual(result.items, []);
  }
  assert.ok(f.db.prepare('SELECT count(*) AS n FROM evidence_passages').get().n > 0);
});

test('late activation cannot expose an old model before catch-up and a mode-only rebind keeps trusted vectors', async (t) => {
  const f = await fixture(t, 'model-A');
  const service = { ...f.deps.embedding, load: async () => {}, dispose() {} };
  const lifecycle = new MemoryEmbeddingLifecycle(
    f.store,
    f.builder,
    { embedMode: 'on', embedModel: 'model-B', embedDim: 4, embedTimeoutMs: 3000, maxModelMemMb: 800 },
    {
      createEmbeddingService: () => service,
      initializeVectorBackend: async () => ({ vectorStore: f.vectors, passageVectorStore: f.passages }),
    },
  );
  t.after(() => lifecycle.deactivate());
  f.setModel('model-B');
  assert.equal((await lifecycle.activate('on')).ok, true);
  assert.equal((await search(f)).meta.degraded, true, 'provider activation alone does not validate the corpus');
  await f.builder.embedMissingDocumentVectors();
  assert.equal((await search(f)).items[0].anchor, 'alpha-doc');
  await lifecycle.activate('shadow');
  await lifecycle.activate('on');
  assert.equal((await search(f)).meta.degraded, false, 'unchanged capabilities do not retire a trusted projection');
});
