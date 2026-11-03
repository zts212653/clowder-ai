import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareHostInitialPlugins } from '../dist/domains/plugin/manager/initial-plugin-installation.js';

test('a failed Host listen never starts initial plugin discovery or installation', async () => {
  const failure = new Error('listen failed');
  const hostListening = Promise.reject(failure);
  void hostListening.catch(() => {});
  let discoveryCalls = 0;
  const root = await mkdtemp(join(tmpdir(), 'initial-listen-'));
  const preparing = prepareHostInitialPlugins({
    hostListening,
    signal: new AbortController().signal,
    runtime: {
      paths: { inventorySnapshotPath: join(root, 'inventory.json') },
      inventoryStore: { snapshot: async () => ({ instances: [], packages: [] }) },
    },
    managerRuntime: { officialInstaller: {}, configuration: { reconcile: () => assert.fail('no plugin selected') } },
    catalog: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: 1 }) },
    loadSelection: async () => {
      discoveryCalls++;
      return { schemaVersion: 1, plugins: [] };
    },
    onFailure: () => assert.fail('unexpected installation failure'),
  });
  await assert.rejects(preparing, (error) => error === failure);
  assert.equal(discoveryCalls, 0, 'network/plugin preparation must not precede HTTP listening');
});
