import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { HostInventoryControlPlane } from '../dist/domains/plugin/host-inventory/control-plane.js';
import { SqlitePluginInventoryStore } from '../dist/domains/plugin/state-worker/stores.js';

import { candidate, digest, fixture, manifest } from './helpers/plugin-state-worker-fixture.js';

test('durable commit survives reopening; failed changes remain invisible to readers and restart', async (t) => {
  const f = await fixture(t);
  const store = f.open();
  const plane = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_worker' });
  await plane.installPackage(candidate);
  const second = f.open();
  await assert.rejects(
    store.transaction(async (tx) => {
      const before = await tx.instances.get('pi_worker');
      await tx.instances.put({ ...before, activationState: 'enabled', configReadiness: 'ready' });
      assert.equal(
        (await second.read.instances.get('pi_worker')).activationState,
        'disabled',
        'reader must see the committed state',
      );
      throw new Error('fixture abort');
    }),
    /fixture abort/,
  );
  assert.equal((await second.read.instances.get('pi_worker')).activationState, 'disabled');
  await store.transaction(async (tx) => {
    const i = await tx.instances.get('pi_worker');
    await tx.instances.put({ ...i, activationState: 'enabled', configReadiness: 'ready' });
  });
  await store.close();
  const reopened = f.open();
  assert.equal((await reopened.read.instances.get('pi_worker')).activationState, 'enabled');
});

test('failed commit compensates before another writer can enter, and leaves no partial rows', async (t) => {
  const f = await fixture(t);
  const store = f.open();
  const plane = new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_worker' });
  await plane.installPackage(candidate);
  let compensated = false;
  await assert.rejects(
    store.transaction(
      async (tx) => {
        const original = await tx.packages.get(digest);
        await tx.packages.put({ ...original, packageState: 'quarantined' });
      },
      {
        onCommitFailure() {
          const module = new URL('../dist/domains/plugin/host-inventory/writer-lease.js', import.meta.url).href;
          const child = spawnSync(
            process.execPath,
            [
              '--input-type=module',
              '-e',
              `const {requireInventoryWriterLease}=await import(${JSON.stringify(module)});try{const release=requireInventoryWriterLease(process.argv[1]);release();process.exit(1);}catch(e){process.exit(e.code==='INVENTORY_INVARIANT'?0:2);}`,
              f.file,
            ],
            { encoding: 'utf8', timeout: 10000 },
          );
          assert.equal(child.status, 0, child.stderr);
          compensated = true;
        },
      },
    ),
  );
  assert.equal(compensated, true);
  assert.equal((await store.read.packages.get(digest)).packageState, 'installed');
  assert.equal((await store.read.instances.get('pi_worker')).lifecycleRevision, 1);
});

test('legacy import is atomic, preserves original bytes, and never overwrites committed SQLite on restart', async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, '{invalid');
  const bad = f.open();
  await assert.rejects(bad.snapshot());
  await bad.close();
  const legacy = JSON.stringify({ schemaVersion: 1, packages: [], instances: [] });
  await writeFile(f.file, legacy);
  const imported = f.open();
  await imported.snapshot();
  const plane = new HostInventoryControlPlane(imported, { createInstanceId: () => 'pi_worker' });
  await plane.installPackage(candidate);
  assert.equal(await readFile(f.file, 'utf8'), legacy);
  await imported.close();
  await writeFile(f.file, '{obsolete');
  assert.equal((await f.open().readAuthority('pi_worker')).instance.pluginId, manifest.pluginId);
});

