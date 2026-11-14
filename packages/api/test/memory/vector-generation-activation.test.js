import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as sqliteVec from 'sqlite-vec';
import {
  embeddingRecipeFingerprint,
  readEmbeddingDeployment,
} from '../../dist/domains/memory/embedding-generation-config.js';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { MemoryEmbeddingLifecycle } from '../../dist/domains/memory/MemoryEmbeddingLifecycle.js';
import { openVectorGeneration } from '../../dist/domains/memory/open-vector-generation.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { ensurePassageVectorTable } from '../../dist/domains/memory/schema.js';
import { inspectVectorGeneration } from '../../dist/domains/memory/vector-generation-readiness.js';

async function fixture(t, missingDependent = false, onCreate = () => {}) {
  const store = new SqliteEvidenceStore(':memory:');
  const dependent = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  await dependent.initialize();
  const deployment = readEmbeddingDeployment();
  deployment.generations.g1.recipe = { ...deployment.generations.g1.recipe, modelId: 'fixture-new', dim: 6 };
  deployment.generations.g1.runtime.maxModelMemMb = 32;
  const newModel = {
    modelId: 'fixture-new',
    modelRev: deployment.generations.g1.recipe.modelRevision,
    dim: 6,
    generationId: 'g1',
    representationFingerprint: embeddingRecipeFingerprint(deployment.generations.g1.recipe),
  };
  const backend = openVectorGeneration(store.getDb(), newModel, { create: true });
  backend.vectorStore.initMeta(newModel);
  store
    .getDb()
    .prepare("INSERT INTO vector_generations VALUES('g1',?,'ready')")
    .run(newModel.representationFingerprint);
  if (missingDependent)
    openVectorGeneration(dependent.getDb(), { modelId: 'fixture-old', modelRev: '1', dim: 4 }, { create: true });
  const config = { embedMode: 'on', embedModel: 'fixture-old', embedDim: 4, embedTimeoutMs: 1000, maxModelMemMb: 32 };
  const services = [];
  const lifecycle = new MemoryEmbeddingLifecycle(store, new IndexBuilder(store, '/unused'), config, {
    getDeployment: () => structuredClone(deployment),
    getDependentStores: () => [store, dependent],
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
        embed: async (texts) => texts.map(() => Float32Array.from({ length: c.embedDim }, (_, i) => Number(i === 0))),
        getModelInfo: () => ({
          modelId: c.embedModel,
          modelRev: c.embedModelRev ?? '1',
          dim: c.embedDim,
          generationId: c.generationId ?? 'g0',
          ...(c.representationFingerprint ? { representationFingerprint: c.representationFingerprint } : {}),
        }),
      };
      onCreate(c, service);
      services.push(service);
      return service;
    },
  });
  t.after(() => {
    lifecycle.deactivate();
    store.close();
    dependent.close();
  });
  return { store, dependent, deployment, lifecycle, services };
}

test('each activate rechecks desired generation and rollback keeps one complete geometry', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.lifecycle.activate('on')).ok, true);
  const legacy = f.lifecycle.getService();
  f.deployment.activeId = 'g1';
  assert.equal((await f.lifecycle.activate('on')).ok, true);
  assert.equal(f.lifecycle.getService().getModelInfo().generationId, 'g1');
  assert.equal(f.lifecycle.getVectorStore().tables.generationId, 'g1');
  assert.equal(legacy.isReady(), true, 'a borrowed non-index G0 consumer keeps its provider geometry');
  f.deployment.activeId = 'g0';
  assert.equal((await f.lifecycle.activate('on')).ok, true);
  assert.equal(f.lifecycle.getService().getModelInfo().generationId, 'g0');
  assert.equal(f.lifecycle.getVectorStore().tables.generationId, 'g0');
});

test('one unprepared existing collection prevents partial G1 activation', async (t) => {
  const f = await fixture(t, true);
  assert.equal((await f.lifecycle.activate('on')).ok, true);
  const old = f.lifecycle.getService();
  f.deployment.activeId = 'g1';
  const result = await f.lifecycle.activate('on');
  assert.equal(result.ok, false);
  assert.equal(f.lifecycle.getService(), old);
  assert.equal(f.lifecycle.getVectorStore().tables.generationId, 'g0');
});

