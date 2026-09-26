import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  BundledPluginRuntimeCarrier,
  COLLECTIVE_CONNECTOR_PLUGIN_MANIFEST,
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
  OFFICIAL_PLUGIN_CATALOG,
} from '../dist/domains/plugin/index.js';

test('bundled carrier starts and stops the bundled Connector without external process authority', async () => {
  const entry = OFFICIAL_PLUGIN_CATALOG.find((candidate) => candidate.catalogId === 'collective-connector');
  assert.ok(entry);
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, {
    createInstanceId: () => 'pi_collective_connector',
    now: () => 30_000,
  });
  const installed = await inventory.installPackage({
    manifest: COLLECTIVE_CONNECTOR_PLUGIN_MANIFEST,
    computedPackageDigest: entry.packageDigest,
    expectedPackageDigest: entry.packageDigest,
    packagePluginId: entry.pluginId,
    effectiveGrants: [],
    signalSchemas: {},
  });
  await store.transaction((transaction) => {
    const instance = transaction.instances.get(installed.pluginInstanceId);
    transaction.instances.put({
      ...instance,
      configReadiness: 'ready',
      activationState: 'enabled',
    });
  });

  const calls = [];
  const runtime = {
    claims: (packageRecord) => packageRecord.manifest.pluginId === entry.pluginId,
    async start(pluginInstanceId) {
      calls.push(['builtin-start', pluginInstanceId]);
    },
    async stop(pluginInstanceId, reason) {
      calls.push(['builtin-stop', pluginInstanceId, reason]);
    },
  };
  const supervisor = new BundledPluginRuntimeCarrier({
    inventory: store,
    runtimes: [runtime],
    now: () => 30_001,
  });

  const snapshot = await store.snapshot();
  assert.equal(
    supervisor.claims({ instance: snapshot.instances[0], packageRecord: snapshot.packages[0] }),
    true,
    'the bundled package belongs to the runtime that declares it',
  );
  assert.equal(
    supervisor.claims({
      instance: snapshot.instances[0],
      packageRecord: {
        ...snapshot.packages[0],
        manifest: { ...COLLECTIVE_CONNECTOR_PLUGIN_MANIFEST, pluginId: 'official.other-package' },
      },
    }),
    false,
    'a package no bundled runtime implements is declined, not delegated',
  );

  await supervisor.start(installed.pluginInstanceId);
  let instance = (await store.snapshot()).instances[0];
  assert.equal(instance.runtimeState, 'healthy');
  assert.equal(instance.lifecycleRevision, 1, 'runtime health must not advance owner lifecycle fences');

  await supervisor.stop(installed.pluginInstanceId, 'owner_disabled');
  instance = (await store.snapshot()).instances[0];
  assert.equal(instance.runtimeState, 'stopped');
  assert.equal(instance.lifecycleRevision, 1);
  assert.deepEqual(calls, [
    ['builtin-start', installed.pluginInstanceId],
    ['builtin-stop', installed.pluginInstanceId, 'owner_disabled'],
  ]);
});
