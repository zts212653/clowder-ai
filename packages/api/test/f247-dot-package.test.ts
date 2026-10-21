import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CHATGPT_DOT_PLUGIN_MANIFEST } from '../src/domains/plugin/chatgpt-dot-manifest.js';
import { HostInventoryControlPlane } from '../src/domains/plugin/host-inventory/control-plane.js';
import { MemoryPluginInventoryStore } from '../src/domains/plugin/host-inventory/stores.js';
import { MachineOfficialPluginCatalog } from '../src/domains/plugin/manager/machine-catalog-provider.js';
import { OFFICIAL_PLUGIN_CATALOG } from '../src/domains/plugin/official-catalog.js';
import { OfficialPluginPackageInstaller } from '../src/domains/plugin/official-package-installer.js';
import { OfficialPluginManagerCatalogAdapter } from '../src/domains/plugin/runtime-composition.js';

test('one cloud GPT entry enables dot collaboration without installing another ChatGPT connection', () => {
  const dot = OFFICIAL_PLUGIN_CATALOG.find((entry) => entry.pluginId === 'official.chatgpt-dot');
  assert.ok(dot, 'the default plugin catalog must discover ChatGPT dot');
  assert.equal(dot.distribution, 'bundled');
  assert.equal(dot.packageName, '@cat-cafe/chatgpt-dot');
  assert.deepEqual(dot.effectiveGrants, [], 'installation does not authorize events or source access');
  assert.equal(
    OFFICIAL_PLUGIN_CATALOG.some((entry) => entry.pluginId === 'official.collective-connector'),
    false,
    'Collective is distributed by the external plugin repository, not bundled into Host',
  );
});

test('dot installs through Host inventory once, and its real Manager row stays disabled until configured', async (t) => {
  const dot = OFFICIAL_PLUGIN_CATALOG.find((entry) => entry.pluginId === 'official.chatgpt-dot');
  assert.ok(dot);
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store);
  const packagesRoot = await mkdtemp(join(tmpdir(), 'f247-dot-package-'));
  t.after(() => rm(packagesRoot, { recursive: true }));
  const installer = new OfficialPluginPackageInstaller({ inventory, packagesRoot, catalog: [dot] });
  const release = { version: dot.version, packageDigest: dot.packageDigest };
  const first = await installer.install(dot.catalogId, release);
  const second = await installer.install(dot.catalogId, release);
  assert.equal(first.pluginInstanceId, second.pluginInstanceId);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.instances.length, 1);
  assert.equal(snapshot.instances[0]?.activationState, 'disabled');
  const provider = { snapshot: async () => ({ entries: [dot], status: 'fresh' as const, checkedAt: 1 }) };
  const projection = await new OfficialPluginManagerCatalogAdapter(provider, [CHATGPT_DOT_PLUGIN_MANIFEST]).snapshot();
  assert.equal(projection.candidates[0]?.displayName, 'ChatGPT 云端');
});

test('Host-bundled dot remains discoverable when the external package catalog is offline', async () => {
  const dot = OFFICIAL_PLUGIN_CATALOG.find((entry) => entry.pluginId === 'official.chatgpt-dot');
  assert.ok(dot);
  const catalog = new MachineOfficialPluginCatalog({
    loadCatalog: async () => {
      throw new Error('offline');
    },
    validateCatalog: () => ({ valid: true, catalog: { plugins: [] } }),
    hostPolicies: [],
    bundledEntries: [dot],
  });
  const snapshot = await catalog.snapshot();
  assert.equal(snapshot.status, 'degraded');
  assert.equal(snapshot.entries.find((entry) => entry.pluginId === dot.pluginId)?.packageDigest, dot.packageDigest);
});
