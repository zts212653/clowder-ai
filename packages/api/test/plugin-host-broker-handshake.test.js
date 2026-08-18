import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  HostBrokerControlPlane,
  HostBrokerError,
  MemoryHostBrokerStore,
} from '../dist/domains/plugin/host-broker/index.js';
import {
  candidateHello,
  INSTANCE_ID,
  PACKAGE_DIGEST,
  PLUGIN_ID,
  readyInventory,
} from './plugin-host-broker-helpers.js';

async function harness(options = {}) {
  let now = options.now ?? 5_000;
  const inventory = await readyInventory();
  const store = new MemoryHostBrokerStore();
  const broker = new HostBrokerControlPlane({
    inventory,
    store,
    now: () => now,
    createConnectionId: () => 'conn-1',
    createSessionId: () => 'bs-1',
    createRuntimeLeaseId: () => 'lease-1',
    createBindingNonce: () => 'nonce-1',
    preActiveTimeoutMs: 1_000,
    activeLeaseTtlMs: 10_000,
  });
  const connection = await broker.openBuiltinConnection(INSTANCE_ID);
  return { broker, connection, inventory, setNow: (value) => (now = value), store };
}

function isHandshakeError(reason) {
  return (error) => error instanceof HostBrokerError && error.code === 'HANDSHAKE_REJECTED' && error.reason === reason;
}

describe('K-2B Host Broker handshake', () => {
  it('binds candidate claims to Host inventory and activates a live runtime fence', async () => {
    const { connection, inventory, store } = await harness();

    const binding = await connection.hello(candidateHello());
    assert.deepEqual(binding, {
      pluginId: PLUGIN_ID,
      packageDigest: PACKAGE_DIGEST,
      contractVersion: '0.1.0',
      wireVersion: '0.1.0',
      pluginInstanceId: INSTANCE_ID,
      brokerSessionId: 'bs-1',
      grantRevision: 1,
      effectiveGrants: ['events.publish'],
      bindingNonce: 'nonce-1',
    });
    assert.equal(await connection.ready({ bindingNonce: binding.bindingNonce }), null);

    const snapshot = await store.snapshot();
    assert.equal(snapshot.sessions[0].phase, 'active');
    assert.equal(snapshot.runtimeLeases[0].state, 'live');
    assert.equal(snapshot.runtimeLeases[0].brokerSessionId, 'bs-1');
    const inventorySnapshot = await inventory.snapshot();
    assert.equal(inventorySnapshot.instances[0].runtimeState, 'healthy');
  });

  it('fails closed when candidate identity differs from the exact installed package', async () => {
    const { connection, inventory, store } = await harness();

    await assert.rejects(
      connection.hello(candidateHello({ packageDigest: `sha512-${'A'.repeat(86)}==` })),
      isHandshakeError('PACKAGE_MISMATCH'),
    );

    const snapshot = await store.snapshot();
    assert.equal(snapshot.sessions[0].phase, 'closed');
    assert.equal(snapshot.runtimeLeases.length, 0);
    assert.equal((await inventory.snapshot()).instances[0].runtimeState, 'stopped');
  });

  it('rejects authority injection, expired ready, and binding nonce replay', async () => {
    const injected = await harness();
    await assert.rejects(
      injected.connection.hello({ ...candidateHello(), pluginInstanceId: INSTANCE_ID }),
      isHandshakeError('AUTHORITY_VIOLATION'),
    );

    const expired = await harness();
    const expiredBinding = await expired.connection.hello(candidateHello());
    expired.setNow(6_001);
    await assert.rejects(
      expired.connection.ready({ bindingNonce: expiredBinding.bindingNonce }),
      isHandshakeError('DEADLINE_EXPIRED'),
    );

    const replay = await harness();
    const replayBinding = await replay.connection.hello(candidateHello());
    await replay.connection.ready({ bindingNonce: replayBinding.bindingNonce });
    await assert.rejects(
      replay.connection.ready({ bindingNonce: replayBinding.bindingNonce }),
      isHandshakeError('BINDING_REPLAY'),
    );
  });

  it('closes the old session on connection loss and never revives it', async () => {
    const { connection, inventory, store } = await harness();
    const binding = await connection.hello(candidateHello());
    await connection.ready({ bindingNonce: binding.bindingNonce });

    await connection.close('transport_lost');
    await connection.close('duplicate_close');

    const snapshot = await store.snapshot();
    assert.equal(snapshot.sessions[0].phase, 'closed');
    assert.equal(snapshot.runtimeLeases[0].state, 'closed');
    assert.equal((await inventory.snapshot()).instances[0].runtimeState, 'stopped');
  });

  it('renews only a live exact-authority runtime lease and never revives an expired lease', async () => {
    const { connection, setNow, store } = await harness();
    const binding = await connection.hello(candidateHello());
    await connection.ready({ bindingNonce: binding.bindingNonce });
    assert.equal((await store.snapshot()).runtimeLeases[0].expiresAt, 15_000);

    setNow(9_000);
    assert.equal(await connection.renewRuntimeLease(), 19_000);
    let snapshot = await store.snapshot();
    assert.equal(snapshot.sessions[0].activeLeaseExpiresAt, 19_000);
    assert.equal(snapshot.runtimeLeases[0].expiresAt, 19_000);

    setNow(19_000);
    await assert.rejects(
      connection.renewRuntimeLease(),
      (error) => error instanceof HostBrokerError && error.code === 'SESSION_NOT_ACTIVE',
    );
    snapshot = await store.snapshot();
    assert.equal(snapshot.sessions[0].phase, 'closed');
    assert.equal(snapshot.runtimeLeases[0].state, 'closed');
  });
});
