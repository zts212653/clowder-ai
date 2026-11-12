import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { resetLegacyCohort } from '../../dist/domains/memory/embedding-cohort-recovery.js';
import {
  embeddingRecipeFingerprint,
  readEmbeddingDeployment,
} from '../../dist/domains/memory/embedding-generation-config.js';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { MemoryEmbeddingLifecycle } from '../../dist/domains/memory/MemoryEmbeddingLifecycle.js';
import { openVectorGeneration } from '../../dist/domains/memory/open-vector-generation.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { generationInvalidationState } from '../../dist/domains/memory/vector-generation-invalidation.js';
import { captureVectorSource, commitVectorSource } from '../../dist/domains/memory/vector-source-binding.js';

const unit = (dim) => Float32Array.from({ length: dim }, (_, i) => Number(i === 0));
const doc = (anchor, title = 'Original') => ({
  anchor,
  title,
  kind: 'thread',
  status: 'active',
  sourceHash: title,
  updatedAt: '2026-11-09',
});

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'generation-cohort-recovery-'));
  const stores = [
    new SqliteEvidenceStore(join(root, 'primary.sqlite')),
    new SqliteEvidenceStore(join(root, 'collection.sqlite')),
  ];
  for (const store of stores) {
    await store.initialize();
    await store.upsert([doc('retained'), doc('deleted')]);
  }
  const deployment = readEmbeddingDeployment();
  deployment.generations.g1.recipe = { ...deployment.generations.g1.recipe, modelId: 'fixture-new', dim: 6 };
  deployment.generations.g1.runtime.maxModelMemMb = 32;
  const models = [
    { modelId: 'fixture-old', modelRev: '1', dim: 4, generationId: 'g0' },
    {
      modelId: 'fixture-new',
      modelRev: deployment.generations.g1.recipe.modelRevision,
      dim: 6,
      generationId: 'g1',
      representationFingerprint: embeddingRecipeFingerprint(deployment.generations.g1.recipe),
    },
  ];
  for (const store of stores)
    for (const model of models) {
      const backend = openVectorGeneration(store.getDb(), model, { create: true });
      backend.vectorStore.initMeta(model);
      if (model.generationId === 'g1')
        store
          .getDb()
          .prepare("INSERT INTO vector_generations VALUES('g1',?,'ready')")
          .run(model.representationFingerprint);
      for (const key of ['retained', 'deleted'])
        assert.equal(
          commitVectorSource(
            store.getDb(),
            backend.vectorStore,
            captureVectorSource(store.getDb(), 'documents', key),
            unit(model.dim),
            model,
          ),
          true,
        );
    }
  const config = { embedMode: 'on', embedModel: 'fixture-old', embedDim: 4, embedTimeoutMs: 100, maxModelMemMb: 32 };
  let encodeHook;
  const created = [];
  const lifecycle = new MemoryEmbeddingLifecycle(stores[0], new IndexBuilder(stores[0], '/unused'), config, {
    getDeployment: () => structuredClone(deployment),
    getDependentStores: () => stores,
    createEmbeddingService: (c) => {
      let ready = false;
      const service = {
        load: async () => {
          ready = true;
        },
        isReady: () => ready,
        dispose: () => {
          ready = false;
        },
        reprobeIfNeeded: async () => {},
        embed: async (texts, signal) => {
          await encodeHook?.(texts, signal);
          return texts.map(() => unit(c.embedDim));
        },
        getModelInfo: () => ({
          modelId: c.embedModel,
          modelRev: c.embedModelRev ?? '1',
          dim: c.embedDim,
          generationId: c.generationId,
          ...(c.representationFingerprint ? { representationFingerprint: c.representationFingerprint } : {}),
        }),
      };
      created.push(service);
      return service;
    },
  });
  t.after(() => {
    lifecycle.deactivate();
    for (const store of stores) store.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    stores,
    deployment,
    config,
    models,
    lifecycle,
    created,
    onEncode: (hook) => {
      encodeHook = hook;
    },
  };
}

