import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readEmbeddingDeployment } from '../../dist/domains/memory/embedding-generation-config.js';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { MemoryEmbeddingLifecycle } from '../../dist/domains/memory/MemoryEmbeddingLifecycle.js';
import { openVectorGeneration } from '../../dist/domains/memory/open-vector-generation.js';
import { ShadowVectorGenerationBuilder } from '../../dist/domains/memory/ShadowVectorGenerationBuilder.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { generationIdentity } from '../../dist/domains/memory/vector-generation-identity.js';
import { readPendingVectorSources } from '../../dist/domains/memory/vector-generation-pending.js';
import { inspectVectorGeneration } from '../../dist/domains/memory/vector-generation-readiness.js';
import { captureVectorSource, commitVectorSource } from '../../dist/domains/memory/vector-source-binding.js';

const model = { modelId: 'null-hash-fixture', modelRev: '1', dim: 4, generationId: 'g0' };
const unit = () => new Float32Array([1, 0, 0, 0]);
const options = () => ({ deadlineAt: Date.now() + 10_000, maxBatches: 8, batchSize: 2 });
const doc = (anchor, sourceHash) => ({
  anchor,
  kind: 'thread',
  status: 'active',
  title: anchor,
  sourceHash,
  updatedAt: '2026-11-15',
});

async function fixture(t, file = true, generation = 'g0') {
  const root = mkdtempSync(join(tmpdir(), 'g0-null-source-'));
  const store = new SqliteEvidenceStore(file ? join(root, 'synthetic.sqlite') : ':memory:');
  await store.initialize();
  await store.upsert([doc('absent-hash'), doc('empty-hash', ''), doc('known-hash', 'known')]);
  const db = store.getDb();
  db.prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)').run(
    'absent-hash',
    'p-one',
    'synthetic passage',
    '2026-11-15',
  );
  const identity = {
    ...model,
    generationId: generation,
    ...(generation === 'g1' ? { representationFingerprint: 'a'.repeat(64) } : {}),
  };
  const backend = openVectorGeneration(db, identity, { create: true });
  backend.vectorStore.initMeta(identity);
  db.prepare("INSERT INTO vector_generations VALUES(?,?,'building')").run(generation, generationIdentity(identity));
  const inputs = [];
  let hook = async () => {};
  const provider = {
    load: async () => {},
    isReady: () => true,
    dispose() {},
    reprobeIfNeeded: async () => {},
    getModelInfo: () => ({ ...identity }),
    embed: async (texts, signal) => {
      inputs.push(...texts);
      await hook(texts, signal);
      return texts.map(unit);
    },
  };
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    store,
    db,
    identity,
    backend,
    provider,
    inputs,
    onEncode: (fn) => {
      hook = fn;
    },
  };
}

for (const file of [false, true]) {
  test(`G0 nullable source hashes finish once and remain complete after repair (${file ? 'file child' : 'memory'})`, async (t) => {
    const f = await fixture(t, file);
    assert.equal(
      f.db.prepare("SELECT source_hash FROM evidence_docs WHERE anchor='absent-hash'").get().source_hash,
      null,
    );
    const first = await new ShadowVectorGenerationBuilder(f.store, f.provider).build(options());
    assert.equal(first.status, 'ready', JSON.stringify(first));
    assert.equal(first.committed, 4, 'three documents and one passage each commit once');
    const second = await new ShadowVectorGenerationBuilder(f.store, f.provider).build(options());
    assert.equal(second.status, 'ready');
    assert.equal(second.committed, 0, 'a quiet completed source must not consume every future batch');
    assert.equal(f.inputs.length, 4);
    assert.equal(inspectVectorGeneration(f.db, f.identity).missingDocuments, 0);
    assert.deepEqual(readPendingVectorSources(f.db, f.identity, 8).sources, []);
  });
}

