import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type BuiltinPluginRuntime,
  HybridPluginRuntimeSupervisor,
} from '../src/domains/plugin/builtin-runtime/hybrid-supervisor.js';
import { HostInventoryControlPlane } from '../src/domains/plugin/host-inventory/control-plane.js';
import { MemoryPluginInventoryStore } from '../src/domains/plugin/host-inventory/stores.js';
import {
  COLLECTIVE_CONNECTOR_PLUGIN_MANIFEST,
  OFFICIAL_PLUGIN_CATALOG,
} from '../src/domains/plugin/official-catalog.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(runtime: BuiltinPluginRuntime) {
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store);
  const entry = OFFICIAL_PLUGIN_CATALOG.find((row) => row.catalogId === 'collective-connector')!;
  const installed = await inventory.installPackage({
    manifest: COLLECTIVE_CONNECTOR_PLUGIN_MANIFEST,
    computedPackageDigest: entry.packageDigest,
    expectedPackageDigest: entry.packageDigest,
    packagePluginId: entry.pluginId,
    effectiveGrants: [],
    signalSchemas: {},
  });
  await store.transaction((tx) => {
    tx.instances.put({
      ...tx.instances.get(installed.pluginInstanceId)!,
      configReadiness: 'ready',
      activationState: 'enabled',
    });
  });
  const unused = async (): Promise<never> => {
    throw new Error('external runtime must not run');
  };
  const supervisor = new HybridPluginRuntimeSupervisor({
    inventory: store,
    builtinRuntimes: new Map([[entry.pluginId, runtime]]),
    external: {
      start: unused,
      stop: unused,
      stopAll: unused,
      deliver: unused,
      recoverAfterRestart: unused,
      handshakeTimeoutMs: 1000,
    },
  });
  return { store, supervisor, id: installed.pluginInstanceId };
}

test('a late cancelled builtin startup cannot stop or overwrite its replacement', async () => {
  const started = deferred();
  const completeOldStart = deferred();
  let starts = 0;
  let stops = 0;
  const f = await fixture({
    async start() {
      if (++starts === 1) {
        started.resolve();
        await completeOldStart.promise;
      }
    },
    async stop() {
      stops++;
    },
  });
  const oldStart = f.supervisor.start(f.id);
  const rejected = assert.rejects(oldStart, /cancelled/);
  await started.promise;
  await f.supervisor.stop(f.id);
  await f.supervisor.start(f.id);
  completeOldStart.resolve();
  await rejected;
  assert.equal(stops, 1, 'late completion must not stop the replacement runtime');
  assert.equal((await f.store.snapshot()).instances[0]!.runtimeState, 'healthy');
  await f.supervisor.stop(f.id);
});

test('stale cleanup cannot overwrite a new lifecycle revision or retain a phantom active slot', async () => {
  const stopEntered = deferred();
  const finishStop = deferred();
  const f = await fixture({
    async start() {},
    async stop() {
      stopEntered.resolve();
      await finishStop.promise;
    },
  });
  await f.supervisor.start(f.id);
  const oldStop = f.supervisor.stop(f.id);
  const rejected = assert.rejects(oldStop, /authority changed/);
  await stopEntered.promise;
  await f.store.transaction((tx) => {
    const current = tx.instances.get(f.id)!;
    tx.instances.put({ ...current, lifecycleRevision: current.lifecycleRevision + 1, runtimeState: 'healthy' });
  });
  finishStop.resolve();
  await rejected;
  assert.equal((await f.store.snapshot()).instances[0]!.runtimeState, 'healthy');
  await f.supervisor.start(f.id);
  await f.supervisor.stop(f.id);
});
