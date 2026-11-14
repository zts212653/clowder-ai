import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Fastify from 'fastify';
import {
  deriveProjectCollectionId,
  ensureProjectCollection,
} from '../../dist/domains/memory/bootstrap-collection-bridge.js';
import {
  embeddingRecipeFingerprint,
  readEmbeddingDeployment,
} from '../../dist/domains/memory/embedding-generation-config.js';
import { createMemoryServices } from '../../dist/domains/memory/factory.js';
import { openVectorGeneration } from '../../dist/domains/memory/open-vector-generation.js';
import { libraryRoutes } from '../../dist/routes/library.js';

const legacy = (id, embed = async (texts) => texts.map(() => new Float32Array([1, 0, 0, 0]))) => ({
  load: async () => {},
  reprobeIfNeeded: async () => {},
  dispose() {},
  isReady: () => true,
  getModelInfo: () => ({ modelId: id, modelRev: '1', dim: 4, generationId: 'g0' }),
  embed,
});

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'generation-admission-'));
  const docs = join(root, 'docs');
  mkdirSync(docs);
  const service = await createMemoryServices({
    type: 'sqlite',
    sqlitePath: join(root, 'evidence.sqlite'),
    globalDbPath: join(root, 'global.sqlite'),
    dataDir: join(root, 'data'),
    docsRoot: docs,
    markersDir: join(root, 'markers'),
    skillsRoot: join(root, 'skills'),
    memoryRoot: join(root, 'memory'),
    embed: { embedMode: 'off', embedDim: 6 },
  });
  const deployment = readEmbeddingDeployment();
  deployment.activeId = 'g1';
  deployment.generations.g1.runtime.maxModelMemMb = 32;
  deployment.generations.g1.recipe = { ...deployment.generations.g1.recipe, modelId: 'fixture-new', dim: 6 };
  const model = {
    modelId: 'fixture-new',
    modelRev: deployment.generations.g1.recipe.modelRevision,
    dim: 6,
    generationId: 'g1',
    representationFingerprint: embeddingRecipeFingerprint(deployment.generations.g1.recipe),
  };
  let failEncode = false;
  const encoder = {
    load: async () => {},
    reprobeIfNeeded: async () => {},
    dispose() {},
    isReady: () => true,
    getModelInfo: () => model,
    embed: async (texts) => {
      if (failEncode) throw new Error('controlled encode failure');
      return texts.map(() => new Float32Array([1, 0, 0, 0, 0, 0]));
    },
  };
  let currentEncoder = encoder;
  const main = openVectorGeneration(service.store.getDb(), model, { create: true });
  main.vectorStore.initMeta(model);
  service.store
    .getDb()
    .prepare("INSERT INTO vector_generations VALUES('g1',?,'ready')")
    .run(model.representationFingerprint);
  service.embeddingLifecycle.getDeployment = () => deployment;
  service.embeddingLifecycle.createEmbeddingService = () => encoder;
  service.embeddingLifecycle.requireLegacyConsumer = false;
  const app = Fastify();
  await app.register(libraryRoutes, {
    catalog: service.catalog,
    stores: service.collectionStores,
    dataDir: service.dataDir,
    getEmbeddingService: () => currentEncoder,
    getEmbedMode: () => 'on',
  });
  const external = join(root, 'external');
  mkdirSync(external);
  const path = join(external, 'note.md');
  writeFileSync(path, '# Neutral\n\nOrdinary content.');
  const registered = await app.inject({
    method: 'POST',
    url: '/api/library/register',
    payload: {
      id: 'domain:neutral',
      kind: 'domain',
      name: 'neutral',
      displayName: 'Neutral',
      root: external,
      sensitivity: 'internal',
      scannerLevel: 0,
    },
  });
  assert.equal(registered.statusCode, 200, registered.body);
  const store = service.collectionStores.get('domain:neutral');
  const rebuild = () => app.inject({ method: 'POST', url: '/api/library/domain:neutral/rebuild' });
  t.after(async () => {
    service.embeddingLifecycle.deactivate();
    await app.close();
    for (const s of new Set([service.store, ...service.collectionStores.values()])) s.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    service,
    store,
    path,
    rebuild,
    encoder,
    selectEncoder: (next) => {
      currentEncoder = next;
    },
    failEncode: () => {
      failEncode = true;
    },
    restoreEncode: () => {
      failEncode = false;
    },
  };
}

