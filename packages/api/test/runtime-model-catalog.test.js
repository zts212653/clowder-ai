import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { createCatalogCache, registerRuntimeCatalogRoute } from '../dist/routes/runtime-catalog-route.js';
import { parseAcpCatalog, parseClaudeModels, parseCodexModels } from '../dist/routes/runtime-model-catalog.js';

test('Codex advertised effort belongs to each model; catalog default is not the CLI default', () => {
  assert.deepEqual(
    parseCodexModels({
      data: [
        { model: 'a', displayName: 'A', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
        { model: 'hidden', hidden: true },
      ],
    }).map((m) => ({ value: m.value, efforts: m.efforts.map((e) => e.value) })),
    [{ value: 'a', efforts: ['low'] }],
  );
});
test('Claude distinguishes unsupported and unknown effort capabilities', () => {
  const models = parseClaudeModels([
    { value: 'opus', supportedEffortLevels: ['low', 'high'] },
    { value: 'haiku', supportsEffort: false },
    { value: 'custom' },
  ]);
  assert.deepEqual(
    models[0].efforts.map((e) => e.value),
    ['low', 'high'],
  );
  assert.deepEqual(models[1].efforts, []);
  assert.equal(models[2].efforts, undefined);
});
test('ACP keeps opaque values and returns model-dependent efforts without replacing inherited defaults', () => {
  const defaults = {
    configOptions: [
      {
        id: 'model',
        category: 'model',
        currentValue: '["p","a"]',
        options: [
          {
            name: 'Provider',
            options: [
              { value: '["p","a"]', name: 'A' },
              { value: '["p","b"]', name: 'B' },
            ],
          },
        ],
      },
      { id: 'reason', category: 'thought_level', currentValue: 'high', options: [{ value: 'high' }] },
    ],
  };
  const selected = {
    configOptions: [
      defaults.configOptions[0],
      { id: 'reason', category: 'thought_level', currentValue: 'low', options: [{ value: 'low', name: 'Low' }] },
    ],
  };
  const result = parseAcpCatalog(selected, defaults, '["p","b"]');
  assert.equal(result.models[1].value, '["p","b"]');
  assert.equal(result.models[1].group, 'Provider');
  assert.equal(result.defaultEffort, 'high');
  assert.deepEqual(
    result.effortOptions.map((e) => e.value),
    ['low'],
  );
});
test('catalog cache deduplicates, scopes targets and retains last results on failed refresh', async () => {
  let calls = 0,
    fail = false;
  const cache = createCatalogCache(async () => {
    calls++;
    if (fail) throw Error('private error');
    return { status: 'live', models: [{ value: 'a', label: 'A' }] };
  });
  const target = { kind: 'codex', command: 'codex', args: [], cwd: '/workspace' };
  await Promise.all([cache('one', target), cache('one', target)]);
  assert.equal(calls, 1);
  await cache('two', target);
  assert.equal(calls, 2);
  fail = true;
  const result = await cache('one', target, true);
  assert.equal(result.status, 'configured');
  assert.equal(result.models[0].value, 'a');
  assert.doesNotMatch(JSON.stringify(result), /private/);
});

test('catalog route requires identity and rejects executable input before discovery', async () => {
  const app = Fastify();
  registerRuntimeCatalogRoute(app);
  try {
    const anonymous = await app.inject({
      method: 'POST',
      url: '/api/cats/runtime-models',
      payload: { runtimeId: 'codex' },
    });
    assert.equal(anonymous.statusCode, 401);
    const unsafe = await app.inject({
      method: 'POST',
      url: '/api/cats/runtime-models',
      headers: { 'x-cat-cafe-user': 'test' },
      payload: { runtimeId: 'codex', command: 'arbitrary', args: ['execute'] },
    });
    assert.equal(unsafe.statusCode, 400);
  } finally {
    await app.close();
  }
});
