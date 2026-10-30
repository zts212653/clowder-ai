import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { dshLauncherProfileState } from '../src/routes/native-dsh-profile.js';
import { nativeBindingHarness } from '../src/routes/native-tool-catalog.js';
import { registerRuntimeCatalogRoute } from '../src/routes/runtime-catalog-route.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-patch-classification-'));
  const pkg = join(root, 'official-package');
  mkdirSync(join(pkg, 'lib'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh' }));
  const entry = join(pkg, 'lib/bin.js');
  writeFileSync(entry, '');
  const args = [entry, '--profile', 'acp', '--patch', join(root, 'managed.yml')];
  const saved = new Map(
    ['DSH_HOME', 'CAT_CAFE_CONFIG_ROOT', 'CAT_CAFE_GLOBAL_CONFIG_ROOT', 'CAT_TEMPLATE_PATH'].map((key) => [
      key,
      process.env[key],
    ]),
  );
  Object.assign(process.env, {
    DSH_HOME: join(root, 'native-home'),
    CAT_CAFE_CONFIG_ROOT: root,
    CAT_CAFE_GLOBAL_CONFIG_ROOT: root,
    CAT_TEMPLATE_PATH: join(root, 'cat-template.json'),
  });
  return {
    root,
    entry,
    args,
    restore() {
      for (const [key, value] of saved)
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    },
  };
}

test('official DSH with ordered absolute patches keeps its harness hint without changing profile readiness', () => {
  const f = fixture();
  try {
    for (const args of [f.args, [...f.args, '--patch', join(f.root, 'second.yml')]]) {
      const before = [...args];
      assert.equal(nativeBindingHarness(process.execPath, args, f.root), 'dsh');
      assert.equal(dshLauncherProfileState(process.execPath, args, f.root), 'custom_startup');
      assert.deepEqual(args, before);
    }
    for (const args of [
      [f.entry, '--profile', 'acp', '--patch', 'relative.yml'],
      [...f.args, '--eval', 'arbitrary()'],
      ['--import', 'wrapper.mjs', ...f.args],
      [join(f.root, 'wrapper.js'), '--profile', 'acp', '--patch', join(f.root, 'managed.yml')],
    ])
      assert.equal(nativeBindingHarness(process.execPath, args, f.root), undefined);
  } finally {
    f.restore();
  }
});

test('a classified patched DSH binding remains custom startup and cannot trigger model catalog spawning', async (t) => {
  const f = fixture();
  const original = catRegistry.getAllConfigs();
  const acp = { command: process.execPath, startupArgs: f.args, transport: 'stdio' as const };
  writeFileSync(
    join(f.root, 'cat-template.json'),
    JSON.stringify({
      version: 2,
      breeds: [{ id: 'fixture', catId: 'fixture', variants: [{ catId: 'fixture', acp }] }],
    }),
  );
  catRegistry.reset();
  catRegistry.register('fixture', {
    id: createCatId('fixture'),
    name: 'fixture',
    displayName: 'Fixture',
    clientId: 'acp',
    carrier: 'acp',
    defaultModel: '',
    mcpSupport: false,
    mentionPatterns: ['@fixture'],
    avatar: '',
    color: { primary: '#334455', secondary: '#ddeeff' },
    roleDescription: '',
    personality: '',
  });
  let spawns = 0;
  t.mock.method(childProcess, 'spawn', () => {
    spawns++;
    throw Error('catalog must not spawn a patched descriptor');
  });
  syncBuiltinESMExports();
  const app = Fastify();
  registerRuntimeCatalogRoute(app);
  try {
    assert.equal(nativeBindingHarness(process.execPath, f.args, f.root), 'dsh');
    const response = await app.inject({
      method: 'POST',
      url: '/api/cats/runtime-models',
      headers: { 'x-cat-cafe-user': 'fixture-owner' },
      payload: { runtimeId: 'acp:fixture', catId: 'fixture' },
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().message, 'custom_startup');
    assert.equal(spawns, 0);
  } finally {
    await app.close();
    t.mock.restoreAll();
    syncBuiltinESMExports();
    catRegistry.reset();
    for (const [id, config] of Object.entries(original)) catRegistry.register(id, config);
    f.restore();
  }
});