test('a new secret-blocked G1 route never materializes a generation or poisons the actual factory cohort; corrected input joins normally', async (t) => {
  const f = await fixture(t);
  writeFileSync(f.path, `# Secret\n\nOPENAI_API_KEY=sk-${'x'.repeat(48)}\n`);
  const blocked = await f.rebuild();
  assert.equal(blocked.statusCode, 200);
  assert.equal(blocked.json().blocked, true);
  assert.equal(
    f.store.getDb().prepare("SELECT 1 FROM sqlite_master WHERE name='evidence_vectors_g1'").get(),
    undefined,
    'secret admission precedes generation preparation',
  );
  assert.equal((await f.service.embeddingLifecycle.activate('on')).ok, true);
  assert.equal(f.store.searchEmbedding(), undefined);
  writeFileSync(f.path, '# Corrected\n\nSafe source.');
  assert.equal((await f.rebuild()).json().blocked, false);
  assert.equal(f.service.catalog.get('domain:neutral').status, 'active');
  assert.equal((await f.service.embeddingLifecycle.activate('on')).ok, true);
  assert.equal(f.store.searchEmbedding().getModelInfo().generationId, 'g1');
});

test('a formerly ready collection becoming blocked is purged and excluded from restart activation', async (t) => {
  const f = await fixture(t);
  await f.rebuild();
  assert.equal((await f.service.embeddingLifecycle.activate('on')).ok, true);
  writeFileSync(f.path, `# Secret\n\nOPENAI_API_KEY=sk-${'x'.repeat(48)}\n`);
  assert.equal((await f.rebuild()).json().blocked, true);
  assert.equal(f.store.getDb().prepare('SELECT count(*) AS n FROM evidence_docs').get().n, 0);
  assert.equal(f.store.searchEmbedding(), undefined, 'blocked store loses its live capability immediately');
  f.service.embeddingLifecycle.deactivate();
  assert.equal((await f.service.embeddingLifecycle.activate('on')).ok, true);
  assert.equal(f.store.searchEmbedding(), undefined, 'factory must not rebind a blocked collection');
});

test('a canonical rebuild failure before encode leaves no new generation and a non-active cohort member', async (t) => {
  const f = await fixture(t);
  const upsert = f.store.upsert.bind(f.store);
  f.store.upsert = async () => {
    throw new Error('controlled canonical failure');
  };
  assert.equal((await f.rebuild()).statusCode, 500);
  assert.equal(
    f.store.getDb().prepare("SELECT 1 FROM sqlite_master WHERE name='evidence_vectors_g1'").get(),
    undefined,
  );
  assert.equal((await f.service.embeddingLifecycle.activate('on')).ok, true);
  f.store.upsert = upsert;
  await f.rebuild();
  assert.equal((await f.service.embeddingLifecycle.activate('on')).ok, true);
});

test('optional embedding failure keeps canonical reads but cannot publish a partial collection as active', async (t) => {
  const f = await fixture(t);
  f.failEncode();
  assert.equal((await f.rebuild()).statusCode, 200);
  assert.equal(f.store.getDb().prepare('SELECT count(*) AS n FROM evidence_docs').get().n, 1);
  assert.equal(f.store.searchEmbedding(), undefined);
  assert.equal(
    (await f.service.embeddingLifecycle.activate('on')).ok,
    true,
    'the incomplete optional collection must not block the cohort',
  );
  f.restoreEncode();
  await f.rebuild();
  assert.equal((await f.service.embeddingLifecycle.activate('on')).ok, true);
  assert.equal(f.store.searchEmbedding().getModelInfo().generationId, 'g1');
});

test('project bootstrap also admits secrets and canonical sources before creating a generation', async (t) => {
  const f = await fixture(t);
  const projectRoot = join(f.path, '..');
  writeFileSync(f.path, `# Secret\n\nOPENAI_API_KEY=sk-${'x'.repeat(48)}\n`);
  const bootstrap = () =>
    ensureProjectCollection(
      projectRoot,
      f.service.catalog,
      f.service.collectionStores,
      f.service.dataDir,
      'fixture-owner',
      () => f.encoder,
    );
  await assert.rejects(bootstrap(), /blocked/);
  const store = f.service.collectionStores.get(deriveProjectCollectionId(projectRoot));
  assert.equal(store.getDb().prepare("SELECT 1 FROM sqlite_master WHERE name='evidence_vectors_g1'").get(), undefined);
  assert.equal(f.service.catalog.get(deriveProjectCollectionId(projectRoot)).status, 'blocked');
  assert.equal((await f.service.embeddingLifecycle.activate('on')).ok, true);
  writeFileSync(f.path, '# Restored\n\nOrdinary source.');
  await bootstrap();
  assert.equal(f.service.catalog.get(deriveProjectCollectionId(projectRoot)).status, 'active');
  assert.equal(store.searchEmbedding().getModelInfo().generationId, 'g1');
});

