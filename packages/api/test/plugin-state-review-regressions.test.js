import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { HostBrokerControlPlane } from '../dist/domains/plugin/host-broker/control-plane.js';
import { MemoryHostBrokerStore } from '../dist/domains/plugin/host-broker/stores.js';
import { HostInventoryControlPlane } from '../dist/domains/plugin/host-inventory/control-plane.js';
import { PluginStateClient } from '../dist/domains/plugin/state-worker/client.js';
import { SqliteHostBrokerStore, SqlitePluginInventoryStore } from '../dist/domains/plugin/state-worker/stores.js';
import { mountInventoryReader } from '../dist/scripts/github-approved-source/mount-existing-mcp.js';
import { fixture, manifest } from './helpers/plugin-state-worker-fixture.js';
import { candidateHello, INSTANCE_ID, readyInventory } from './plugin-host-broker-helpers.js';

test('lost open-connection commit reply returns its sole committed connection and can finish the handshake', async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify(await (await readyInventory()).snapshot()));
  const inventory = f.open();
  const client = new PluginStateClient();
  const path = join(f.directory, 'broker.json');
  const store = new SqliteHostBrokerStore(path, client);
  t.after(() => client.close());
  await store.initialize();
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
  const broker = new HostBrokerControlPlane({ inventory, store, now: () => 5000 });
  let connection;
  let failure;
  try {
    connection = await broker.openBuiltinConnection(INSTANCE_ID);
  } catch (error) {
    failure = error;
  }
  const sessions = await store.read.sessions.list(INSTANCE_ID);
  assert.equal(sessions.length, 1, 'The lost reply follows a real committed session, never a replay');
  assert.equal(sessions[0].phase, 'transport_connected');
  assert.ok(connection, failure?.message);
  assert.equal(connection.connectionId, sessions[0].connectionId);
  const binding = await connection.hello(candidateHello());
  await connection.ready({ bindingNonce: binding.bindingNonce });
  await broker.authorizeHostCall(INSTANCE_ID);
  await assert.rejects(broker.openBuiltinConnection(INSTANCE_ID), { code: 'INSTANCE_NOT_READY' });
  await connection.renewRuntimeLease();
  assert.equal((await store.read.sessions.list(INSTANCE_ID)).length, 1);
  const database = new Database(`${path}.state.sqlite`, { readonly: true });
  try {
    assert.equal(database.prepare('SELECT count(*) AS count FROM committed_transactions').get().count, 1);
  } finally {
    database.close();
  }
  await connection.close();
});

async function inventoryFiles(directory) {
  return Promise.all(
    (await readdir(directory)).sort().map(async (name) => ({
      name,
      sha256: createHash('sha256')
        .update(await readFile(join(directory, name)))
        .digest('hex'),
    })),
  );
}

test('mount dry inspection does not migrate a legacy source or create inventory sidecars', async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify({ schemaVersion: 1, packages: [], instances: [] }));
  const before = await inventoryFiles(f.directory);
  const reader = mountInventoryReader(f.file);
  try {
    assert.deepEqual(await reader.snapshot(), { schemaVersion: 1, packages: [], instances: [] });
  } finally {
    await reader.close?.();
  }
  assert.deepEqual(
    await inventoryFiles(f.directory),
    before,
    'A dry read must leave every filename and byte unchanged',
  );
});

test('historical mount inspection refuses an existing SQLite owner without changing its files', async (t) => {
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify({ schemaVersion: 1, packages: [], instances: [] }));
  const owner = f.open();
  await owner.initialize();
  await owner.close();
  const before = await inventoryFiles(f.directory);
  const reader = mountInventoryReader(f.file);
  try {
    await assert.rejects(reader.snapshot(), { code: 'INVENTORY_INVARIANT' });
  } finally {
    await reader.close?.();
  }
  assert.deepEqual(await inventoryFiles(f.directory), before);
});

