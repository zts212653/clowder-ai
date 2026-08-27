import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  digestBrokerValue,
  HostBrokerControlPlane,
  HostBrokerError,
  MemoryHostBrokerStore,
} from '../dist/domains/plugin/host-broker/index.js';
import { candidateHello, eventsPublishInput, INSTANCE_ID, readyInventory } from './plugin-host-broker-helpers.js';

function isBrokerError(code) {
  return (error) => error instanceof HostBrokerError && error.code === code;
}

function fakeEventsHandler(overrides = {}) {
  let dispatchCount = 0;
  const settlements = new Map();
  return {
    method: 'events.publish',
    validateInput: (value) =>
      value &&
      typeof value === 'object' &&
      typeof value.signalType === 'string' &&
      typeof value.idempotencyKey === 'string'
        ? { valid: true, value: structuredClone(value) }
        : { valid: false },
    validateResult: (value) =>
      value &&
      typeof value === 'object' &&
      typeof value.publicationId === 'string' &&
      (value.disposition === 'accepted' || value.disposition === 'duplicate'),
    settlementKey: (context, input) =>
      `${context.pluginInstanceId}\u0000${input.signalType}\u0000${input.idempotencyKey}`,
    dispatch: async (context, input) => {
      dispatchCount += 1;
      if (overrides.dispatch) return overrides.dispatch({ context, input, settlements });
      const result = { publicationId: `pub-${input.idempotencyKey}`, disposition: 'accepted' };
      settlements.set(`${context.pluginInstanceId}\u0000${input.signalType}\u0000${input.idempotencyKey}`, result);
      return result;
    },
    lookupSettlement: async (context, input) =>
      structuredClone(
        settlements.get(`${context.pluginInstanceId}\u0000${input.signalType}\u0000${input.idempotencyKey}`) ?? null,
      ),
    serializePreEffectError: () => null,
    restoreSettledError: (error) => Object.assign(new Error(error.message), { code: error.code }),
    dispatchCount: () => dispatchCount,
    settlements,
  };
}

async function activeHarness(handler, options = {}) {
  let now = options.now ?? 5_000;
  const inventory = await readyInventory(
    options.effectiveGrants === undefined ? {} : { effectiveGrants: options.effectiveGrants },
  );
  const store = options.store ?? new MemoryHostBrokerStore();
  const broker = new HostBrokerControlPlane({
    inventory,
    store,
    methods: [handler],
    now: () => now,
    createConnectionId: () => 'conn-ledger',
    createSessionId: () => 'bs-ledger',
    createRuntimeLeaseId: () => 'lease-ledger',
    createBindingNonce: () => 'nonce-ledger',
    activeLeaseTtlMs: 10_000,
  });
  const connection = await broker.openBuiltinConnection(INSTANCE_ID);
  const binding = await connection.hello(candidateHello());
  await connection.ready({ bindingNonce: binding.bindingNonce });
  return { broker, connection, inventory, setNow: (value) => (now = value), store };
}

