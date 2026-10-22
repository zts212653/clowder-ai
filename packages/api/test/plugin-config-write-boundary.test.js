import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FilePluginInventoryStore } from '../dist/domains/plugin/host-inventory/stores.js';
import { readPluginConfig, writePluginConfig } from '../dist/domains/plugin/plugin-config-store.js';

test('all config writers share the inventory commit boundary across API processes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-writer-boundary-'));
  const store = new FilePluginInventoryStore(join(root, '.cat-cafe/plugin-host/inventory.json'));
  const moduleURL = new URL('../dist/domains/plugin/plugin-config-store.js', import.meta.url).href;
  const child = `import {writePluginConfig} from ${JSON.stringify(moduleURL)}; writePluginConfig(${JSON.stringify(root)}, 'fixture', [{name:'other',value:'concurrent'}]);`;
  await store.transaction(async () => {
    assert.throws(
      () => execFileSync(process.execPath, ['--input-type=module', '-e', child], { stdio: 'pipe' }),
      /PLUGIN_WRITE_BUSY/,
    );
  });
  execFileSync(process.execPath, ['--input-type=module', '-e', child], { stdio: 'pipe' });
  assert.equal(readPluginConfig(root, 'fixture').other, 'concurrent');
});

test('last admission assertion runs inside the shared write boundary and can stop persistence', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-writer-assert-'));
  writePluginConfig(root, 'fixture', [{ name: 'clients', value: 'old' }]);
  const path = join(root, '.cat-cafe/plugin-config/fixture.json');
  const before = readFileSync(path, 'utf8');
  assert.throws(
    () =>
      writePluginConfig(root, 'fixture', [{ name: 'clients', value: 'new' }], {
        beforeWrite: () => {
          throw new Error('admission changed');
        },
      }),
    /admission changed/,
  );
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('a dead complete lease is recovered on the next explicit write', () => {
  const root = mkdtempSync(join(tmpdir(), 'plugin-writer-retry-'));
  const moduleURL = new URL('../dist/domains/plugin/host-inventory/mutation-lease.js', import.meta.url).href;
  const script = `import {acquirePluginMutationLease} from ${JSON.stringify(moduleURL)}; acquirePluginMutationLease(${JSON.stringify(join(root, '.cat-cafe/plugin-host'))}); process.exit(17);`;
  assert.throws(() => execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' }));
  writePluginConfig(root, 'fixture', [{ name: 'clients', value: 'recovered' }]);
  assert.equal(readPluginConfig(root, 'fixture').clients, 'recovered');
});