test('an explicit library rebuild can repair an old G0 collection after the active same-dimensional provider changes', async (t) => {
  const f = await fixture(t);
  f.selectEncoder(legacy('collection-old'));
  await f.rebuild();
  assert.equal(f.store.searchEmbedding().getModelInfo().modelId, 'collection-old');
  // A lifecycle service replacement closes the old binding before the collection repair.
  f.store.setEmbedDeps(undefined);
  f.selectEncoder(legacy('collection-current'));
  assert.equal(f.store.searchEmbedding(), undefined);
  assert.equal((await f.rebuild()).statusCode, 200);
  assert.equal(f.service.catalog.get('domain:neutral').status, 'active');
  assert.equal(f.store.searchEmbedding().getModelInfo().modelId, 'collection-current');
  assert.equal(
    f.store.getDb().prepare("SELECT value FROM embedding_meta WHERE key='embedding_model_id'").get().value,
    'collection-current',
  );
});

for (const route of ['library', 'bootstrap']) {
  for (const failAt of [1, 2]) {
    test(`registered G0 collection stays closed through ${route} replacement failure at batch ${failAt} and retries skipped sources`, async (t) => {
      const f = await fixture(t);
      const projectRoot = join(f.path, '..');
      for (let i = 0; i < 8; i++)
        writeFileSync(join(projectRoot, `stable-${i}.md`), `# Stable ${i}\n\nOrdinary source.`);
      let encoder = legacy('old-g0');
      const id = route === 'library' ? 'domain:neutral' : deriveProjectCollectionId(projectRoot);
      const rebuild = async () => {
        if (route === 'bootstrap')
          return ensureProjectCollection(
            projectRoot,
            f.service.catalog,
            f.service.collectionStores,
            f.service.dataDir,
            'fixture-owner',
            () => encoder,
          );
        f.selectEncoder(encoder);
        const response = await f.rebuild();
        assert.equal(response.statusCode, 200, response.body);
        return response.json();
      };
      await rebuild();
      const store = f.service.collectionStores.get(id);
      const db = store.getDb();
      const count = () => db.prepare('SELECT count(*) AS n FROM evidence_vectors').get().n;
      assert.equal(count(), 9);
      assert.equal(store.searchEmbedding().getModelInfo().modelId, 'old-g0');
      store.setEmbedDeps(undefined);
      let calls = 0;
      let failing = true;
      encoder = legacy('replacement-g0', async (texts) => {
        if (++calls === failAt && failing) throw new Error('controlled optional encode failure');
        return texts.map(() => new Float32Array([1, 0, 0, 0]));
      });
      const failed = await rebuild();
      if (route === 'library') assert.deepEqual([failed.indexed, failed.skipped], [0, 9]);
      assert.equal(db.prepare('SELECT count(*) AS n FROM evidence_docs').get().n, 9, 'canonical sources survive');
      assert.equal(count(), failAt === 1 ? 0 : 8, 'partial committed work is retained');
      assert.equal(f.service.catalog.get(id).status, 'stale');
      assert.equal(store.searchEmbedding(), undefined, 'neither empty nor partial replacement is published');
      assert.equal(db.prepare("SELECT state FROM vector_generations WHERE id='g0'").get().state, 'building');

      failing = false;
      const beforeRetry = calls;
      const complete = await rebuild();
      if (route === 'library') assert.deepEqual([complete.indexed, complete.skipped], [0, 9]);
      assert.equal(calls - beforeRetry, failAt === 1 ? 2 : 1, 'retry fills only missing current sources');
      assert.equal(count(), 9);
      assert.equal(f.service.catalog.get(id).status, 'active');
      assert.equal(store.searchEmbedding().getModelInfo().modelId, 'replacement-g0');
      assert.equal(db.prepare("SELECT state FROM vector_generations WHERE id='g0'").get().state, 'ready');
    });
  }
}
