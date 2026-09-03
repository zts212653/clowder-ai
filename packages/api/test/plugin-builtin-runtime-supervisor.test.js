import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  COLLECTIVE_CONNECTOR_PLUGIN_MANIFEST,
  HostInventoryControlPlane,
  HybridPluginRuntimeSupervisor,
  MemoryPluginInventoryStore,
  OFFICIAL_PLUGIN_CATALOG,
} from '../dist/domains/plugin/index.js';

test('hybrid supervisor starts and stops the bundled Connector without external process authority', async () => {
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
    async start(pluginInstanceId) {
      calls.push(['builtin-start', pluginInstanceId]);
    },
    async stop(pluginInstanceId, reason) {
      calls.push(['builtin-stop', pluginInstanceId, reason]);
    },
  };
  const external = {
    handshakeTimeoutMs: 123,
    async start() {
      throw new Error('external process must not start');
    },
    async stop() {
      throw new Error('external process must not stop');
    },
    async stopAll() {},
    async recoverAfterRestart() {
      return 0;
    },
    async deliver() {
      throw new Error('builtin runtime has no stdio delivery');
    },
  };
  const supervisor = new HybridPluginRuntimeSupervisor({
    inventory: store,
    external,
    builtinRuntimes: new Map([[entry.pluginId, runtime]]),
    now: () => 30_001,
  });

  await supervisor.start(installed.pluginInstanceId);
  let instance = (await store.snapshot()).instances[0];
  assert.equal(instance.runtimeState, 'healthy');
  assert.equal(instance.lifecycleRevision, 1, 'runtime health must not advance owner lifecycle fences');
  assert.equal(supervisor.handshakeTimeoutMs, 123);

  await supervisor.stop(installed.pluginInstanceId, 'owner_disabled');
  instance = (await store.snapshot()).instances[0];
  assert.equal(instance.runtimeState, 'stopped');
  assert.equal(instance.lifecycleRevision, 1);
  assert.deepEqual(calls, [
    ['builtin-start', installed.pluginInstanceId],
    ['builtin-stop', installed.pluginInstanceId, 'owner_disabled'],
  ]);
});
