import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { HostBrokerControlPlane } from '../dist/domains/plugin/host-broker/control-plane.js';
import { HostInventoryControlPlane } from '../dist/domains/plugin/host-inventory/control-plane.js';
import { SqliteHostBrokerStore, SqlitePluginInventoryStore } from '../dist/domains/plugin/state-worker/stores.js';

import { candidate, digest, fixture, manifest } from './helpers/plugin-state-worker-fixture.js';

test('current authority reflects revocation without scanning broker call history', async (t) => {
  const f = await fixture(t);
  const inventory = f.open();
  const plane = new HostInventoryControlPlane(inventory, { createInstanceId: () => 'pi_worker' });
  await plane.installPackage(candidate);
  await inventory.transaction(async (tx) => {
    const i = await tx.instances.get('pi_worker');
    await tx.instances.put({ ...i, activationState: 'enabled', configReadiness: 'ready' });
  });
  const brokerStore = new SqliteHostBrokerStore(join(f.directory, 'broker.json'));
  t.after(() => brokerStore.close());
  const broker = new HostBrokerControlPlane({ inventory, store: brokerStore });
  brokerStore.snapshot = () => {
    throw new Error('Authority must not export call history');
  };
  inventory.snapshot = () => {
    throw new Error('Authority must not export package history');
  };
  await broker.authorizeHostDelivery('pi_worker');
  await inventory.transaction(async (tx) => {
    const i = await tx.instances.get('pi_worker');
    await tx.instances.put({ ...i, activationState: 'disabled' });
  });
  await assert.rejects(broker.authorizeHostDelivery('pi_worker'), { code: 'INSTANCE_NOT_READY' });
});

test('SQLite broker settles once, restores current state after restart, and does not scan calls during authorization', async (t) => {
  const { readyInventory, INSTANCE_ID, candidateHello, messageSendInput, messageSendReceipt } = await import(
    './plugin-host-broker-helpers.js'
  );
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify(await (await readyInventory()).snapshot()));
  const inventory = f.open();
  const path = join(f.directory, 'broker.json');
  let store = new SqliteHostBrokerStore(path);
  t.after(() => store.close());
  let effects = 0;
  let settled = null;
  const handler = {
    method: 'messaging.send',
    validateInput: (value) => ({ valid: true, value }),
    validateResult: (value) => value?.messageId === 'worker-message',
    settlementKey: (_context, input) => input.idempotencyKey,
    dispatch: async () => {
      effects++;
      settled = messageSendReceipt('worker-message');
      return settled;
    },
    lookupSettlement: async () => settled,
    serializePreEffectError: () => null,
    restoreSettledError: (e) => new Error(e.message),
  };
  let broker = new HostBrokerControlPlane({ inventory, store, methods: [handler], now: () => 5000 });
  const connect = async () => {
    const c = await broker.openBuiltinConnection(INSTANCE_ID);
    const binding = await c.hello(candidateHello());
    await c.ready({ bindingNonce: binding.bindingNonce });
    return c;
  };
  let connection = await connect();
  store.snapshot = () => {
    throw new Error('No full broker snapshot on this path');
  };
  inventory.snapshot = () => {
    throw new Error('No full inventory snapshot on this path');
  };
  assert.equal((await connection.call('messaging.send', messageSendInput())).messageId, 'worker-message');
  assert.equal((await connection.call('messaging.send', messageSendInput())).messageId, 'worker-message');
  assert.equal(effects, 1);
  await broker.authorizeHostCall(INSTANCE_ID);
  await connection.renewRuntimeLease();
  await store.close();
  store = new SqliteHostBrokerStore(path);
  broker = new HostBrokerControlPlane({ inventory, store, methods: [handler], now: () => 5000 });
  assert.equal(await broker.recoverAfterRestart(), 1);
  connection = await connect();
  assert.equal((await connection.call('messaging.send', messageSendInput())).messageId, 'worker-message');
  assert.equal(effects, 1, 'A restart must not repeat an already settled effect');
  await inventory.transaction(async (tx) => {
    const i = await tx.instances.get(INSTANCE_ID);
    await tx.instances.put({ ...i, activationState: 'disabled' });
  });
  await assert.rejects(connection.call('messaging.send', messageSendInput()), { code: 'AUTHORITY_CHANGED' });
  const exported = await store.snapshot();
  const rollback = join(f.directory, 'rollback-broker.json');
  await writeFile(rollback, JSON.stringify(exported), { mode: 0o600 });
  const { FileHostBrokerStore } = await import('../dist/domains/plugin/host-broker/stores.js');
  assert.deepEqual(
    await new FileHostBrokerStore(rollback).snapshot(),
    exported,
    'Rollback retains sessions, leases and settled calls',
  );
});

