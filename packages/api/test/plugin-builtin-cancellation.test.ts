import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  type BundledPluginRuntime,
  BundledPluginRuntimeCarrier,
} from '../src/domains/plugin/builtin-runtime/carriers/bundled-runtime-carrier.js';
import { CHATGPT_DOT_PLUGIN_MANIFEST } from '../src/domains/plugin/chatgpt-dot-manifest.js';
import { HostInventoryControlPlane } from '../src/domains/plugin/host-inventory/control-plane.js';
import { MemoryPluginInventoryStore } from '../src/domains/plugin/host-inventory/stores.js';
import { OFFICIAL_PLUGIN_CATALOG } from '../src/domains/plugin/official-catalog.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture(runtime: Omit<BundledPluginRuntime, 'claims'>) {
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store);
  const entry = OFFICIAL_PLUGIN_CATALOG.find((row) => row.catalogId === 'chatgpt-dot')!;
  const installed = await inventory.installPackage({
    manifest: CHATGPT_DOT_PLUGIN_MANIFEST,
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
  const supervisor = new BundledPluginRuntimeCarrier({
    inventory: store,
    runtimes: [{ claims: ({ manifest }) => manifest.pluginId === entry.pluginId, ...runtime }],
  });
  return { store, supervisor, id: installed.pluginInstanceId };
}

test('cancelled builtin startup is joined and cleaned before its replacement starts', async () => {
  const started = deferred();
  const completeOldStart = deferred();
  const stopEntered = deferred();
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
      stopEntered.resolve();
    },
  });
  const oldStart = f.supervisor.start(f.id);
  const rejected = assert.rejects(oldStart, /cancelled/);
  await started.promise;
  const stopping = f.supervisor.stop(f.id);
  await stopEntered.promise;
  await assert.rejects(f.supervisor.start(f.id), /already has a builtin runtime owner/);
  completeOldStart.resolve();
  await rejected;
  await stopping;
  assert.equal(stops, 2, 'stop must clean allocations made by the cancelled startup tail');
  await f.supervisor.start(f.id);
  assert.equal(stops, 2, 'replacement must not inherit pending cleanup');
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
