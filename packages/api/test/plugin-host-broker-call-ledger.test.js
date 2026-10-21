import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  digestBrokerValue,
  HostBrokerControlPlane,
  HostBrokerError,
  MemoryHostBrokerStore,
} from '../dist/domains/plugin/host-broker/index.js';
import {
  candidateHello,
  INSTANCE_ID,
  messageSendInput,
  messageSendReceipt,
  readyInventory,
} from './plugin-host-broker-helpers.js';

function isBrokerError(code) {
  return (error) => error instanceof HostBrokerError && error.code === code;
}

function fakeMessageHandler(overrides = {}) {
  let dispatchCount = 0;
  const settlements = new Map();
  return {
    method: 'messaging.send',
    validateInput: (value) =>
      value &&
      typeof value === 'object' &&
      typeof value.address?.handle === 'string' &&
      typeof value.idempotencyKey === 'string'
        ? { valid: true, value: structuredClone(value) }
        : { valid: false },
    validateResult: (value) =>
      value && typeof value === 'object' && typeof value.messageId === 'string' && value.revision === 1,
    settlementKey: (context, input) =>
      `${context.pluginInstanceId}\u0000${input.address.handle}\u0000${input.idempotencyKey}`,
    dispatch: async (context, input) => {
      dispatchCount += 1;
      if (overrides.dispatch) return overrides.dispatch({ context, input, settlements });
      const result = messageSendReceipt(`pub-${input.idempotencyKey}`);
      settlements.set(`${context.pluginInstanceId}\u0000${input.address.handle}\u0000${input.idempotencyKey}`, result);
      return result;
    },
    lookupSettlement: async (context, input) =>
      structuredClone(
        settlements.get(`${context.pluginInstanceId}\u0000${input.address.handle}\u0000${input.idempotencyKey}`) ??
          null,
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
    const handler = fakeMessageHandler();
    const { connection, store } = await activeHarness(handler);

    await assert.rejects(connection.call('messaging.subscribe', {}), isBrokerError('METHOD_NOT_REGISTERED'));
    await assert.rejects(connection.call('broker.hello', {}), isBrokerError('METHOD_NOT_REGISTERED'));
    assert.equal((await store.snapshot()).calls.length, 0);
    assert.equal(handler.dispatchCount(), 0);
  });

  it('dispatches exactly once under concurrent same-key calls and replays the terminal receipt', async () => {
    let releaseDispatch;
    const blocked = new Promise((resolve) => {
      releaseDispatch = resolve;
    });
    const handler = fakeMessageHandler({
      dispatch: async ({ context, input, settlements }) => {
        await blocked;
        const result = messageSendReceipt('pub-concurrent');
        settlements.set(
          `${context.pluginInstanceId}\u0000${input.address.handle}\u0000${input.idempotencyKey}`,
          result,
        );
        return result;
      },
    });
    const { connection, store } = await activeHarness(handler);
    const input = messageSendInput({ idempotencyKey: 'concurrent' });

    const first = connection.call('messaging.send', input);
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(connection.call('messaging.send', input), isBrokerError('CALL_IN_FLIGHT'));
    releaseDispatch();
    const result = await first;

    assert.deepEqual(result, messageSendReceipt('pub-concurrent'));
    assert.deepEqual(await connection.call('messaging.send', input), result);
    assert.equal(handler.dispatchCount(), 1);
    assert.equal((await store.snapshot()).calls[0].phase, 'settled_success');
  });

  it('binds a settlement key to one canonical input digest', async () => {
    const handler = fakeMessageHandler();
    const { connection } = await activeHarness(handler);
    const first = messageSendInput({ idempotencyKey: 'same-key', sourceEventId: 'version-1' });
    const conflicting = messageSendInput({ idempotencyKey: 'same-key', sourceEventId: 'version-2' });

    await connection.call('messaging.send', first);
    await assert.rejects(connection.call('messaging.send', conflicting), isBrokerError('CALL_CONFLICT'));
    assert.equal(handler.dispatchCount(), 1);
  });

  it('recovers a dispatched call from the domain settlement without blind redispatch', async () => {
    let failAfterSettlement = true;
    const handler = fakeMessageHandler({
      dispatch: async ({ context, input, settlements }) => {
        const key = `${context.pluginInstanceId}\u0000${input.address.handle}\u0000${input.idempotencyKey}`;
        const result = messageSendReceipt('pub-recovered');
        settlements.set(key, result);
        if (failAfterSettlement) {
          failAfterSettlement = false;
          throw new Error('simulated transport loss after durable domain settlement');
        }
        return result;
      },
    });
    const { connection, store } = await activeHarness(handler);
    const input = messageSendInput({ idempotencyKey: 'recover-me' });

    await assert.rejects(connection.call('messaging.send', input), /simulated transport loss/);
    assert.equal((await store.snapshot()).calls[0].phase, 'dispatched');

    assert.deepEqual(await connection.call('messaging.send', input), messageSendReceipt('pub-recovered'));
    assert.equal(handler.dispatchCount(), 1);
    assert.equal((await store.snapshot()).calls[0].phase, 'settled_success');
  });

  it('lets one exact retry acquire an abandoned durable claim before dispatch', async () => {
    const handler = fakeMessageHandler();
    const { connection, store } = await activeHarness(handler);
    const input = messageSendInput({ idempotencyKey: 'abandoned-claim' });
    const settlementKey = `${INSTANCE_ID}\u0000${input.address.handle}\u0000${input.idempotencyKey}`;
    const ledgerKey = digestBrokerValue([INSTANCE_ID, 'messaging.send', settlementKey]);
    const [session] = (await store.snapshot()).sessions;
    await store.transaction((transaction) => {
      transaction.calls.put({
        ledgerKey,
        brokerSessionId: session.brokerSessionId,
        runtimeLeaseId: session.runtimeLeaseId,
        pluginInstanceId: INSTANCE_ID,
        packageDigest: session.packageDigest,
        grantRevision: session.grantRevision,
        method: 'messaging.send',
        settlementKey,
        inputDigest: digestBrokerValue(input),
        phase: 'claimed',
        revision: 1,
        createdAt: 5_000,
        updatedAt: 5_000,
      });
    });

    assert.deepEqual(await connection.call('messaging.send', input), messageSendReceipt('pub-abandoned-claim'));
    assert.equal(handler.dispatchCount(), 1);
    const [call] = (await store.snapshot()).calls;
    assert.equal(call.phase, 'settled_success');
    assert.equal(call.revision, 3);
  });

  it('rechecks grants and runtime expiry on every call', async () => {
    const revokedHandler = fakeMessageHandler();
    const revoked = await activeHarness(revokedHandler);
    await revoked.inventory.transaction((transaction) => {
      const grant = transaction.grants.get(INSTANCE_ID);
      transaction.grants.put({ ...grant, grantRevision: grant.grantRevision + 1, effectiveGrants: [] });
    });
    await assert.rejects(
      revoked.connection.call('messaging.send', messageSendInput()),
      isBrokerError('AUTHORITY_CHANGED'),
    );
    assert.equal(revokedHandler.dispatchCount(), 0);

    const expiredHandler = fakeMessageHandler();
    const expired = await activeHarness(expiredHandler);
    expired.setNow(15_001);
    await assert.rejects(
      expired.connection.call('messaging.send', messageSendInput()),
      isBrokerError('SESSION_NOT_ACTIVE'),
    );
    assert.equal(expiredHandler.dispatchCount(), 0);
  });

  it('rejects a capability absent at handshake without misclassifying authority drift', async () => {
    const handler = fakeMessageHandler();
    const { connection, store } = await activeHarness(handler, { effectiveGrants: [] });

    await assert.rejects(connection.call('messaging.send', messageSendInput()), isBrokerError('CAPABILITY_DENIED'));
    assert.equal(handler.dispatchCount(), 0);
    assert.equal((await store.snapshot()).sessions[0].phase, 'active');
  });

  it('does not expose the retired owner-import event bypass', async () => {
    const { broker, connection, store } = await activeHarness(fakeMessageHandler());
    assert.equal('publishOwnerImportedSignal' in broker, false);
    await assert.rejects(connection.call('events.publish', {}), isBrokerError('METHOD_NOT_READY'));
    assert.equal((await store.snapshot()).calls.length, 0);
  });
});
