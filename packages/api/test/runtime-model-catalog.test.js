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
    { value: 'opus', displayName: 'Opus', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: ['low', 'high'] },
    { value: 'haiku', supportsEffort: false },
    { value: 'custom' },
  ]);
  assert.deepEqual(
    models[0].efforts.map((e) => e.value),
    ['low', 'high'],
  );
  assert.deepEqual(models[1].efforts, []);
  assert.equal(models[0].resolvedModel, 'claude-opus-5-5');
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
  assert.equal(result.selectedEffort, 'low');
  assert.deepEqual(
    result.effortOptions.map((e) => e.value),
    ['low'],
  );
});

test('ACP keeps effort-only selectors and names opaque provider defaults', () => {
  const session = {
    configOptions: [
      {
        id: 'thinking',
        category: 'thought_level',
        currentValue: '',
        options: [
          { value: '', name: 'Provider default' },
          { value: 'high', name: 'High' },
        ],
      },
    ],
  };
  const result = parseAcpCatalog(session, session);
  assert.equal(result.defaultEffort, '');
  assert.equal(result.defaultEffortLabel, 'Provider default');
  assert.equal(result.selectedEffort, '');
  assert.deepEqual(
    result.effortOptions.map((item) => item.value),
    ['', 'high'],
  );
});

test('ACP reports an advertised empty model default without changing missing-value semantics', () => {
  const descriptor = {
    id: 'model',
    category: 'model',
    currentValue: '',
    options: [
      { value: '', name: 'Provider default' },
      { value: 'opaque/custom', name: 'Custom' },
    ],
  };
  const session = { configOptions: [descriptor] };
  const result = parseAcpCatalog(session, session);
  assert.equal(result.defaultModelStatus, 'reported');
  assert.equal(result.defaultModel, '');
  assert.equal(result.defaultModelLabel, 'Provider default');
  assert.equal(result.selectedModel, '');
  const undeclared = { configOptions: [{ ...descriptor, options: descriptor.options.slice(1) }] };
  assert.equal(parseAcpCatalog(undeclared, undeclared).defaultModelStatus, 'unreported');
  const absent = { configOptions: [{ ...descriptor, currentValue: undefined }] };
  assert.equal(parseAcpCatalog(absent, absent).defaultModelStatus, 'unreported');
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

test('failed ACP refresh clears the former model and its effort together', async () => {
  let fail = false;
  const cache = createCatalogCache(async () => {
    if (fail) throw Error('offline');
    return {
      status: 'live',
      models: [{ value: 'a', label: 'A' }],
      defaultModel: 'a',
      defaultModelStatus: 'reported',
      defaultEffort: 'high',
      selectedModel: 'a',
      selectedEffort: 'high',
    };
  });
  const target = { kind: 'acp', command: 'fixture', args: [], cwd: '/workspace' };
  await cache('acp', target);
  fail = true;
  const result = await cache('acp', target, true);
  assert.equal(result.message, 'refresh_failed');
  assert.equal(result.defaultModel, undefined);
  assert.equal(result.defaultEffort, undefined);
  assert.equal(result.selectedEffort, undefined);
  assert.equal(result.models[0].value, 'a');
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
