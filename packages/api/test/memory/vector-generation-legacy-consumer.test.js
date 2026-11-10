import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EmbeddingService } from '../../dist/domains/memory/EmbeddingService.js';
import {
  embeddingRecipeFingerprint,
  readEmbeddingDeployment,
} from '../../dist/domains/memory/embedding-generation-config.js';
import { IndexBuilder } from '../../dist/domains/memory/IndexBuilder.js';
import { MemoryEmbeddingLifecycle } from '../../dist/domains/memory/MemoryEmbeddingLifecycle.js';
import { openVectorGeneration } from '../../dist/domains/memory/open-vector-generation.js';
import { SqliteEvidenceStore } from '../../dist/domains/memory/SqliteEvidenceStore.js';
import { FrictionMetricsProviderImpl } from '../../dist/infrastructure/harness-eval/friction/friction-metrics-provider-impl.js';

const OLD_URL = 'http://127.0.0.1:49091';
const selector = { kind: 'friction-rollup-snapshot', windowStartMs: 1000, windowEndMs: 4000 };
function providerDeps(resolve, extra = {}) {
  return {
    messageStore: { getBefore: async () => [] },
    taskOutcomeStore: {
      listSignalsInWindow: () => [
        {
          id: 1,
          episodeId: 'one',
          category: 'a2',
          record: { type: 'permission_cancel' },
          createdAt: '1970-01-01T00:00:02Z',
        },
        {
          id: 2,
          episodeId: 'two',
          category: 'proxy',
          record: { type: 'cancel_burst', value: 3 },
          createdAt: '1970-01-01T00:00:02Z',
        },
      ],
    },
    frustrationIssueStore: { listConfirmedInWindow: async () => [] },
    harnessFeedbackRoot: '/nonexistent-task528-friction-fixture',
    now: () => 5000,
    getLegacyEmbeddingService: resolve,
    ...extra,
  };
}
async function fixture(t) {
  const store = new SqliteEvidenceStore(':memory:');
  await store.initialize();
  const deployment = readEmbeddingDeployment();
  deployment.activeId = 'g1';
  deployment.generations.g1.recipe = { ...deployment.generations.g1.recipe, modelId: 'fixture-new', dim: 6 };
  deployment.generations.g1.runtime.maxModelMemMb = 32;
  const oldModel = { modelId: 'fixture-old', modelRev: '1', dim: 4, generationId: 'g0' };
  openVectorGeneration(store.getDb(), oldModel, { create: true }).vectorStore.initMeta(oldModel);
  const newModel = {
    modelId: 'fixture-new',
    modelRev: deployment.generations.g1.recipe.modelRevision,
    dim: 6,
    generationId: 'g1',
    representationFingerprint: embeddingRecipeFingerprint(deployment.generations.g1.recipe),
  };
  openVectorGeneration(store.getDb(), newModel, { create: true }).vectorStore.initMeta(newModel);
  store
    .getDb()
    .prepare("INSERT INTO vector_generations VALUES('g1',?,'ready')")
    .run(newModel.representationFingerprint);
  const envBefore = process.env.EMBED_G0_URL,
    fetchBefore = globalThis.fetch;
  process.env.EMBED_G0_URL = OLD_URL;
  const state = { primaryReady: false, legacyHealth: 'ok', oldEmbedCalls: 0, newEmbedCalls: 0, oldUrls: [] };
  globalThis.fetch = async (url, init) => {
    assert.ok(String(url).startsWith(OLD_URL));
    state.oldUrls.push(String(url));
    if (String(url).endsWith('/health'))
      return new Response(
        JSON.stringify({ status: state.legacyHealth, model: 'fixture-old', dim: 4, generation_id: 'g0' }),
      );
    state.oldEmbedCalls++;
    const body = JSON.parse(init.body);
    return new Response(
      JSON.stringify({
        model: 'fixture-old',
        dim: 4,
        generation_id: 'g0',
        data: body.input.map((_, index) => ({ index, embedding: [1, 0, 0, 0] })),
      }),
    );
  };
  const lifecycle = new MemoryEmbeddingLifecycle(
    store,
    new IndexBuilder(store, '/unused'),
    {
      embedMode: 'on',
      embedModel: 'fixture-old',
      embedDim: 4,
      embedUrl: OLD_URL,
      embedTimeoutMs: 1000,
      maxModelMemMb: 32,
    },
    {
      getDeployment: () => structuredClone(deployment),
      requireLegacyConsumer: true,
      createEmbeddingService: (config) => {
        if (config.generationId === 'g0') return new EmbeddingService(config);
        let ready = false;
        return {
          load: async () => {
            ready = state.primaryReady;
          },
          isReady: () => ready,
          dispose: () => {
            ready = false;
          },
          reprobeIfNeeded: async () => {},
          embed: async () => {
            state.newEmbedCalls++;
            throw new Error('friction must never encode with G1');
          },
          getModelInfo: () => newModel,
        };
      },
    },
  );
  t.after(() => {
    lifecycle.deactivate();
    store.close();
    globalThis.fetch = fetchBefore;
    if (envBefore === undefined) delete process.env.EMBED_G0_URL;
    else process.env.EMBED_G0_URL = envBefore;
  });
  return { store, deployment, lifecycle, state };
}