function assertCoverage(f, model) {
  for (const store of f.stores) {
    const backend = openVectorGeneration(store.getDb(), model);
    const keys = backend.vectorStore
      .search(unit(model.dim), 10)
      .map((r) => r.anchor)
      .sort();
    assert.deepEqual(keys, ['added', 'retained']);
    assert.equal(store.getVectorGenerationTables().generationId, model.generationId);
    assert.ok(store.searchEmbedding()?.isCurrent());
  }
}

test('same-dimensional G0 reconfiguration cannot mix any dependent store; the controlled cohort rebuild retires and replaces both', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.lifecycle.activate('on')).ok, true);
  const previous = f.lifecycle.getService();
  f.config.embedModel = 'fixture-other-same-dim';
  const refused = await f.lifecycle.activate('on');
  assert.equal(refused.ok, false, 'identity mismatch in any enabled store must block the whole publication');
  assert.equal(f.lifecycle.getService(), previous);
  assert.equal(f.stores[1].searchEmbedding().getModelInfo().modelId, 'fixture-old');
  f.onEncode(() => {
    for (const store of f.stores)
      assert.equal(
        store.searchEmbedding(),
        undefined,
        'all search bindings close before the first destructive replacement',
      );
  });
  assert.equal((await f.lifecycle.activate('on', { rebuildLegacyModel: f.config.embedModel })).ok, true);
  for (const store of f.stores) {
    assert.equal(store.searchEmbedding().getModelInfo().modelId, 'fixture-other-same-dim');
    assert.equal(
      openVectorGeneration(store.getDb(), { ...f.models[0], modelId: f.config.embedModel }).vectorStore.count(),
      2,
    );
  }
});

test('G0 rollback repairs changed and added sources in both file stores without resurrecting deletes', async (t) => {
  const f = await fixture(t);
  await f.lifecycle.activate('on');
  f.deployment.activeId = 'g1';
  assert.equal((await f.lifecycle.activate('on')).ok, true);
  for (const store of f.stores) {
    await store.upsert([doc('retained', 'Changed'), doc('added')]);
    await store.deleteByAnchor('deleted');
  }
  f.deployment.activeId = 'g0';
  f.onEncode(() => {
    for (const store of f.stores) assert.equal(store.searchEmbedding(), undefined);
  });
  assert.equal((await f.lifecycle.activate('on')).ok, true);
  assertCoverage(f, f.models[0]);
});

test('a ready callback recovers the previously complete G1 cohort after an outage while every read remains closed until publication', async (t) => {
  const f = await fixture(t);
  await f.lifecycle.activate('on');
  f.deployment.activeId = 'g1';
  await f.lifecycle.activate('on');
  f.lifecycle.deactivate({ retainLegacy: true });
  for (const store of f.stores) {
    await store.upsert([doc('retained', 'Changed during outage'), doc('added')]);
    await store.deleteByAnchor('deleted');
  }
  f.onEncode(() => {
    for (const store of f.stores) assert.equal(store.searchEmbedding(), undefined);
  });
  assert.equal(
    (await f.lifecycle.activate('on')).ok,
    true,
    'the normal ready activation must perform bounded catch-up before admission',
  );
  assertCoverage(f, f.models[1]);
});

test('recovery cancellation settles without waiting for an uncooperative encoder and cannot publish a late batch', async (t) => {
  const f = await fixture(t);
  await f.lifecycle.activate('on');
  f.deployment.activeId = 'g1';
  await f.lifecycle.activate('on');
  f.lifecycle.deactivate({ retainLegacy: true });
  await f.stores[1].upsert([doc('added')]);
  let start, release;
  const started = new Promise((r) => {
    start = r;
  });
  f.onEncode(async () => {
    start();
    await new Promise((r) => {
      release = r;
    });
  });
  const recovery = f.lifecycle.activate('on');
  await Promise.race([
    started,
    recovery.then(() => {
      throw new Error('recovery skipped the missing collection source');
    }),
  ]);
  f.lifecycle.deactivate({ retainLegacy: true });
  await Promise.race([
    recovery,
    new Promise((_, reject) => setTimeout(() => reject(new Error('unbounded recovery cancellation')), 500)),
  ]);
  release();
  await new Promise((r) => setImmediate(r));
  assert.equal(f.lifecycle.getService(), undefined);
  assert.equal(openVectorGeneration(f.stores[1].getDb(), f.models[1]).vectorStore.count(), 2);
});

