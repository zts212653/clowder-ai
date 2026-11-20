import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import {
  createAgentAccessModelCatalogDiscovery,
  createAgentAccessModelCatalogGeneration,
} from '../dist/domains/plugin/agent-access/model-catalog.js';
import { registerRuntimeCatalogRoute } from '../dist/routes/runtime-catalog-route.js';

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
  const load = createAgentAccessModelCatalogDiscovery(
    { readCurrentAuthority: async () => authority({ activationState: 'disabled' }) },
    { invoke: async () => (calls++, {}) },
  );
  assert.equal(await load({ kind: 'codex', command: 'codex', args: [], cwd: '/workspace' }), undefined);
  assert.equal(calls, 0);
  const generation = createAgentAccessModelCatalogGeneration({
    readCurrentAuthority: async () => authority({ activationState: 'disabled' }),
  });
  assert.equal(await generation(), undefined);
});

test('active package receives the discovery request and Host rejects unapproved argv', async () => {
  let seen;
  const discovery = createAgentAccessModelCatalogDiscovery(
    { readCurrentAuthority: async () => authority() },
    {
      invoke: async (_id, method, payload) => {
        seen = { method, payload };
        await assert.rejects(() => payload.launch({ args: ['run', 'anything'] }), /not_approved/);
        await assert.rejects(() => payload.launch({ args: ['debug', 'models'], cwd: '/other' }), /not_approved/);
        return { status: 'live', models: [{ value: 'a', label: 'A' }] };
      },
    },
  );
  const result = await discovery({ kind: 'codex', command: 'codex', args: [], cwd: '/workspace', model: 'a' });
  assert.equal(seen.method, 'discoverModelCatalog');
  assert.deepEqual(seen.payload.input, { operation: 'discover_model_catalog', client: 'codex', input: { model: 'a' } });
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

test('runtime-models does not launch Codex, Claude or ACP probes when the package is unavailable', async () => {
  let probes = 0;
  const app = Fastify();
  registerRuntimeCatalogRoute(app, {
    discoverRuntimes: async () => ({
      runtimes: [
        runtimeFixture(),
        { ...runtimeFixture(), id: 'claude', command: 'clowder-test-never-launch' },
        { ...runtimeFixture(), id: 'test-acp', command: 'clowder-test-never-launch' },
      ],
    }),
    modelCatalogGeneration: async () => undefined,
    discoverModelCatalog: async () => {
      probes++;
      return { status: 'live', models: [{ value: 'plugin-a', label: 'Plugin A' }] };
    },
  });
  try {
    for (const runtimeId of ['codex', 'claude', 'test-acp']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/cats/runtime-models',
        headers: { 'x-cat-cafe-user': 'test' },
        payload: { runtimeId },
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().message, 'plugin_unavailable');
      assert.deepEqual(response.json().models, [{ value: 'configured-a', label: 'configured-a' }]);
    }
    assert.equal(probes, 0);
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
  const generation = createAgentAccessModelCatalogGeneration({
    readCurrentAuthority: async () => current,
  });
  const first = await generation();
  current = authority({ lifecycleRevision: 2 });
  const second = await generation();
  assert.notEqual(first, second);
  assert.match(first, /inst-1:digest-1:1/);
});

test('stale model catalog requests cannot start a native inspection or publish old models', async () => {
  let current = authority();
  const discover = createAgentAccessModelCatalogDiscovery(
    { readCurrentAuthority: async () => current },
    {
      invoke: async (_instanceId, _action, payload) => {
        current = authority({ lifecycleRevision: 2 });
        await assert.rejects(() => payload.readClaude(), /session_implementation_unavailable/);
        return { status: 'live', models: [{ value: 'obsolete', label: 'Obsolete' }] };
      },
    },
  );
  await assert.rejects(
    discover({ kind: 'claude', command: 'never-launch', args: [], cwd: '/workspace' }),
    /session_implementation_unavailable/,
  );
});
