import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PluginRuntimeCarrierRouter } from '../dist/domains/plugin/carrier/runtime-carrier.js';
import { ExternalPluginRuntimeSupervisor } from '../dist/domains/plugin/external-runtime/index.js';
import {
  BundledPluginRuntimeCarrier,
  COLLECTIVE_CONNECTOR_PLUGIN_MANIFEST,
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
  OFFICIAL_PLUGIN_CATALOG,
} from '../dist/domains/plugin/index.js';
import {
  completeExternalHandshake,
  createExternalRuntimeHarness,
  EXTERNAL_INSTANCE_ID,
  externalManifest,
  FakePluginProcessAdapter,
} from './plugin-external-runtime-helpers.js';

/**
 * F202 Train C1 — clause 6's "start-failure isolation" and "disable/uninstall recovers",
 * observed at the one carrier boundary rather than inside a single supervisor.
 *
 * The operator's frame (`…-002857-30d55ba2`): a plugin implementation is *allowed* to be
 * wrong — "只要插件启动加载失败不影响主 host 即可 … 禁用 / 卸载即可恢复". After C1 collapsed
 * carrier selection into one router, that promise is a property of the router plus two
 * unrelated carriers, and nothing pinned it there.
 *
 * Both instances live in one inventory: a bundled package whose in-Host runtime throws
 * during start, and an external package with a real spawned child. A recording double
 * would prove only that the router forwards; these cases need the surviving side to be a
 * process that actually comes up while the other side is failing.
 */
const BUNDLED_INSTANCE_ID = 'pi_bundled_broken';

async function twoCarrierHost() {
  const rootDir = await mkdtemp(join(tmpdir(), 'cat-cafe-f202-c1-isolation-'));
  const store = new MemoryPluginInventoryStore();

  const catalogEntry = OFFICIAL_PLUGIN_CATALOG.find((candidate) => candidate.catalogId === 'collective-connector');
  assert.ok(catalogEntry, 'the bundled package must come from the shipped catalog, not a test literal');
  const bundledControl = new HostInventoryControlPlane(store, {
    createInstanceId: () => BUNDLED_INSTANCE_ID,
    now: () => 1_000,
  });
  await bundledControl.installPackage({
    manifest: COLLECTIVE_CONNECTOR_PLUGIN_MANIFEST,
    computedPackageDigest: catalogEntry.packageDigest,
    expectedPackageDigest: catalogEntry.packageDigest,
    packagePluginId: catalogEntry.pluginId,
    effectiveGrants: [],
    signalSchemas: {},
  });
  await store.transaction((transaction) => {
    const instance = transaction.instances.get(BUNDLED_INSTANCE_ID);
    transaction.instances.put({
      ...instance,
      configReadiness: 'ready',
      activationState: 'enabled',
      runtimeState: 'stopped',
      updatedAt: 1_001,
    });
  });

  const harness = await createExternalRuntimeHarness({ rootDir, inventory: store });

  // A plugin implementation error, not a Host error: the in-Host runtime throws on start
  // until the owner repairs it. `broken` is what disable/uninstall would have fixed.
  const runtime = {
    broken: true,
    starts: 0,
    stops: [],
    claims: (packageRecord) => packageRecord.manifest.pluginId === COLLECTIVE_CONNECTOR_PLUGIN_MANIFEST.pluginId,
    async start() {
      this.starts += 1;
      if (this.broken) throw new Error('plugin implementation threw while loading');
    },
    async stop(_pluginInstanceId, reason) {
      this.stops.push(reason);
    },
  };

  const processes = new FakePluginProcessAdapter();
  const router = new PluginRuntimeCarrierRouter(store);
  router.register(new BundledPluginRuntimeCarrier({ inventory: store, runtimes: [runtime], now: () => 2_000 }));
  router.register(
    new ExternalPluginRuntimeSupervisor({
      inventory: store,
      broker: harness.broker,
      packages: {
        async resolveInstalledPackage() {
          return {
            rootDir,
            manifest: externalManifest(),
            verifyIntegrity: async () => undefined,
            release: async () => undefined,
          };
        },
      },
      processes,
    }),
  );

  return { store, router, runtime, processes };
}

async function instanceRecord(store, pluginInstanceId) {
  const snapshot = await store.snapshot();
  return snapshot.instances.find((candidate) => candidate.pluginInstanceId === pluginInstanceId);
}

async function startExternal(host) {
  const starting = host.router.start(EXTERNAL_INSTANCE_ID);
  const child = await host.processes.nextProcess();
  await completeExternalHandshake(child);
  await starting;
  return child;
}

test('a plugin that throws while loading does not stop another carrier from running', async () => {
  const host = await twoCarrierHost();

  await assert.rejects(host.router.start(BUNDLED_INSTANCE_ID), /threw while loading/);

  const failed = await instanceRecord(host.store, BUNDLED_INSTANCE_ID);
  assert.equal(failed.runtimeState, 'stopped', 'a package that never came up must not be projected as running');
  assert.deepEqual(host.runtime.stops, ['start_failed'], 'the carrier must unwind the half-started runtime');

  // The isolation claim: a different package on a different carrier still reaches a real
  // running child while the broken one is failing.
  const child = await startExternal(host);
  const healthy = await instanceRecord(host.store, EXTERNAL_INSTANCE_ID);
  assert.equal(healthy.runtimeState, 'healthy');
  assert.equal(child.terminateCalls, 0, 'the surviving package must not be collateral damage');

  await host.router.stopAll('host_shutdown');
  assert.equal(child.terminateCalls, 1, 'shutdown must reach the real child through the router');
});

test('a start failure is recorded as a failure, not as a silent stop', async () => {
  const host = await twoCarrierHost();

  await assert.rejects(host.router.start(BUNDLED_INSTANCE_ID), /threw while loading/);

  const failed = await instanceRecord(host.store, BUNDLED_INSTANCE_ID);
  assert.ok(
    failed.lastRuntimeError,
    'clause 6 makes the failure recoverable by its owner — the owner cannot recover from a failure the Host never recorded',
  );
});

test('disabling a broken plugin clears the failure, and a repaired one starts again', async () => {
  const host = await twoCarrierHost();
  await assert.rejects(host.router.start(BUNDLED_INSTANCE_ID), /threw while loading/);

  // The owner's recovery path: disable, repair the package, enable, start.
  await host.store.transaction((transaction) => {
    const instance = transaction.instances.get(BUNDLED_INSTANCE_ID);
    transaction.instances.put({ ...instance, activationState: 'disabled', updatedAt: 3_000 });
  });
  await host.router.stop(BUNDLED_INSTANCE_ID, 'owner_disabled');
  host.runtime.broken = false;
  await host.store.transaction((transaction) => {
    const instance = transaction.instances.get(BUNDLED_INSTANCE_ID);
    transaction.instances.put({ ...instance, activationState: 'enabled', updatedAt: 4_000 });
  });

  await host.router.start(BUNDLED_INSTANCE_ID);

  const recovered = await instanceRecord(host.store, BUNDLED_INSTANCE_ID);
  assert.equal(recovered.runtimeState, 'healthy', 'a failed start must leave no residue that blocks a later one');
  assert.equal(recovered.lastRuntimeError, undefined, 'a successful start must clear the previous failure');
  assert.equal(host.runtime.starts, 2, 'the repaired runtime must actually be started again');
});