test('unknown legacy metadata cannot be silently stamped as the new G0 identity', async (t) => {
  const f = await fixture(t);
  f.stores[1].getDb().prepare("DELETE FROM embedding_meta WHERE key IN ('embedding_model_id','embedding_dim')").run();
  const before = generationInvalidationState(
    f.stores[1].getDb(),
    openVectorGeneration(f.stores[0].getDb(), f.models[0]).vectorStore.tables,
  );
  assert.equal((await f.lifecycle.activate('on')).ok, false);
  assert.equal(
    f.stores[1].getDb().prepare("SELECT value FROM embedding_meta WHERE key='embedding_model_id'").get(),
    undefined,
  );
  assert.equal((await f.lifecycle.activate('on', { rebuildLegacyModel: f.config.embedModel })).ok, true);
  assert.notEqual(
    generationInvalidationState(
      f.stores[1].getDb(),
      openVectorGeneration(f.stores[1].getDb(), f.models[0]).vectorStore.tables,
    ).epoch,
    before.epoch,
  );
});

test('bounded G1 recovery pauses without partial publication, then resumes committed source proofs', async (t) => {
  const f = await fixture(t);
  await f.lifecycle.activate('on');
  f.deployment.activeId = 'g1';
  await f.lifecycle.activate('on');
  f.lifecycle.deactivate({ retainLegacy: true });
  await f.stores[1].upsert(Array.from({ length: 20 }, (_, i) => doc(`added-${i}`)));
  let encoded = 0;
  f.onEncode((texts) => {
    encoded += texts.length;
    for (const store of f.stores) assert.equal(store.searchEmbedding(), undefined);
  });
  assert.equal((await f.lifecycle.activate('on')).ok, false);
  assert.equal(encoded, 16, 'one activation consumes at most eight batches of two');
  assert.equal(f.stores[1].getDb().prepare('SELECT count(*) AS n FROM evidence_vectors_g1').get().n, 18);
  assert.equal((await f.lifecycle.activate('on')).ok, true);
  assert.equal(encoded, 20, 'committed work is not repeated after bounded pause');
  assert.equal(f.stores[1].getDb().prepare('SELECT count(*) AS n FROM evidence_vectors_g1').get().n, 22);
});

test('controlled G0 replacement leaves canonical writes usable between writer queue items', async (t) => {
  const f = await fixture(t);
  await f.lifecycle.activate('on');
  f.config.embedModel = 'fixture-reconfigured';
  let writes = 0;
  for (const store of f.stores) {
    const run = store.runExclusive.bind(store);
    let checked = false;
    store.runExclusive = (work) =>
      run(() => {
        const result = work();
        const model = store
          .getDb()
          .prepare("SELECT value FROM embedding_meta WHERE key='embedding_model_id'")
          .get()?.value;
        if (!checked && model !== 'fixture-old') {
          checked = true;
          store
            .getDb()
            .prepare(
              "UPDATE evidence_docs SET title='Canonical write during bounded replacement' WHERE anchor='retained'",
            )
            .run();
          writes++;
        }
        return result;
      });
  }
  const activation = await f.lifecycle.activate('on', { rebuildLegacyModel: f.config.embedModel });
  assert.equal(
    activation.ok,
    true,
    'replacing derived geometry must not leave a native trigger pointing at a missing table',
  );
  assert.equal(writes, 2);
});