test('a lost commit reply is resolved from the durable outcome before deciding compensation', async (t) => {
  const f = await fixture(t);
  const { PluginStateClient } = await import('../dist/domains/plugin/state-worker/client.js');
  const client = new PluginStateClient();
  const store = new SqlitePluginInventoryStore(f.file, { client });
  t.after(() => store.close());
  await new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_worker' }).installPackage(candidate);
  const send = client.request.bind(client);
  let interrupt = true;
  client.request = (operation) => {
    if (operation.op === 'commit' && interrupt) {
      interrupt = false;
      const worker = client.worker;
      worker.removeAllListeners('message');
      worker.once('message', () => worker.terminate());
    }
    return send(operation);
  };
  let compensations = 0;
  let result;
  let error;
  try {
    result = await store.transaction(
      async (tx) => {
        const row = await tx.instances.get('pi_worker');
        await tx.instances.put({ ...row, activationState: 'enabled', configReadiness: 'ready' });
        return 'committed';
      },
      {
        onCommitFailure() {
          compensations++;
        },
      },
    );
  } catch (caught) {
    error = caught;
  }
  assert.equal(
    (await f.open().read.instances.get('pi_worker')).activationState,
    'enabled',
    'The dropped reply follows an actual durable commit',
  );
  assert.equal(compensations, 0, 'A successful durable commit must never run failed-commit compensation');
  assert.equal(result, 'committed', error?.message);
});

test('worker exit before commit rolls back and compensates without reviving the dead transaction', async (t) => {
  const f = await fixture(t);
  const { PluginStateClient } = await import('../dist/domains/plugin/state-worker/client.js');
  const client = new PluginStateClient();
  const store = new SqlitePluginInventoryStore(f.file, { client });
  t.after(() => store.close());
  await new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_worker' }).installPackage(candidate);
  const worker = client.worker;
  const post = worker.postMessage.bind(worker);
  worker.postMessage = (request) => {
    if (request.operation.op === 'commit') {
      void worker.terminate();
      return;
    }
    post(request);
  };
  let compensations = 0;
  await assert.rejects(
    store.transaction(
      async (tx) => {
        const row = await tx.instances.get('pi_worker');
        await tx.instances.put({ ...row, activationState: 'enabled' });
      },
      {
        onCommitFailure() {
          compensations++;
        },
      },
    ),
  );
  assert.equal(compensations, 1);
  assert.equal((await f.open().read.instances.get('pi_worker')).activationState, 'disabled');
});

test('retained JSON cannot become a stale reader or writer after SQLite owns the committed state', async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify({ schemaVersion: 1, packages: [], instances: [] }));
  const store = f.open();
  await new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_worker' }).installPackage(candidate);
  const { FilePluginInventoryStore } = await import('../dist/domains/plugin/host-inventory/stores.js');
  const legacy = new FilePluginInventoryStore(f.file);
  await assert.rejects(legacy.snapshot(), { code: 'INVENTORY_INVARIANT' });
  let entered = false;
  await assert.rejects(
    legacy.transaction(() => {
      entered = true;
    }),
    { code: 'INVENTORY_INVARIANT' },
  );
  assert.equal(entered, false);
  assert.equal((await store.read.instances.get('pi_worker')).pluginId, manifest.pluginId);
});

test('complete SQLite state can be exported for a quiescent rollback without losing package or instance history', async (t) => {
  const f = await fixture(t);
  const store = f.open();
  await new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_worker' }).installPackage(candidate);
  await store.transaction(async (tx) => {
    const i = await tx.instances.get('pi_worker');
    await tx.instances.put({ ...i, activationState: 'enabled', configReadiness: 'ready' });
  });
  const snapshot = await store.snapshot();
  const { serializeInventoryPackage } = await import('../dist/domains/plugin/host-inventory/stored-manifest.js');
  const exported = join(f.directory, 'rollback-inventory.json');
  await writeFile(
    exported,
    JSON.stringify({ ...snapshot, packages: snapshot.packages.map(serializeInventoryPackage) }),
    { mode: 0o600 },
  );
  const { FilePluginInventoryStore } = await import('../dist/domains/plugin/host-inventory/stores.js');
  assert.deepEqual(await new FilePluginInventoryStore(exported).snapshot(), snapshot);
});
