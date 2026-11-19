import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { registerRuntimeCatalogRoute } from '../dist/routes/runtime-catalog-route.js';
import {
  createAgentAccessCodexModelCatalogDiscovery,
  createAgentAccessCodexModelCatalogGeneration,
} from '../dist/domains/plugin/agent-access/codex-model-catalog.js';

function authority(overrides = {}) {
  return {
    instance: {
      pluginInstanceId: 'inst-1',
      packageDigest: 'digest-1',
      lifecycleRevision: 1,
      activationState: 'enabled',
      runtimeState: 'healthy',
      ...overrides,
    },
  };
}

test('disabled package does not probe and has no generation', async () => {
  let calls = 0;
  const load = createAgentAccessCodexModelCatalogDiscovery(
    { readCurrentAuthority: async () => authority({ activationState: 'disabled' }) },
    { invoke: async () => (calls++, {}) },
  );
  assert.equal(await load({ command: 'codex', cwd: '/workspace' }), undefined);
  assert.equal(calls, 0);
  const generation = createAgentAccessCodexModelCatalogGeneration({
    readCurrentAuthority: async () => authority({ activationState: 'disabled' }),
  });
  assert.equal(await generation(), undefined);
});

test('active package receives the discovery request and Host rejects unapproved argv', async () => {
  let seen;
  const discovery = createAgentAccessCodexModelCatalogDiscovery(
    { readCurrentAuthority: async () => authority() },
    {
      invoke: async (_id, method, payload) => {
        seen = { method, payload };
        await assert.rejects(() => payload.launch({ args: ['run', 'anything'] }), /not_approved/);
        return { status: 'live', models: [{ value: 'a', label: 'A' }] };
      },
    },
  );
  const result = await discovery({ command: 'codex', cwd: '/workspace', model: 'a' });
  assert.equal(seen.method, 'discoverModelCatalog');
  assert.deepEqual(seen.payload.input, { cwd: '/workspace', model: 'a' });
  assert.equal(result.status, 'live');
  assert.equal(result.models[0].value, 'a');
});

function runtimeFixture() {
  return {
    id: 'codex',
    installed: true,
    command: 'codex',
    models: ['configured-a'],
    modelCatalog: [],
    configuredModel: 'configured-a',
  };
}

test('runtime-models does not probe codex when the package is unavailable', async () => {
  let probes = 0;
  const app = Fastify();
  registerRuntimeCatalogRoute(app, {
    discoverRuntimes: async () => ({ runtimes: [runtimeFixture()] }),
    modelCatalogGeneration: async () => undefined,
    discoverModelCatalog: async () => {
      probes++;
      return { status: 'live', models: [{ value: 'plugin-a', label: 'Plugin A' }] };
    },
  });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/cats/runtime-models',
      headers: { 'x-cat-cafe-user': 'test' },
      payload: { runtimeId: 'codex' },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(probes, 0);
    assert.equal(response.json().message, 'plugin_unavailable');
    assert.deepEqual(response.json().models, [{ value: 'configured-a', label: 'configured-a' }]);
  } finally {
    await app.close();
  }
});

test('runtime-models uses active package discovery and keys cache by generation', async () => {
  let generation = 'inst-1:digest-1:1';
  let probes = 0;
  const app = Fastify();
  registerRuntimeCatalogRoute(app, {
    discoverRuntimes: async () => ({ runtimes: [runtimeFixture()] }),
    modelCatalogGeneration: async () => generation,
    discoverModelCatalog: async () => {
      probes++;
      return { status: 'live', models: [{ value: `plugin-${probes}`, label: 'Plugin' }] };
    },
  });
  const request = () =>
    app.inject({
      method: 'POST',
      url: '/api/cats/runtime-models',
      headers: { 'x-cat-cafe-user': 'test' },
      payload: { runtimeId: 'codex' },
    });
  try {
    assert.equal((await request()).json().models[0].value, 'plugin-1');
    assert.equal((await request()).json().models[0].value, 'plugin-1');
    assert.equal(probes, 1);
    generation = 'inst-1:digest-1:2';
    assert.equal((await request()).json().models[0].value, 'plugin-2');
    assert.equal(probes, 2);
  } finally {
    await app.close();
  }
});

test('generation changes with the active instance revision', async () => {
  let current = authority();
  const generation = createAgentAccessCodexModelCatalogGeneration({
    readCurrentAuthority: async () => current,
  });
  const first = await generation();
  current = authority({ lifecycleRevision: 2 });
  const second = await generation();
  assert.notEqual(first, second);
  assert.match(first, /inst-1:digest-1:1/);
});
