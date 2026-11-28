import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { discoverNativeRuntimes } from '../dist/routes/native-runtimes.js';
import { registerRuntimeCatalogRoute } from '../dist/routes/runtime-catalog-route.js';
import { invalidateCliCommand } from '../dist/utils/cli-resolve.js';

for (const installed of [true, false]) {
  test(`AGY discovery checks the actual executable with installed=${installed}, not Gemini or the retired IDE`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'native-agy-discovery-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const command = join(root, 'agy');
    writeFileSync(command, '#!/bin/sh\nexit 97\n');
    chmodSync(command, 0o755);
    const calls = [];
    const found = (
      await discoverNativeRuntimes(root, (name) => {
        calls.push(name);
        return installed && name === 'agy' ? command : null;
      })
    ).runtimes;
    const agy = found.find((item) => item.id === 'agy-native');
    assert.ok(agy, 'AGY must be discoverable independently of an installed Gemini CLI');
    assert.equal(agy.clientId, 'google');
    assert.equal(agy.agyCarrier, 'native');
    assert.equal(agy.label, 'AGY Native');
    assert.equal(agy.installed, installed);
    assert.equal(agy.command, installed ? command : undefined);
    assert.equal(found.find((item) => item.id === 'agy-acp')?.agyCarrier, 'acp');
    assert.ok(calls.includes('agy'));
    assert.equal(calls.includes('gemini') || calls.includes('antigravity'), false);
    assert.equal(
      found.some((item) => ['gemini', 'antigravity'].includes(item.id)),
      false,
    );
  });
}

test('configured official ACP remains a Google binding with its exact startup and permissions', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'native-agy-acp-'));
  const existing = catRegistry.getAllConfigs();
  t.after(() => {
    catRegistry.reset();
    for (const [id, config] of Object.entries(existing)) catRegistry.register(id, config);
    rmSync(root, { recursive: true, force: true });
  });
  const command = join(root, 'official-acp');
  writeFileSync(command, '#!/bin/sh\nexit 97\n');
  const acp = { command, startupArgs: ['--profile', 'argon-personal'], transport: 'stdio' };
  const agyProfile = { enabled: true, carrier: 'acp', profileId: 'argon-personal', autoApprove: false };
  catRegistry.register(
    'agy-acp-fixture',
    { id: 'agy-acp-fixture', clientId: 'google', agyProfile },
    { configurationTemplatePath: join(root, 'cat-template.json') },
  );
  writeFileSync(
    join(root, 'cat-template.json'),
    JSON.stringify({
      breeds: [{ catId: 'agy-acp-fixture', variants: [{ catId: 'agy-acp-fixture', acp }] }],
    }),
  );
  const found = (await discoverNativeRuntimes(root, () => null)).runtimes.find(
    (item) => item.id === 'acp:agy-acp-fixture',
  );
  assert.equal(found?.clientId, 'google');
  assert.equal(found?.agyCarrier, 'acp');
  assert.equal(found?.installed, true);
  assert.deepEqual(found?.acp, acp);
  assert.deepEqual(catRegistry.getOrThrow('agy-acp-fixture').config.agyProfile, agyProfile);
});

test('reading either AGY model catalog never launches a process without its profile isolation', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-catalog-no-launch-'));
  const marker = join(root, 'spawned');
  const originalPath = process.env.PATH;
  process.env.PATH = `${root}${delimiter}${originalPath}`;
  t.after(() => {
    process.env.PATH = originalPath;
    for (const name of ['agy', 'agy_acp_server.par']) invalidateCliCommand(name);
    rmSync(root, { recursive: true, force: true });
  });
  for (const name of ['agy', 'agy_acp_server.par']) {
    invalidateCliCommand(name);
    const command = join(root, name);
    writeFileSync(command, `#!/bin/sh\nprintf spawned > '${marker}'\nexit 0\n`);
    chmodSync(command, 0o755);
  }
  const app = Fastify();
  registerRuntimeCatalogRoute(app);
  t.after(() => app.close());
  for (const runtimeId of ['agy-native', 'agy-acp']) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/cats/runtime-models',
      headers: { 'x-cat-cafe-user': 'fixture' },
      payload: { runtimeId, model: 'gemini-4-neon-xhigh' },
    });
    assert.equal(response.statusCode, 200, response.body);
    const body = response.json();
    assert.equal(body.message, 'configured_only');
    assert.ok(
      body.models.some((entry) => entry.value === 'gemini-4-neon-xhigh'),
      'AGY read-only catalog must list gemini-4-neon-xhigh',
    );
    assert.deepEqual(
      body.effortOptions?.map((entry) => entry.value),
      ['low', 'medium', 'high', 'xhigh'],
    );
    assert.equal(body.selectedEffort, 'xhigh');
    assert.equal(
      body.selectedEffortSource,
      undefined,
      'effort inferred from model string must not be mislabeled as tool_config',
    );
    assert.equal(body.defaultModelSource, undefined);
    assert.equal(body.defaultEffortSource, undefined);
    assert.equal(existsSync(marker), false, 'read-side discovery must not start an unisolated AGY process');
  }
});