test('G0 proof absence normalization still rejects real hashes, invalidation and absent physical vectors', async (t) => {
  const f = await fixture(t, false);
  for (const anchor of ['absent-hash', 'empty-hash', 'known-hash']) {
    const source = captureVectorSource(f.db, 'documents', anchor);
    assert.equal(commitVectorSource(f.db, f.backend.vectorStore, source, unit(), f.identity), true);
  }
  assert.equal(inspectVectorGeneration(f.db, f.identity).missingDocuments, 0);
  const proof = f.db.prepare('UPDATE document_vector_sources SET source_hash=? WHERE anchor=?');
  proof.run('unexpected-nonempty', 'absent-hash');
  proof.run('different', 'known-hash');
  assert.equal(inspectVectorGeneration(f.db, f.identity).missingDocuments, 2);
  assert.deepEqual(
    readPendingVectorSources(f.db, f.identity, 8)
      .sources.filter((s) => s.kind === 'documents')
      .map((s) => s.key),
    ['absent-hash', 'known-hash'],
  );
  proof.run('', 'absent-hash');
  proof.run('known', 'known-hash');
  f.db.prepare("UPDATE document_vector_sources SET revision_hash='invalidated' WHERE anchor='empty-hash'").run();
  assert.equal(inspectVectorGeneration(f.db, f.identity).missingDocuments, 1);
  f.db
    .prepare("UPDATE document_vector_sources SET revision_hash=? WHERE anchor='empty-hash'")
    .run(captureVectorSource(f.db, 'documents', 'empty-hash').revisionHash);
  f.backend.vectorStore.delete('absent-hash');
  assert.equal(inspectVectorGeneration(f.db, f.identity).missingDocuments, 1);
});

test('NULL to empty canonical mutation still retires an in-flight revision even though both lack a source hash', async (t) => {
  const f = await fixture(t, false),
    before = captureVectorSource(f.db, 'documents', 'absent-hash');
  assert.equal(before.sourceHash, '');
  await f.store.upsert([doc('absent-hash', '')]);
  assert.equal(commitVectorSource(f.db, f.backend.vectorStore, before, unit(), f.identity), false);
  const current = captureVectorSource(f.db, 'documents', 'absent-hash');
  assert.notEqual(current.revisionHash, before.revisionHash);
  assert.equal(commitVectorSource(f.db, f.backend.vectorStore, current, unit(), f.identity), true);
});

test('G1 nullable hashes keep strict revision proof and complete the existing shadow path', async (t) => {
  const f = await fixture(t, true, 'g1');
  const result = await new ShadowVectorGenerationBuilder(f.store, f.provider).build(options());
  assert.equal(result.status, 'ready');
  f.db.prepare("UPDATE document_vector_sources_g1 SET revision_hash=NULL WHERE anchor='absent-hash'").run();
  assert.equal(inspectVectorGeneration(f.db, f.identity).missingDocuments, 1);
});

test('a registered G0 cohort with nullable sources catches finite live publication and reaches ready', async (t) => {
  const left = await fixture(t),
    right = await fixture(t),
    stores = [left.store, right.store];
  let ready = false,
    calls = 0;
  const provider = {
    ...left.provider,
    load: async () => {
      ready = true;
    },
    isReady: () => ready,
    dispose() {
      ready = false;
    },
    embed: async (texts) => {
      assert.ok(texts.length <= 2);
      if (++calls === 1) await left.store.upsert([doc('arrived-during-encode')]);
      return texts.map(unit);
    },
  };
  const lifecycle = new MemoryEmbeddingLifecycle(
    left.store,
    new IndexBuilder(left.store, '/unused'),
    {
      embedMode: 'on',
      embedModel: model.modelId,
      embedDim: 4,
      embedTimeoutMs: 100,
      maxModelMemMb: 32,
    },
    {
      getDeployment: readEmbeddingDeployment,
      getDependentStores: () => stores,
      createEmbeddingService: () => provider,
    },
  );
  try {
    const result = await lifecycle.activate('on');
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(lifecycle.getStatus(), 'ready');
    for (const store of stores) {
      assert.equal(inspectVectorGeneration(store.getDb(), model).ready, true);
      assert.equal(store.searchEmbedding().getModelInfo().modelId, model.modelId);
    }
  } finally {
    lifecycle.deactivate();
  }
});