test('real cold composition resolves later G0 for friction, retains the pinned instance across G1 outages, and degrades only at final shutdown', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.lifecycle.activate('on')).reason, 'service_not_ready');
  const provider = new FrictionMetricsProviderImpl(providerDeps(() => f.lifecycle.getLegacyConsumerService()));
  assert.equal((await provider.resolve(selector)).rollupInput.degraded, true);
  f.state.primaryReady = true;
  assert.equal((await f.lifecycle.activate('on')).ok, true);
  const old = f.lifecycle.getLegacyConsumerService();
  assert.ok(old);
  assert.equal(old.getModelInfo().generationId, 'g0');
  const active = await provider.resolve(selector);
  assert.equal(active.rollupInput.degraded, false);
  assert.ok(active.rollupInput.clusters.some((row) => row.method === 'embedding'));
  assert.equal(f.state.oldEmbedCalls, 1);
  assert.equal(f.state.newEmbedCalls, 0);
  for (let i = 0; i < 2; i++) {
    f.lifecycle.deactivate({ retainLegacy: true });
    assert.equal(f.lifecycle.getLegacyConsumerService(), old);
    assert.equal((await provider.resolve(selector)).rollupInput.degraded, false);
  }
  assert.equal(f.state.oldEmbedCalls, 3);
  f.lifecycle.deactivate();
  assert.equal((await provider.resolve(selector)).rollupInput.degraded, true);
  assert.equal(f.state.oldEmbedCalls, 3);
  assert.equal(f.state.newEmbedCalls, 0);
  assert.ok(f.state.oldUrls.every((url) => url.startsWith(OLD_URL)));
});

test('retained G0 non-ok health blocks G1 publication and preserves the previous complete geometry', async (t) => {
  const f = await fixture(t);
  f.state.primaryReady = true;
  for (const status of ['loading', 'degraded']) {
    f.state.legacyHealth = 'ok';
    f.deployment.activeId = 'g0';
    assert.equal((await f.lifecycle.activate('on')).ok, true);
    const service = f.lifecycle.getService(),
      vectors = f.lifecycle.getVectorStore();
    f.state.legacyHealth = status;
    f.deployment.activeId = 'g1';
    const result = await f.lifecycle.activate('on');
    assert.equal(result.ok, false, status);
    assert.equal(result.reason, 'legacy_provider_not_ready');
    assert.equal(f.lifecycle.getService(), service);
    assert.equal(f.lifecycle.getVectorStore(), vectors);
    assert.equal(vectors.tables.generationId, 'g0');
    assert.equal(service.isReady(), false);
  }
});

test('one friction capture freezes one G0 object across asynchronous sources and rejects an explicitly misrouted G1', async () => {
  let calls = 0,
    oldEmbeds = 0,
    newEmbeds = 0;
  const old = {
    getModelInfo: () => ({ modelId: 'old', dim: 4, modelRev: '1', generationId: 'g0' }),
    isReady: () => true,
    reprobeIfNeeded: async () => {},
    embed: async (texts) => {
      oldEmbeds++;
      return texts.map(() => new Float32Array([1, 0, 0, 0]));
    },
  };
  const newer = {
    ...old,
    getModelInfo: () => ({ modelId: 'new', dim: 6, modelRev: '1', generationId: 'g1' }),
    embed: async () => {
      newEmbeds++;
      throw new Error('G1 is not a legacy friction provider');
    },
  };
  let selected = old;
  const provider = new FrictionMetricsProviderImpl(
    providerDeps(
      () => {
        calls++;
        return selected;
      },
      {
        messageStore: {
          getBefore: async () => {
            selected = newer;
            return [];
          },
        },
      },
    ),
  );
  assert.equal((await provider.resolve(selector)).rollupInput.degraded, false);
  assert.equal(calls, 1);
  assert.equal(oldEmbeds, 1);
  assert.equal(newEmbeds, 0);
  assert.equal((await provider.resolve(selector)).rollupInput.degraded, true);
  assert.equal(calls, 2);
  assert.equal(oldEmbeds, 1);
  assert.equal(newEmbeds, 0);
});