test('unversioned custom rules stay fresh and actual manifest bytes invalidate reuse despite the same claimed digest', async (t) => {
  const f = await fixture(t);
  let allowed = true;
  const { DEFAULT_PLUGIN_CONTRACT_RUNTIME } = await import('../dist/domains/plugin/host-inventory/contract-policy.js');
  const store = new SqlitePluginInventoryStore(f.file, {
    contract: {
      ...DEFAULT_PLUGIN_CONTRACT_RUNTIME,
      validateManifest: (value) =>
        allowed ? DEFAULT_PLUGIN_CONTRACT_RUNTIME.validateManifest(value) : { valid: false, errors: [] },
    },
  });
  t.after(() => store.close());
  await new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_worker' }).installPackage(candidate);
  const brokerStore = new SqliteHostBrokerStore(join(f.directory, 'broker.json'));
  t.after(() => brokerStore.close());
  const broker = new HostBrokerControlPlane({ inventory: store, store: brokerStore });
  await store.transaction(async (tx) => {
    const i = await tx.instances.get('pi_worker');
    await tx.instances.put({ ...i, activationState: 'enabled', configReadiness: 'ready' });
  });
  await broker.authorizeHostDelivery('pi_worker');
  allowed = false;
  await assert.rejects(broker.authorizeHostDelivery('pi_worker'), { code: 'INSTANCE_NOT_READY' });
  allowed = true;
  await broker.authorizeHostDelivery('pi_worker');
  await store.transaction(async (tx) => {
    const p = await tx.packages.get(digest);
    await tx.packages.put({ ...p, manifest: { ...p.manifest, name: 'Changed actual bytes' } });
  });
  assert.equal((await store.readAuthority('pi_worker')).packageRecord.manifest.name, 'Changed actual bytes');
});

test('SQLite feature effects keep revocation ordered while ordinary committed reads stay available', async (t) => {
  const { readyInventory, INSTANCE_ID, candidateHello } = await import('./plugin-host-broker-helpers.js');
  const { StaticFeatureAuthority } = await import('../dist/domains/plugin/host-broker/static-feature-authority.js');
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify(await (await readyInventory()).snapshot()));
  const inventory = f.open();
  const store = new SqliteHostBrokerStore(join(f.directory, 'broker.json'));
  t.after(() => store.close());
  const broker = new HostBrokerControlPlane({ inventory, store, now: () => 5000 });
  const connection = await broker.openBuiltinConnection(INSTANCE_ID);
  const binding = await connection.hello(candidateHello());
  await connection.ready({ bindingNonce: binding.bindingNonce });
  const features = new StaticFeatureAuthority({
    inventory,
    store,
    broker,
    now: () => 5000,
    verifyActivePackage: async () => {},
  });
  const lease = await features.begin(INSTANCE_ID, 'source');
  await features.commit(lease.executionLease);
  let entered;
  let release;
  const inside = new Promise((done) => {
    entered = done;
  });
  const gate = new Promise((done) => {
    release = done;
  });
  let effects = 0;
  const effect = features.run(lease.executionLease, async () => {
    entered();
    await gate;
    effects++;
  });
  await inside;
  let revoked = false;
  const revocation = features.setDesired(INSTANCE_ID, 'source', false).then(() => {
    revoked = true;
  });
  assert.equal((await inventory.readAuthority(INSTANCE_ID)).instance.pluginInstanceId, INSTANCE_ID);
  assert.equal(revoked, false, 'Revocation cannot pass an admitted effect');
  release();
  await effect;
  await revocation;
  await assert.rejects(
    features.run(lease.executionLease, async () => {
      effects++;
    }),
    { code: 'AUTHORITY_CHANGED' },
  );
  assert.equal(effects, 1);
});