test('data-directory admission reads current instances without transferring retired history', async (t) => {
  const f = await fixture(t);
  const snapshot = await (await readyInventory()).snapshot();
  snapshot.packages[0].manifest.runtime = { ...snapshot.packages[0].manifest.runtime, dataDirectory: 'occupied' };
  snapshot.instances.push(
    ...Array.from({ length: 70 }, (_, index) => ({
      ...snapshot.instances[0],
      pluginInstanceId: `pi_retired_${index}`,
      lifecycleState: 'retired',
      retiredAt: 1000,
    })),
  );
  await writeFile(f.file, JSON.stringify(snapshot));
  const client = new PluginStateClient();
  const inventory = new SqlitePluginInventoryStore(f.file, { client });
  t.after(() => client.close());
  await inventory.initialize();
  const send = client.request.bind(client);
  const queries = [];
  let retiredRows = 0;
  client.request = async (operation) => {
    const result = await send(operation);
    if (operation.op === 'list' && operation.query.entity === 'instance') {
      queries.push(operation.query);
      retiredRows += result.records.filter((row) => row.lifecycleState === 'retired').length;
    }
    return result;
  };
  let sequence = 0;
  const plane = new HostInventoryControlPlane(inventory, { createInstanceId: () => `pi_new_${++sequence}` });
  const candidate = (pluginId, dataDirectory) => {
    const digest = `sha512-${createHash('sha512').update(pluginId).digest('base64')}`;
    return {
      manifest: { ...manifest, pluginId, runtime: { transport: 'builtin', dataDirectory } },
      computedPackageDigest: digest,
      expectedPackageDigest: digest,
      packagePluginId: pluginId,
    };
  };
  await plane.installPackage(candidate('dev.clowder.new', 'vacant'));
  await assert.rejects(plane.installPackage(candidate('dev.clowder.collision', 'occupied')), {
    code: 'DATA_DIRECTORY_IN_USE',
  });
  assert.equal(retiredRows, 0, 'Current directory checks must not receive retired rows');
  assert.ok(queries.length > 0);
  assert.ok(queries.every((query) => query.phase === 'installed'));
});

test('connection admission and restart do not transfer closed session or lease history', async (t) => {
  const f = await fixture(t);
  const legacyInventory = await readyInventory();
  const legacyBroker = new MemoryHostBrokerStore();
  const oldPlane = new HostBrokerControlPlane({ inventory: legacyInventory, store: legacyBroker, now: () => 5000 });
  const old = await oldPlane.openBuiltinConnection(INSTANCE_ID);
  const binding = await old.hello(candidateHello());
  await old.ready({ bindingNonce: binding.bindingNonce });
  await old.close();
  const snapshot = await legacyBroker.snapshot();
  const session = snapshot.sessions[0];
  const lease = snapshot.runtimeLeases[0];
  for (let index = 0; index < 70; index++) {
    const brokerSessionId = `bs_history_${index}`;
    const runtimeLeaseId = `lease_history_${index}`;
    snapshot.sessions.push({ ...session, connectionId: `conn_history_${index}`, brokerSessionId, runtimeLeaseId });
    snapshot.runtimeLeases.push({ ...lease, brokerSessionId, runtimeLeaseId });
  }
  await writeFile(f.file, JSON.stringify(await legacyInventory.snapshot()));
  const path = join(f.directory, 'broker.json');
  await writeFile(path, JSON.stringify(snapshot));
  const inventory = f.open();
  const client = new PluginStateClient();
  const store = new SqliteHostBrokerStore(path, client);
  t.after(() => client.close());
  await store.initialize();
  const send = client.request.bind(client);
  let closedRows = 0;
  client.request = async (operation) => {
    const result = await send(operation);
    if (operation.op === 'list' && ['session', 'lease'].includes(operation.query.entity)) {
      closedRows += result.records.filter((row) => row.phase === 'closed' || row.state === 'closed').length;
    }
    return result;
  };
  const broker = new HostBrokerControlPlane({ inventory, store, now: () => 5000 });
  const current = await broker.openBuiltinConnection(INSTANCE_ID);
  const currentBinding = await current.hello(candidateHello());
  await current.ready({ bindingNonce: currentBinding.bindingNonce });
  assert.equal(await broker.recoverAfterRestart(), 1);
  assert.equal(closedRows, 0, 'Current connection and recovery reads must exclude closed history in SQLite');
});
