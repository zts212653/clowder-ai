import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readEmbeddingDeployment } from '../../dist/domains/memory/embedding-generation-config.js';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { MemoryEmbeddingLifecycle } from '../../dist/domains/memory/MemoryEmbeddingLifecycle.js';
import { openVectorGeneration } from '../../dist/domains/memory/open-vector-generation.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { inspectVectorGeneration } from '../../dist/domains/memory/vector-generation-readiness.js';

const unit = () => new Float32Array([1, 0, 0, 0]);
async function append(store, prefix, count) {
  await store.upsert(
    Array.from({ length: count }, (_, i) => ({
      anchor: `${prefix}-${i}`,
      title: `${prefix}-${i}`,
      kind: 'thread',
      status: 'active',
      sourceHash: `${prefix}-${i}`,
      updatedAt: '2026-11-11',
    })),
  );
  await store.runExclusive(() => {
    const insert = store
      .getDb()
      .prepare('INSERT INTO evidence_passages(doc_anchor,passage_id,content,created_at) VALUES(?,?,?,?)');
    for (let i = 0; i < count; i++)
      for (let n = 0; n < 2; n++) insert.run(`${prefix}-${i}`, `p-${n}`, `${prefix}-${i} passage ${n}`, '2026-11-11');
  });
}

async function fixture(t, primaryDocuments = 40) {
  const root = mkdtempSync(join(tmpdir(), 'g0-recovery-catchup-'));
  const stores = [
    new SqliteEvidenceStore(join(root, 'primary.sqlite')),
    new SqliteEvidenceStore(join(root, 'collection.sqlite')),
  ];
  const config = {
    embedMode: 'on',
    embedModel: 'replacement',
    embedDim: 4,
    embedModelRev: '1',
    embedTimeoutMs: 100,
    maxModelMemMb: 32,
  };
  const model = { modelId: 'replacement', modelRev: '1', dim: 4, generationId: 'g0' };
  for (const [i, store] of stores.entries()) {
    await store.initialize();
    await append(store, 'initial', i ? 8 : primaryDocuments);
    const old = { ...model, modelId: 'old-identity' };
    openVectorGeneration(store.getDb(), old, { create: true }).vectorStore.initMeta(old);
  }
  let hook = async () => {};
  const inputs = [];
  const lifecycle = new MemoryEmbeddingLifecycle(stores[0], new IndexBuilder(stores[0], '/unused'), config, {
    getDeployment: readEmbeddingDeployment,
    getDependentStores: () => stores,
    createEmbeddingService: (c) => {
      let ready = false;
      return {
        load: async () => {
          ready = true;
        },
        dispose: () => {
          ready = false;
        },
        isReady: () => ready,
        reprobeIfNeeded: async () => {},
        getModelInfo: () => ({ ...model, modelId: c.embedModel, modelRev: c.embedModelRev ?? '1' }),
        embed: async (texts, signal) => {
          assert.ok(texts.length <= 2, 'catch-up must retain the existing encoder batch bound');
          assert.ok(signal && !signal.aborted);
          for (const store of stores) assert.equal(store.searchEmbedding(), undefined, 'no partial cohort publication');
          inputs.push(...texts);
          await hook(texts, signal);
          return texts.map(unit);
        },
      };
    },
  });
  t.after(() => {
    lifecycle.deactivate();
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    stores,
    lifecycle,
    config,
    model,
    inputs,
    onEncode: (fn) => {
      hook = fn;
    },
  };
}

test('a G0 activation catches a moving document/passage tail in its existing window before publishing the whole cohort', async (t) => {
  const f = await fixture(t);
  let calls = 0;
  f.onEncode(async () => {
    calls++;
    if (calls === 1) for (const store of f.stores) await append(store, 'arrived-during-encode', 1);
    if (calls === 4)
      await f.stores[0].runExclusive(() =>
        f.stores[0]
          .getDb()
          .prepare("UPDATE evidence_docs SET title='changed during encode' WHERE anchor='initial-0'")
          .run(),
      );
  });
  const result = await f.lifecycle.activate('on', { rebuildLegacyModel: f.config.embedModel });
  assert.equal(result.ok, true, 'the old sixteen-source ceiling must not strand an otherwise fast repair window');
  for (const store of f.stores) {
    assert.equal(inspectVectorGeneration(store.getDb(), f.model).ready, true);
    assert.equal(store.searchEmbedding().getModelInfo().modelId, f.model.modelId);
    assert.equal(store.getDb().prepare("SELECT state FROM vector_generations WHERE id='g0'").get().state, 'ready');
  }
  assert.ok(f.inputs.length > 144, 'new sources and a changed revision are included, not dropped');
});

test('G0 catch-up still pauses at a finite shared ceiling and resumes only missing proofs across stores', async (t) => {
  const f = await fixture(t, 170); // 510 primary + 24 collection sources.
  assert.equal((await f.lifecycle.activate('on', { rebuildLegacyModel: f.config.embedModel })).ok, false);
  assert.equal(f.inputs.length, 512, 'global window ceiling remains finite across the cohort');
  for (const store of f.stores) assert.equal(store.searchEmbedding(), undefined);
  assert.equal((await f.lifecycle.activate('on')).ok, true);
  assert.equal(f.inputs.length, 534, 'committed source revisions are reused after pause');
  assert.equal(
    f.inputs.filter((text) => text === 'initial-0 passage 0').length,
    2,
    'equal text in two stores is still two source identities',
  );
  for (const store of f.stores) assert.equal(inspectVectorGeneration(store.getDb(), f.model).ready, true);
});

test('more G0 batches do not extend the fifteen-second window or publish a late uncooperative encoding', async (t) => {
  const f = await fixture(t);
  let release, entered, signal;
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  f.onEncode(async (_texts, ownedSignal) => {
    signal = ownedSignal;
    entered();
    await new Promise((resolve) => {
      release = resolve;
    });
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const active = f.lifecycle.activate('on', { rebuildLegacyModel: f.config.embedModel });
  await started;
  t.mock.timers.tick(15_000);
  assert.equal((await active).ok, false);
  assert.equal(signal.aborted, true);
  for (const store of f.stores) assert.equal(store.searchEmbedding(), undefined);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  for (const store of f.stores) {
    assert.equal(openVectorGeneration(store.getDb(), f.model).vectorStore.count(), 0);
    assert.equal(store.getDb().prepare("SELECT state FROM vector_generations WHERE id='g0'").get().state, 'building');
  }
});