test('ordinary known G0 cold startup retains incremental compatibility before any G1 is complete', async (t) => {
  const f = await fixture(t);
  for (const store of f.stores) {
    store.getDb().prepare("DELETE FROM vector_generations WHERE id='g1'").run();
    await store.upsert([doc('newly-discovered')]);
  }
  f.onEncode(() => {
    throw new Error('ordinary legacy startup must not silently start a full cohort build');
  });
  const activation = await f.lifecycle.activate('on');
  assert.equal(activation.ok, true);
  for (const store of f.stores) {
    assert.equal(store.searchEmbedding().getModelInfo().modelId, 'fixture-old');
    assert.equal(openVectorGeneration(store.getDb(), f.models[0]).vectorStore.count(), 2);
  }
});

for (const completedG1 of [true, false])
  test(`an early lexical catch-up preserves paused cohort activation (completed G1=${completedG1})`, async (t) => {
    const f = await fixture(t);
    if (!completedG1)
      for (const store of f.stores) store.getDb().prepare("DELETE FROM vector_generations WHERE id='g1'").run();
    assert.equal((await f.lifecycle.activate('on')).ok, true);
    // Exceed the live G0 window (512 sources) so this still exercises a real paused cohort.
    for (const store of f.stores) await store.upsert(Array.from({ length: 260 }, (_, i) => doc(`new-${i}`)));
    f.config.embedModel = 'fixture-reconfigured';
    let encoded = 0;
    f.onEncode((texts) => {
      encoded += texts.length;
      for (const store of f.stores) assert.equal(store.searchEmbedding(), undefined);
    });
    t.mock.timers.enable({ apis: ['setTimeout'] });
    assert.equal((await f.lifecycle.activate('on', { rebuildLegacyModel: f.config.embedModel })).ok, false);
    assert.equal(encoded, 512);
    const providers = f.created.length;
    // This is the real callback used by thread-index and published-document
    // completion. No geometry has been published yet; it owns no activation.
    await f.lifecycle.catchUpAfterReady();
    t.mock.timers.tick(30_000);
    for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
    assert.ok(f.created.length > providers, 'the existing 30s retry must still reach its provider');
    assert.equal((await f.lifecycle.activate('on', { rebuildLegacyModel: f.config.embedModel })).ok, true);
    assert.equal(encoded, 524, 'retry only encodes the unfinished sources');
    for (const store of f.stores) {
      assert.equal(store.searchEmbedding().getModelInfo().modelId, f.config.embedModel);
      assert.equal(
        openVectorGeneration(store.getDb(), { ...f.models[0], modelId: f.config.embedModel }).vectorStore.count(),
        262,
      );
    }
  });

test('a G0 identity reset persists full-cohort admission before the first encoder window', async (t) => {
  const f = await fixture(t);
  for (const store of f.stores) {
    store.getDb().prepare("DELETE FROM vector_generations WHERE id='g1'").run();
    await store.upsert(Array.from({ length: 260 }, (_, i) => doc(`new-${i}`)));
  }
  f.lifecycle.deactivate();
  f.config.embedModel = 'fixture-reset-before-encode';
  const model = { ...f.models[0], modelId: f.config.embedModel };
  await resetLegacyCohort(f.stores, model, () => true);
  for (const store of f.stores) {
    assert.equal(store.getDb().prepare("SELECT state FROM vector_generations WHERE id='g0'").get().state, 'building');
    assert.equal(openVectorGeneration(store.getDb(), model).vectorStore.count(), 0);
  }
  let encoded = 0;
  f.onEncode((texts) => {
    encoded += texts.length;
    for (const store of f.stores) assert.equal(store.searchEmbedding(), undefined);
  });
  assert.equal((await f.lifecycle.activate('on')).ok, false);
  assert.equal(encoded, 512);
  assert.equal(f.lifecycle.getService(), undefined);
  assert.equal((await f.lifecycle.activate('on')).ok, true);
  assert.equal(encoded, 524);
  for (const store of f.stores) assert.equal(openVectorGeneration(store.getDb(), model).vectorStore.count(), 262);
});