test('an existing passage-only collection cannot be omitted from activation admission', async (t) => {
  const f = await fixture(t);
  sqliteVec.load(f.dependent.getDb());
  assert.equal(ensurePassageVectorTable(f.dependent.getDb(), 4), true);
  f.deployment.activeId = 'g1';
  assert.equal((await f.lifecycle.activate('on')).ok, false);
  assert.equal(f.lifecycle.getService(), undefined);
});

test('a G1 service outage retains the original borrowed G0 consumer, while final shutdown disposes it', async (t) => {
  const f = await fixture(t);
  await f.lifecycle.activate('on');
  const legacy = f.lifecycle.getLegacyConsumerService();
  f.deployment.activeId = 'g1';
  assert.equal((await f.lifecycle.activate('on')).ok, true);
  f.lifecycle.deactivate({ retainLegacy: true });
  assert.equal(f.lifecycle.getService(), undefined);
  assert.equal(f.lifecycle.getLegacyConsumerService(), legacy);
  assert.equal(legacy.isReady(), true);
  assert.equal((await f.lifecycle.activate('on')).ok, true);
  assert.equal(f.lifecycle.getLegacyConsumerService(), legacy);
  f.lifecycle.deactivate();
  assert.equal(legacy.isReady(), false);
});

test('quarantined projections cannot pass the generation readiness contract', async (t) => {
  const f = await fixture(t);
  const model = f.deployment.generations.g1.recipe;
  f.store.getDb().prepare("INSERT INTO embedding_meta_g1 VALUES('vector_invalidation_quarantined','1')").run();
  assert.equal(
    inspectVectorGeneration(f.store.getDb(), {
      modelId: model.modelId,
      modelRev: model.modelRevision,
      dim: model.dim,
      generationId: 'g1',
      representationFingerprint: embeddingRecipeFingerprint(model),
    }).ready,
    false,
  );
});

test('a legacy provider load cannot publish after its owning activation is deactivated', async (t) => {
  const f = await fixture(t);
  f.deployment.activeId = 'g1';
  f.store
    .getDb()
    .prepare("INSERT INTO embedding_meta(key,value) VALUES('embedding_model_id','fixture-old'),('embedding_dim','4')")
    .run();
  const oldEndpoint = process.env.EMBED_G0_URL;
  process.env.EMBED_G0_URL = 'http://127.0.0.1:49199';
  t.after(() => {
    if (oldEndpoint === undefined) delete process.env.EMBED_G0_URL;
    else process.env.EMBED_G0_URL = oldEndpoint;
  });
  let release, started;
  const start = new Promise((resolve) => {
    started = resolve;
  });
  const services = [];
  const lifecycle = new MemoryEmbeddingLifecycle(
    f.store,
    new IndexBuilder(f.store, '/unused'),
    { embedMode: 'on', embedModel: 'fixture-old', embedDim: 4, embedTimeoutMs: 1000, maxModelMemMb: 32 },
    {
      getDeployment: () => structuredClone(f.deployment),
      requireLegacyConsumer: true,
      createEmbeddingService: (c) => {
        let ready = false;
        const service = {
          load: async () => {
            if (c.generationId === 'g0') {
              started();
              await new Promise((resolve) => {
                release = resolve;
              });
            }
            ready = true;
          },
          isReady: () => ready,
          dispose: () => {
            ready = false;
            service.disposed = true;
          },
          getModelInfo: () => ({
            modelId: c.embedModel,
            modelRev: c.embedModelRev ?? '1',
            dim: c.embedDim,
            generationId: c.generationId,
            ...(c.representationFingerprint ? { representationFingerprint: c.representationFingerprint } : {}),
          }),
        };
        services.push(service);
        return service;
      },
    },
  );
  t.after(() => lifecycle.deactivate());
  const activation = lifecycle.activate('on');
  await start;
  lifecycle.deactivate();
  release();
  await activation;
  assert.equal(lifecycle.getLegacyConsumerService(), undefined);
  assert.equal(lifecycle.getService(), undefined);
  assert.equal(lifecycle.getStatus(), 'off');
  assert.ok(services.every((service) => service.disposed));
});