test('AGY account catalog distinguishes static reference fallback from explicit account models and omits false tool_config labels', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'agy-catalog-account-'));
  const prevGlobal = process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
  const prevProject = process.env.CAT_CAFE_WORKSPACE_ROOT;
  process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = root;
  process.env.CAT_CAFE_WORKSPACE_ROOT = root;
  t.after(() => {
    if (prevGlobal === undefined) delete process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT;
    else process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT = prevGlobal;
    if (prevProject === undefined) delete process.env.CAT_CAFE_WORKSPACE_ROOT;
    else process.env.CAT_CAFE_WORKSPACE_ROOT = prevProject;
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, '.cat-cafe'), { recursive: true });
  writeFileSync(
    join(root, '.cat-cafe', 'accounts.json'),
    JSON.stringify({
      gemini: {
        clientId: 'google',
        displayName: 'Default Google',
        authType: 'oauth',
        models: [],
      },
      'agy-declared': {
        clientId: 'google',
        displayName: 'Declared Google',
        authType: 'oauth',
        models: ['gemini-4-neon-high'],
      },
    }),
  );
  const app = Fastify();
  registerRuntimeCatalogRoute(app);
  t.after(() => app.close());

  // 1. Account with empty models falls back to read-only reference list, NEVER mislabeled account_catalog.
  const fallbackRes = await app.inject({
    method: 'POST',
    url: '/api/cats/runtime-models',
    headers: { 'x-cat-cafe-user': 'fixture' },
    payload: { runtimeId: 'agy-native', accountRef: 'gemini', model: 'gemini-4-neon-xhigh' },
  });
  assert.equal(fallbackRes.statusCode, 200, fallbackRes.body);
  const fallbackBody = fallbackRes.json();
  assert.equal(fallbackBody.status, 'configured');
  assert.equal(fallbackBody.message, 'reference_catalog');
  assert.ok(fallbackBody.models.some((entry) => entry.value === 'gemini-4-neon-xhigh'));
  assert.equal(fallbackBody.selectedModel, 'gemini-4-neon-xhigh');
  assert.equal(fallbackBody.selectedEffort, 'xhigh');
  assert.equal(fallbackBody.selectedEffortSource, undefined);
  assert.deepEqual(
    fallbackBody.effortOptions?.map((entry) => entry.value),
    ['low', 'medium', 'high', 'xhigh'],
  );

  // 2. Arbitrary manually-typed custom model stays accepted without inventing effort options.
  const customRes = await app.inject({
    method: 'POST',
    url: '/api/cats/runtime-models',
    headers: { 'x-cat-cafe-user': 'fixture' },
    payload: { runtimeId: 'agy-native', accountRef: 'gemini', model: 'gemini-future-preview' },
  });
  assert.equal(customRes.statusCode, 200, customRes.body);
  const customBody = customRes.json();
  assert.equal(customBody.message, 'reference_catalog');
  assert.equal(customBody.selectedModel, 'gemini-future-preview');
  assert.equal(customBody.selectedEffort, undefined);
  assert.equal(customBody.selectedEffortSource, undefined);

  // 3. Account with explicit models reports account_catalog and returns only declared models.
  const declaredRes = await app.inject({
    method: 'POST',
    url: '/api/cats/runtime-models',
    headers: { 'x-cat-cafe-user': 'fixture' },
    payload: { runtimeId: 'agy-native', accountRef: 'agy-declared', model: 'gemini-4-neon-high' },
  });
  assert.equal(declaredRes.statusCode, 200, declaredRes.body);
  const declaredBody = declaredRes.json();
  assert.equal(declaredBody.status, 'configured');
  assert.equal(declaredBody.message, 'account_catalog');
  assert.deepEqual(
    declaredBody.models.map((entry) => entry.value),
    ['gemini-4-neon-high'],
  );
  assert.equal(declaredBody.selectedEffort, 'high');
  assert.equal(declaredBody.selectedEffortSource, undefined);
});
