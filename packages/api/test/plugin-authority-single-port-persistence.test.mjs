// Each write port must persist independently to a new file-store reader.
// Mixing ports in one transaction would hide a missing write flag.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { FileHostBrokerStore, HostBrokerControlPlane } from '../dist/domains/plugin/host-broker/index.js';
import { emptyStaticFeatureLedger } from '../dist/domains/plugin/host-broker/static-feature-ledger.js';
import { FilePluginInventoryStore } from '../dist/domains/plugin/host-inventory/index.js';
import { candidateHello, INSTANCE_ID, messageSendReceipt, readyInventory } from './plugin-host-broker-helpers.js';

const tmp = (t, prefix) => {
  const root = mkdtempSync(join(os.tmpdir(), prefix));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

async function populatedBroker(path) {
  const inventory = await readyInventory();
  const store = new FileHostBrokerStore(path);
  const broker = new HostBrokerControlPlane({
    inventory,
    store,
    now: () => 5_000,
    createConnectionId: () => 'conn-guard',
    createSessionId: () => 'bs-guard',
    createRuntimeLeaseId: () => 'lease-guard',
    createBindingNonce: () => 'nonce-guard',
  });
  const connection = await broker.openBuiltinConnection(INSTANCE_ID);
  const binding = await connection.hello(candidateHello());
  await connection.ready({ bindingNonce: binding.bindingNonce });
  return store;
}

const call = () => ({
  ledgerKey: 'ledger-guard',
  brokerSessionId: 'bs-guard',
  runtimeLeaseId: 'lease-guard',
  pluginInstanceId: INSTANCE_ID,
  packageDigest: candidateHello().packageDigest,
  method: 'messaging.send',
  settlementKey: 'settlement-guard',
  inputDigest: 'digest-guard',
  phase: 'settled_success',
  revision: 2,
  result: messageSendReceipt('msg-guard'),
  createdAt: 5_000,
  updatedAt: 5_001,
});

describe('Broker: a write through exactly one port persists to a fresh reader', () => {
  it('sessions.put', async (t) => {
    const path = join(tmp(t, 'guard-broker-sessions-'), 'broker.json');
    const store = await populatedBroker(path);
    const before = (await new FileHostBrokerStore(path).snapshot()).sessions[0];
    await store.transaction((tx) => tx.sessions.put({ ...tx.sessions.list()[0], updatedAt: before.updatedAt + 1 }));
    assert.equal((await new FileHostBrokerStore(path).snapshot()).sessions[0].updatedAt, before.updatedAt + 1);
  });
  it('runtimeLeases.put', async (t) => {
    const path = join(tmp(t, 'guard-broker-leases-'), 'broker.json');
    const store = await populatedBroker(path);
    const before = (await new FileHostBrokerStore(path).snapshot()).runtimeLeases[0];
    await store.transaction((tx) =>
      tx.runtimeLeases.put({ ...tx.runtimeLeases.list()[0], updatedAt: before.updatedAt + 1 }),
    );
    assert.equal((await new FileHostBrokerStore(path).snapshot()).runtimeLeases[0].updatedAt, before.updatedAt + 1);
  });
  it('calls.put (the idempotency ledger; sole writer in settle/claim/begin transactions)', async (t) => {
    const path = join(tmp(t, 'guard-broker-calls-'), 'broker.json');
    const store = await populatedBroker(path);
    assert.deepEqual((await new FileHostBrokerStore(path).snapshot()).calls, [], 'precondition: no ledger yet');
    await store.transaction((tx) => tx.calls.put(call()));
    assert.deepEqual((await new FileHostBrokerStore(path).snapshot()).calls, [call()]);
  });
  it('staticFeatures.put', async (t) => {
    const path = join(tmp(t, 'guard-broker-features-'), 'broker.json');
    const store = await populatedBroker(path);
    assert.equal(
      (await new FileHostBrokerStore(path).snapshot()).staticFeatures,
      undefined,
      'precondition: no ledger yet',
    );
    await store.transaction((tx) => tx.staticFeatures.put(emptyStaticFeatureLedger()));
    assert.deepEqual((await new FileHostBrokerStore(path).snapshot()).staticFeatures, emptyStaticFeatureLedger());
  });
});

describe('Inventory: a write through exactly one port persists to a fresh reader', () => {
  for (const [port, collection, key] of [
    ['packages', 'packages', 'list'],
    ['instances', 'instances', 'list'],
  ]) {
    it(`${port}.put`, async (t) => {
      const path = join(tmp(t, `guard-inventory-${port}-`), 'inventory.json');
      const seed = await (await readyInventory()).snapshot();
      writeFileSync(path, JSON.stringify(seed));
      const original = seed[collection][0].updatedAt;
      await new FilePluginInventoryStore(path).transaction((tx) => {
        const record = tx[port][key]()[0];
        tx[port].put({ ...record, updatedAt: record.updatedAt + 1 });
      });
      assert.equal((await new FilePluginInventoryStore(path).snapshot())[collection][0].updatedAt, original + 1);
    });
  }
});