test('explicit bounded shadow work builds every enabled collection while G0 serves, then activates and rolls back', async (t) => {
  const f = await fixture(t, true);
  await f.store.upsert([
    {
      anchor: 'neutral-a',
      title: 'Primary',
      kind: 'thread',
      status: 'active',
      sourceHash: 'a',
      updatedAt: '2026-11-09',
    },
  ]);
  await f.dependent.upsert([
    {
      anchor: 'neutral-b',
      title: 'External',
      kind: 'thread',
      status: 'active',
      sourceHash: 'b',
      updatedAt: '2026-11-09',
    },
  ]);
  assert.equal((await f.lifecycle.activate('on')).ok, true);
  const original = f.lifecycle.getService();
  assert.equal(
    f.dependent.getDb().prepare("SELECT 1 FROM sqlite_master WHERE name='evidence_vectors_g1'").get(),
    undefined,
    'activation cannot construct G1',
  );
  const built = await f.lifecycle.buildShadowGeneration({
    embedUrl: 'http://127.0.0.1:49198',
    deadlineAt: Date.now() + 5000,
    maxBatches: 8,
    batchSize: 1,
  });
  assert.equal(built.status, 'ready');
  assert.equal(built.stores, 2);
  assert.equal(built.committed, 2);
  assert.equal(f.lifecycle.getService(), original, 'a ready shadow cannot select itself');
  f.deployment.activeId = 'g1';
  assert.equal((await f.lifecycle.activate('on')).ok, true);
  assert.equal(f.store.getVectorGenerationTables().generationId, 'g1');
  assert.equal(f.dependent.getVectorGenerationTables().generationId, 'g1');
  await f.store.deleteByAnchor('neutral-a');
  f.deployment.activeId = 'g0';
  assert.equal((await f.lifecycle.activate('on')).ok, true);
  assert.equal(f.store.getVectorGenerationTables().generationId, 'g0');
  assert.equal(f.dependent.getVectorGenerationTables().generationId, 'g0');
  assert.deepEqual(
    f.lifecycle.getVectorStore().search(new Float32Array([1, 0, 0, 0]), 1),
    [],
    'rollback cannot resurrect deleted sources',
  );
});

test('lifecycle stop releases a shadow build without cancelling its caller or committing a late batch', async (t) => {
  let release, started;
  const start = new Promise((resolve) => {
    started = resolve;
  });
  const f = await fixture(t, false, (config, service) => {
    if (config.generationId === 'g1')
      service.embed = async (texts) => {
        started();
        await new Promise((resolve) => {
          release = resolve;
        });
        return texts.map(() => new Float32Array([1, 0, 0, 0, 0, 0]));
      };
  });
  await f.store.upsert([
    {
      anchor: 'neutral-stop',
      title: 'Unchanged',
      kind: 'thread',
      status: 'active',
      sourceHash: 'a',
      updatedAt: '2026-11-09',
    },
  ]);
  await f.lifecycle.activate('on');
  const caller = new AbortController();
  const work = f.lifecycle.buildShadowGeneration({
    embedUrl: 'http://127.0.0.1:49198',
    signal: caller.signal,
    deadlineAt: Date.now() + 5000,
    maxBatches: 8,
    batchSize: 1,
  });
  await start;
  f.lifecycle.stopShadowBuild();
  await assert.rejects(work, { name: 'AbortError' });
  assert.equal(caller.signal.aborted, false);
  assert.equal(f.lifecycle.getGenerationStatus().building, false);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.store.getDb().prepare('SELECT count(*) AS n FROM evidence_vectors_g1_rowids').get().n, 0);
  assert.equal(f.lifecycle.getGenerationStatus().effective, 'g0');
});
