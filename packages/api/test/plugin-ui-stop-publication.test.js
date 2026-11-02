import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BundledPluginRuntimeCarrier } from '../dist/domains/plugin/builtin-runtime/carriers/bundled-runtime-carrier.js';
import { PluginRuntimeCarrierRouter } from '../dist/domains/plugin/carrier/runtime-carrier.js';

function fixture() {
  const manifest = {
    pluginId: 'dev.clowder.ui-stop-fixture',
    version: '0.1.0',
    contractVersion: '0.1.0',
    name: 'UI stop fixture',
    features: [{ id: 'main', name: 'Main', resources: [], capabilities: [] }],
    runtime: { transport: 'builtin' },
    contributions: [
      { type: 'ui', id: 'open', kind: 'command', action: { method: 'panel' } },
      { type: 'ui', id: 'entry', kind: 'slot-item', label: 'Fixture', command: 'open', group: 'activity-bar.bottom' },
    ],
  };
  const packageRecord = {
    packageDigest: 'owned-digest',
    pluginId: manifest.pluginId,
    version: manifest.version,
    contractVersion: manifest.contractVersion,
    manifest,
    signalSchemas: {},
    packageState: 'installed',
    verifiedAt: 0,
    updatedAt: 0,
  };
  let instance = {
    pluginInstanceId: 'owned-instance',
    pluginId: manifest.pluginId,
    packageDigest: packageRecord.packageDigest,
    lifecycleState: 'installed',
    configReadiness: 'ready',
    activationState: 'enabled',
    runtimeState: 'stopped',
    lifecycleRevision: 1,
    installedAt: 0,
    updatedAt: 0,
  };
  const inventory = {
    snapshot: async () => ({ packages: [packageRecord], instances: [instance] }),
    transaction: async (apply) =>
      apply({
        instances: {
          get: () => instance,
          put: (record) => {
            instance = record;
          },
        },
      }),
  };
  const carrier = new BundledPluginRuntimeCarrier({
    inventory,
    runtimes: [{ claims: () => true, start: async () => {}, stop: async () => {} }],
  });
  const router = new PluginRuntimeCarrierRouter(inventory);
  router.register(carrier);
  return { router, carrier, inventory };
}

for (const stop of ['stop', 'stopAll']) {
  test(`${stop} between real carrier readiness and UI publication cannot revive the entry`, async () => {
    const { router, carrier, inventory } = fixture();
    const start = carrier.start.bind(carrier);
    let stopping;
    carrier.start = async (...args) => {
      const result = await start(...args);
      queueMicrotask(() => {
        stopping = stop === 'stop' ? router.stop('owned-instance', 'owner_disable') : router.stopAll();
      });
      return result;
    };
    await router.start('owned-instance');
    await stopping;
    assert.equal((await inventory.snapshot()).instances[0].runtimeState, 'stopped');
    assert.deepEqual(router.ui.list(), []);
  });
}

test('stopAll removes published UI and rejects its old panel generation even after restart', async () => {
  const { router, inventory } = fixture();
  await router.start('owned-instance');
  const [entry] = router.ui.list();
  assert.ok(entry);
  await router.stopAll();
  assert.equal((await inventory.snapshot()).instances[0].runtimeState, 'stopped');
  assert.deepEqual(router.ui.list(), []);
  await assert.rejects(router.ui.call(entry.instanceId, entry.commandId, entry.generation, {}), /no longer active/);
  await router.start('owned-instance');
  assert.notEqual(router.ui.list()[0].generation, entry.generation);
  await assert.rejects(router.ui.call(entry.instanceId, entry.commandId, entry.generation, {}), /no longer active/);
  await router.stopAll();
});
