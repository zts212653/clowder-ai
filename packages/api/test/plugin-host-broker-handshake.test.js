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
  const inventory = await readyInventory(options.inventoryOptions);
  const store = options.store ?? new MemoryHostBrokerStore();
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

  it('treats reordered effective grants as the same Host authority', async () => {
    const { connection, inventory, store } = await harness({
      inventoryOptions: { effectiveGrants: ['events.publish', 'message.event.subscribe'] },
    });

    const binding = await connection.hello(candidateHello());
    await inventory.transaction((transaction) => {
      const grants = transaction.grants.get(INSTANCE_ID);
      transaction.grants.put({
        ...grants,
        effectiveGrants: ['message.event.subscribe', 'events.publish'],
      });
    });

    assert.equal(await connection.ready({ bindingNonce: binding.bindingNonce }), null);
    assert.equal((await store.snapshot()).sessions[0].phase, 'active');
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
      (error) =>
        error instanceof HostBrokerError &&
        error.code === 'SESSION_NOT_ACTIVE' &&
        error.sessionCloseReason === 'runtime_lease_expired',
    );
    snapshot = await store.snapshot();
    assert.equal(snapshot.sessions[0].phase, 'closed');
    assert.equal(snapshot.runtimeLeases[0].state, 'closed');
  });

  it('preserves an authority-change close reason on the heartbeat after the session closes', async () => {
    const { connection, inventory, store } = await harness();
    const binding = await connection.hello(candidateHello());
    await connection.ready({ bindingNonce: binding.bindingNonce });
    await inventory.transaction((transaction) => {
      const grants = transaction.grants.get(INSTANCE_ID);
      transaction.grants.put({ ...grants, grantRevision: grants.grantRevision + 1 });
    });

    await assert.rejects(
      connection.renewRuntimeLease(),
      (error) => error instanceof HostBrokerError && error.code === 'AUTHORITY_CHANGED',
    );
    await assert.rejects(
      connection.renewRuntimeLease(),
      (error) =>
        error instanceof HostBrokerError &&
        error.code === 'SESSION_NOT_ACTIVE' &&
        error.sessionCloseReason === 'authority_changed',
    );

    const snapshot = await store.snapshot();
    assert.equal(snapshot.sessions[0].phase, 'closed');
    assert.equal(snapshot.sessions[0].closeReason, 'authority_changed');
    assert.equal(snapshot.runtimeLeases[0].state, 'closed');
  });

  it('reports the persisted close reason when another close wins the heartbeat race', async () => {
    const delegate = new MemoryHostBrokerStore();
    let beforeSnapshotReturn;
    const store = {
      transaction: (work) => delegate.transaction(work),
      snapshot: async () => {
        const snapshot = await delegate.snapshot();
        const hook = beforeSnapshotReturn;
        beforeSnapshotReturn = undefined;
        if (hook) await hook();
        return snapshot;
      },
    };
    const { connection, setNow } = await harness({ store });
    const binding = await connection.hello(candidateHello());
    await connection.ready({ bindingNonce: binding.bindingNonce });
    setNow(15_000);
    beforeSnapshotReturn = () => connection.close('authority_changed');

    await assert.rejects(
      connection.renewRuntimeLease(),
      (error) =>
        error instanceof HostBrokerError &&
        error.code === 'SESSION_NOT_ACTIVE' &&
        error.sessionCloseReason === 'authority_changed',
    );

    const snapshot = await delegate.snapshot();
    assert.equal(snapshot.sessions[0].phase, 'closed');
    assert.equal(snapshot.sessions[0].closeReason, 'authority_changed');
    assert.equal(snapshot.runtimeLeases[0].state, 'closed');
  });

  for (const closeReason of ['runtime_lease_expired', 'authority_changed']) {
    it(`reports ${closeReason} when close wins after the heartbeat context read`, async () => {
      const delegate = new MemoryHostBrokerStore();
      let beforeTransaction;
      const store = {
        snapshot: () => delegate.snapshot(),
        transaction: async (work) => {
          const hook = beforeTransaction;
          beforeTransaction = undefined;
          if (hook) await hook();
          return delegate.transaction(work);
        },
      };
      const { connection } = await harness({ store });
      const binding = await connection.hello(candidateHello());
      await connection.ready({ bindingNonce: binding.bindingNonce });
      beforeTransaction = () => connection.close(closeReason);

      await assert.rejects(
        connection.renewRuntimeLease(),
        (error) =>
          error instanceof HostBrokerError &&
          error.code === 'SESSION_NOT_ACTIVE' &&
          error.sessionCloseReason === closeReason,
      );

      const snapshot = await delegate.snapshot();
      assert.equal(snapshot.sessions[0].phase, 'closed');
      assert.equal(snapshot.sessions[0].closeReason, closeReason);
      assert.equal(snapshot.runtimeLeases[0].state, 'closed');
    });
  }

  it('does not report lease expiry when the terminal close was not persisted', async () => {
    const delegate = new MemoryHostBrokerStore();
    let rejectNextTransaction = false;
    const store = {
      snapshot: () => delegate.snapshot(),
      transaction: (work) => {
        if (rejectNextTransaction) {
          rejectNextTransaction = false;
          throw new Error('simulated Broker store write failure');
        }
        return delegate.transaction(work);
      },
    };
    const { connection, setNow } = await harness({ store });
    const binding = await connection.hello(candidateHello());
    await connection.ready({ bindingNonce: binding.bindingNonce });
    setNow(15_000);
    rejectNextTransaction = true;

    await assert.rejects(
      connection.renewRuntimeLease(),
      (error) =>
        error instanceof HostBrokerError &&
        error.code === 'SESSION_NOT_ACTIVE' &&
        error.sessionCloseReason === 'session_not_active',
    );

    const snapshot = await delegate.snapshot();
    assert.equal(snapshot.sessions[0].phase, 'active');
    assert.equal(snapshot.sessions[0].closeReason, undefined);
    assert.equal(snapshot.runtimeLeases[0].state, 'live');
  });
});
