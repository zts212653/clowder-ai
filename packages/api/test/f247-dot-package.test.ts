import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { CHATGPT_DOT_PLUGIN_MANIFEST } from '../src/domains/plugin/chatgpt-dot-manifest.js';
import { HostInventoryControlPlane } from '../src/domains/plugin/host-inventory/control-plane.js';
import { MemoryPluginInventoryStore } from '../src/domains/plugin/host-inventory/stores.js';
import { MachineOfficialPluginCatalog } from '../src/domains/plugin/manager/machine-catalog-provider.js';
import { OFFICIAL_PLUGIN_CATALOG } from '../src/domains/plugin/official-catalog.js';
import { OfficialPluginPackageInstaller } from '../src/domains/plugin/official-package-installer.js';
import {
  createDormantPluginRuntimeComposition,
  OfficialPluginManagerCatalogAdapter,
} from '../src/domains/plugin/runtime-composition.js';
import { memoryPluginStorage } from './helpers/memory-plugin-private-storage.js';

test('one cloud GPT entry enables dot collaboration without installing another ChatGPT connection', () => {
  const dot = OFFICIAL_PLUGIN_CATALOG.find((entry) => entry.pluginId === 'official.chatgpt-dot');
  assert.ok(dot, 'the default plugin catalog must discover ChatGPT dot');
  assert.equal(dot.distribution, 'bundled');
  assert.equal(dot.packageName, '@clowder-ai/chatgpt-dot');
  assert.equal(dot.version, CHATGPT_DOT_PLUGIN_MANIFEST.version);
  assert.equal(dot.pluginId, CHATGPT_DOT_PLUGIN_MANIFEST.pluginId);
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
  assert.equal(projection.candidates[0]?.displayName, 'ChatGPT Dot');
});

test('Host-bundled dot remains discoverable when the external package catalog is offline', async () => {
  const dot = OFFICIAL_PLUGIN_CATALOG.find((entry) => entry.pluginId === 'official.chatgpt-dot');
  assert.ok(dot);
  const catalog = new MachineOfficialPluginCatalog({
    loadCatalog: async () => {
      throw new Error('offline');
    },
    validateCatalog: () => ({ valid: true, catalog: { plugins: [] } }),

    bundledEntries: [dot],
  });
  const snapshot = await catalog.snapshot();
  assert.equal(snapshot.status, 'degraded');
  assert.equal(snapshot.entries.find((entry) => entry.pluginId === dot.pluginId)?.packageDigest, dot.packageDigest);
});

test('reviewed bundled Dot archive starts through the generic module carrier', async (t) => {
  const dot = OFFICIAL_PLUGIN_CATALOG.find((entry) => entry.pluginId === 'official.chatgpt-dot');
  assert.ok(dot);
  const projectRoot = await mkdtemp(join(tmpdir(), 'f202-dot-module-'));
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    messageStore: new MessageStore(),
    privateStorage: memoryPluginStorage(),
  });
  t.after(async () => {
    await runtime.shutdown();
    await rm(projectRoot, { recursive: true, force: true });
  });
  const installer = new OfficialPluginPackageInstaller({
    inventory: runtime.inventory,
    packagesRoot: runtime.paths.packagesRoot,
    catalog: [dot],
  });
  const installed = await installer.install(dot.catalogId, {
    version: dot.version,
    packageDigest: dot.packageDigest,
  });
  const prepared = await runtime.lifecycle.prepare(installed.pluginInstanceId, 1);
  const enabled = await runtime.lifecycle.enable(installed.pluginInstanceId, prepared.lifecycleRevision);

  assert.equal(enabled.runtimeState, 'healthy');
  assert.equal(await runtime.supervisor.exposesAction(installed.pluginInstanceId, 'deliverMessage'), false);
  await assert.rejects(
    runtime.supervisor.deliver(installed.pluginInstanceId, {
      kind: 'message',
      reason: 'addressed',
      deliveryId: 'fixed-call-probe',
      threadId: 'thread-probe',
      envelope: {
        messageId: 'message-probe',
        revision: 1,
        threadId: 'thread-probe',
        actor: { kind: 'user', id: 'owner' },
        audience: { kind: 'public' },
        occurredAt: '2026-10-21T00:00:00.000Z',
        payload: {
          provenance: { epistemicStatus: 'observation', origin: { kind: 'host' } },
          elements: [{ elementId: 'text-1', kind: 'text', payload: { text: '@dot hello' } }],
        },
      },
    }),
  );
  assert.equal(
    runtime.supervisor.resolvePluginWebhook(dot.pluginId, 'mcp', 'POST'),
    undefined,
    'the external MCP bridge uses the fixed plugin handle port, not a webhook contribution',
  );
  await runtime.lifecycle.disable(installed.pluginInstanceId, enabled.lifecycleRevision);
});