test('configuration persistence awaits an asynchronous final fence before writing', async (t) => {
  const f = await fixture(t);
  const store = f.open();
  const { configureTransaction } = await import('../dist/domains/plugin/manager/plugin-configuration-write.js');
  const { readPluginConfig, writePluginConfig } = await import('../dist/domains/plugin/plugin-config-store.js');
  const configured = {
    ...manifest,
    configuration: [{ key: 'token', kind: 'string', label: 'Token', required: false }],
  };
  await new HostInventoryControlPlane(store, { createInstanceId: () => 'pi_worker' }).installPackage({
    ...candidate,
    manifest: configured,
  });
  writePluginConfig(f.directory, manifest.pluginId, [{ name: 'token', value: 'before' }]);
  let entered;
  let release;
  const inside = new Promise((done) => {
    entered = done;
  });
  const gate = new Promise((done) => {
    release = done;
  });
  const save = store.transaction((tx) =>
    configureTransaction({
      transaction: tx,
      projectRoot: f.directory,
      pluginId: manifest.pluginId,
      pluginInstanceId: 'pi_worker',
      request: { expectedRevision: 1, updates: [{ key: 'token', value: 'after' }] },
      now: 1000,
      beforeWrite: async () => {
        entered();
        await gate;
      },
    }),
  );
  await inside;
  assert.equal(
    readPluginConfig(f.directory, manifest.pluginId).token,
    'before',
    'The final fence must settle before the external write',
  );
  release();
  await save;
  assert.equal(readPluginConfig(f.directory, manifest.pluginId).token, 'after');
});

test('static feature lifecycle never requests a complete feature history ledger', async (t) => {
  const { readyInventory, INSTANCE_ID, candidateHello } = await import('./plugin-host-broker-helpers.js');
  const { StaticFeatureAuthority } = await import('../dist/domains/plugin/host-broker/static-feature-authority.js');
  const { PluginStateClient } = await import('../dist/domains/plugin/state-worker/client.js');
  const f = await fixture(t);
  await writeFile(f.file, JSON.stringify(await (await readyInventory()).snapshot()));
  const client = new PluginStateClient();
  const inventory = new SqlitePluginInventoryStore(f.file, { client });
  const store = new SqliteHostBrokerStore(join(f.directory, 'broker.json'), client);
  t.after(() => client.close());
  let historyReads = 0;
  let historyRewrites = 0;
  const request = client.request.bind(client);
  client.request = (operation) => {
    if (operation.op === 'features' && !operation.activeOnly) historyReads++;
    if (operation.op === 'putFeatures' && !operation.updateOnly) historyRewrites++;
    return request(operation);
  };
  const broker = new HostBrokerControlPlane({ inventory, store, now: () => 5000 });
  const connection = await broker.openBuiltinConnection(INSTANCE_ID);
  const binding = await connection.hello(candidateHello());
  await connection.ready({ bindingNonce: binding.bindingNonce });
  const features = new StaticFeatureAuthority({
    inventory,
    store,
    broker,
    now: () => 5000,
    verifyActivePackage: async () => {},
  });
  const lease = await features.begin(INSTANCE_ID, 'source');
  await features.commit(lease.executionLease);
  await features.run(lease.executionLease, async () => {});
  await features.setDesired(INSTANCE_ID, 'source', false);
  await features.setDesired(INSTANCE_ID, 'source', true);
  const next = await features.begin(INSTANCE_ID, 'source');
  assert.equal(next.activationRevision, lease.activationRevision + 1);
  assert.equal(next.integrityEpoch, lease.integrityEpoch);
  await features.commit(next.executionLease);
  await connection.close();
  const recovered = await broker.openBuiltinConnection(INSTANCE_ID);
  const recoveredBinding = await recovered.hello(candidateHello());
  await recovered.ready({ bindingNonce: recoveredBinding.bindingNonce });
  const afterRestart = await features.begin(INSTANCE_ID, 'source');
  assert.equal(afterRestart.activationRevision, next.activationRevision + 1);
  assert.equal(afterRestart.integrityEpoch, next.integrityEpoch + 1);
  await features.commit(afterRestart.executionLease);
  await recovered.close();
  assert.equal(historyRewrites, 0, 'Current feature changes must preserve historical records by key');
  assert.equal(historyReads, 0, 'Current feature operations must not transfer the historical ledger');
});
