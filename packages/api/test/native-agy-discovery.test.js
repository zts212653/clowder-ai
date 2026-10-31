import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { discoverNativeRuntimes } from '../dist/routes/native-runtimes.js';
import { registerRuntimeCatalogRoute } from '../dist/routes/runtime-catalog-route.js';
import { invalidateCliCommand } from '../dist/utils/cli-resolve.js';

for (const installed of [true, false]) {
  test(`AGY discovery checks the actual executable with installed=${installed}, not Gemini or the retired IDE`, (t) => {
    const root = mkdtempSync(join(tmpdir(), 'native-agy-discovery-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const command = join(root, 'agy');
    writeFileSync(command, '#!/bin/sh\nexit 97\n');
    chmodSync(command, 0o755);
    const calls = [];
    const found = discoverNativeRuntimes(root, (name) => {
      calls.push(name);
      return installed && name === 'agy' ? command : null;
    }).runtimes;
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

test('configured official ACP remains a Google binding with its exact startup and permissions', (t) => {
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
  catRegistry.register('agy-acp-fixture', { id: 'agy-acp-fixture', clientId: 'google', agyProfile });
  writeFileSync(
    join(root, 'cat-template.json'),
    JSON.stringify({
      breeds: [{ catId: 'agy-acp-fixture', variants: [{ catId: 'agy-acp-fixture', acp }] }],
    }),
  );
  const found = discoverNativeRuntimes(root, () => null).runtimes.find((item) => item.id === 'acp:agy-acp-fixture');
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
  process.env.PATH = `${root}:${originalPath}`;
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
      payload: { runtimeId },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().message, 'configured_only');
    assert.equal(existsSync(marker), false, 'read-side discovery must not start an unisolated AGY process');
  }
});