describe('K-2B durable Broker call ledger', () => {
  it('rejects ready-but-unregistered and handshake rows before any durable claim', async () => {
    const handler = fakeEventsHandler();
    const { connection, store } = await activeHarness(handler);

    await assert.rejects(connection.call('messaging.send', {}), isBrokerError('METHOD_NOT_REGISTERED'));
    await assert.rejects(connection.call('broker.hello', {}), isBrokerError('METHOD_NOT_REGISTERED'));
    assert.equal((await store.snapshot()).calls.length, 0);
    assert.equal(handler.dispatchCount(), 0);
  });

  it('dispatches exactly once under concurrent same-key calls and replays the terminal receipt', async () => {
    let releaseDispatch;
    const blocked = new Promise((resolve) => {
      releaseDispatch = resolve;
    });
    const handler = fakeEventsHandler({
      dispatch: async ({ context, input, settlements }) => {
        await blocked;
        const result = { publicationId: 'pub-concurrent', disposition: 'accepted' };
        settlements.set(`${context.pluginInstanceId}\u0000${input.signalType}\u0000${input.idempotencyKey}`, result);
        return result;
      },
    });
    const { connection, store } = await activeHarness(handler);
    const input = eventsPublishInput({ idempotencyKey: 'concurrent' });

    const first = connection.call('events.publish', input);
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(connection.call('events.publish', input), isBrokerError('CALL_IN_FLIGHT'));
    releaseDispatch();
    const result = await first;

    assert.deepEqual(result, { publicationId: 'pub-concurrent', disposition: 'accepted' });
    assert.deepEqual(await connection.call('events.publish', input), result);
    assert.equal(handler.dispatchCount(), 1);
    assert.equal((await store.snapshot()).calls[0].phase, 'settled_success');
  });

  it('binds a settlement key to one canonical input digest', async () => {
    const handler = fakeEventsHandler();
    const { connection } = await activeHarness(handler);
    const first = eventsPublishInput({ idempotencyKey: 'same-key', payload: { version: 1 } });
    const conflicting = eventsPublishInput({ idempotencyKey: 'same-key', payload: { version: 2 } });

    await connection.call('events.publish', first);
    await assert.rejects(connection.call('events.publish', conflicting), isBrokerError('CALL_CONFLICT'));
    assert.equal(handler.dispatchCount(), 1);
  });

  it('recovers a dispatched call from the domain settlement without blind redispatch', async () => {
    let failAfterSettlement = true;
    const handler = fakeEventsHandler({
      dispatch: async ({ context, input, settlements }) => {
        const key = `${context.pluginInstanceId}\u0000${input.signalType}\u0000${input.idempotencyKey}`;
        const result = { publicationId: 'pub-recovered', disposition: 'accepted' };
        settlements.set(key, result);
        if (failAfterSettlement) {
          failAfterSettlement = false;
          throw new Error('simulated transport loss after durable domain settlement');
        }
        return result;
      },
    });
    const { connection, store } = await activeHarness(handler);
    const input = eventsPublishInput({ idempotencyKey: 'recover-me' });

    await assert.rejects(connection.call('events.publish', input), /simulated transport loss/);
    assert.equal((await store.snapshot()).calls[0].phase, 'dispatched');

    assert.deepEqual(await connection.call('events.publish', input), {
      publicationId: 'pub-recovered',
      disposition: 'accepted',
    });
    assert.equal(handler.dispatchCount(), 1);
    assert.equal((await store.snapshot()).calls[0].phase, 'settled_success');
  });

  it('lets one exact retry acquire an abandoned durable claim before dispatch', async () => {
    const handler = fakeEventsHandler();
    const { connection, store } = await activeHarness(handler);
    const input = eventsPublishInput({ idempotencyKey: 'abandoned-claim' });
    const settlementKey = `${INSTANCE_ID}\u0000${input.signalType}\u0000${input.idempotencyKey}`;
    const ledgerKey = digestBrokerValue([INSTANCE_ID, 'events.publish', settlementKey]);
    const [session] = (await store.snapshot()).sessions;
    await store.transaction((transaction) => {
      transaction.calls.put({
        ledgerKey,
        brokerSessionId: session.brokerSessionId,
        runtimeLeaseId: session.runtimeLeaseId,
        pluginInstanceId: INSTANCE_ID,
        packageDigest: session.packageDigest,
        grantRevision: session.grantRevision,
        method: 'events.publish',
        settlementKey,
        inputDigest: digestBrokerValue(input),
        phase: 'claimed',
        revision: 1,
        createdAt: 5_000,
        updatedAt: 5_000,
      });
    });

    assert.deepEqual(await connection.call('events.publish', input), {
      publicationId: 'pub-abandoned-claim',
      disposition: 'accepted',
    });
    assert.equal(handler.dispatchCount(), 1);
    const [call] = (await store.snapshot()).calls;
    assert.equal(call.phase, 'settled_success');
    assert.equal(call.revision, 3);
  });

  it('rechecks grants and runtime expiry on every call', async () => {
    const revokedHandler = fakeEventsHandler();
    const revoked = await activeHarness(revokedHandler);
    await revoked.inventory.transaction((transaction) => {
      const grant = transaction.grants.get(INSTANCE_ID);
      transaction.grants.put({ ...grant, grantRevision: grant.grantRevision + 1, effectiveGrants: [] });
    });
    await assert.rejects(
      revoked.connection.call('events.publish', eventsPublishInput()),
      isBrokerError('AUTHORITY_CHANGED'),
    );
    assert.equal(revokedHandler.dispatchCount(), 0);

    const expiredHandler = fakeEventsHandler();
    const expired = await activeHarness(expiredHandler);
    expired.setNow(15_001);
    await assert.rejects(
      expired.connection.call('events.publish', eventsPublishInput()),
      isBrokerError('SESSION_NOT_ACTIVE'),
    );
    assert.equal(expiredHandler.dispatchCount(), 0);
  });

  it('rejects a capability absent at handshake without misclassifying authority drift', async () => {
    const handler = fakeEventsHandler();
    const { connection, store } = await activeHarness(handler, { effectiveGrants: [] });

    await assert.rejects(connection.call('events.publish', eventsPublishInput()), isBrokerError('CAPABILITY_DENIED'));
    assert.equal(handler.dispatchCount(), 0);
    assert.equal((await store.snapshot()).sessions[0].phase, 'active');
  });

  it('admits an owner-requested historical signal only through the exact active runtime ledger', async () => {
    const handler = fakeEventsHandler();
    const { broker, connection, store } = await activeHarness(handler);
    const input = eventsPublishInput({ idempotencyKey: 'owner-history' });

    const accepted = await broker.publishOwnerImportedSignal(INSTANCE_ID, input);
    const replay = await broker.publishOwnerImportedSignal(INSTANCE_ID, input);
    assert.deepEqual(accepted, { publicationId: 'pub-owner-history', disposition: 'accepted' });
    assert.deepEqual(replay, accepted);
    assert.equal(handler.dispatchCount(), 1);
    assert.equal((await store.snapshot()).calls[0].phase, 'settled_success');

    await connection.close('owner-history-test');
    await assert.rejects(
      broker.publishOwnerImportedSignal(INSTANCE_ID, eventsPublishInput({ idempotencyKey: 'after-close' })),
      isBrokerError('INSTANCE_NOT_READY'),
    );
    assert.equal(handler.dispatchCount(), 1);
  });
});
