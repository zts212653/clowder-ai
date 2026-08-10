import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  FileHostBrokerStore,
  HostBrokerControlPlane,
  HostBrokerError,
} from '../dist/domains/plugin/host-broker/index.js';
import { candidateHello, INSTANCE_ID, readyInventory } from './plugin-host-broker-helpers.js';

async function activePersistedHarness(path) {
  const inventory = await readyInventory();
  const store = new FileHostBrokerStore(path);
  const broker = new HostBrokerControlPlane({
    inventory,
    store,
    now: () => 5_000,
    createConnectionId: () => 'conn-restart',
    createSessionId: () => 'bs-restart',
    createRuntimeLeaseId: () => 'lease-restart',
    createBindingNonce: () => 'nonce-restart',
  });
  const connection = await broker.openBuiltinConnection(INSTANCE_ID);
  const binding = await connection.hello(candidateHello());
  await connection.ready({ bindingNonce: binding.bindingNonce });
  return { broker, connection, inventory, store };
}

describe('K-2B persisted restart normalization', () => {
  it('invalidates transient sessions and leases while preserving the durable call ledger', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'host-broker-restart-'));
    const path = join(root, 'broker.json');
    const { inventory, store } = await activePersistedHarness(path);
    await store.transaction((transaction) => {
      transaction.calls.put({
        ledgerKey: 'ledger-1',
        brokerSessionId: 'bs-restart',
        runtimeLeaseId: 'lease-restart',
        pluginInstanceId: INSTANCE_ID,
        packageDigest: candidateHello().packageDigest,
        grantRevision: 1,
        method: 'events.publish',
        settlementKey: 'settlement-1',
        inputDigest: 'digest-1',
        phase: 'settled_success',
        revision: 2,
        result: { publicationId: 'pub-1', disposition: 'accepted' },
        createdAt: 5_000,
        updatedAt: 5_001,
      });
    });
    const before = await store.snapshot();

    const restartedStore = new FileHostBrokerStore(path);
    const restarted = new HostBrokerControlPlane({ inventory, store: restartedStore, now: () => 9_000 });
    assert.equal(await restarted.recoverAfterRestart(), 1);

    const after = await restartedStore.snapshot();
    assert.equal(after.sessions[0].phase, 'closed');
    assert.equal(after.sessions[0].closeReason, 'host_restart');
    assert.equal(after.runtimeLeases[0].state, 'closed');
    assert.deepEqual(after.calls, before.calls);
    assert.equal((await inventory.snapshot()).instances[0].runtimeState, 'stopped');
  });

  it('fails closed on corrupted or unsupported persisted snapshots', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'host-broker-corrupt-'));
    const corruptPath = join(root, 'corrupt.json');
    const futurePath = join(root, 'future.json');
    writeFileSync(corruptPath, '{not-json');
    writeFileSync(futurePath, JSON.stringify({ schemaVersion: 99, sessions: [], runtimeLeases: [], calls: [] }));

    await assert.rejects(
      () => new FileHostBrokerStore(corruptPath).snapshot(),
      (error) => error instanceof HostBrokerError && error.code === 'CORRUPT_SNAPSHOT',
    );
    await assert.rejects(
      () => new FileHostBrokerStore(futurePath).snapshot(),
      (error) => error instanceof HostBrokerError && error.code === 'UNSUPPORTED_SCHEMA',
    );
  });

  it('rejects forged authority references and malformed terminal calls', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'host-broker-forged-'));
    const path = join(root, 'broker.json');
    const { store } = await activePersistedHarness(path);
    const snapshot = await store.snapshot();
    const forgedAuthorityPath = join(root, 'forged-authority.json');
    const malformedCallPath = join(root, 'malformed-call.json');
    const forged = structuredClone(snapshot);
    forged.runtimeLeases[0].packageDigest = `sha512-${'A'.repeat(86)}==`;
    writeFileSync(forgedAuthorityPath, JSON.stringify(forged));
    const malformed = structuredClone(snapshot);
    malformed.calls.push({
      ledgerKey: 'ledger-forged',
      brokerSessionId: 'bs-restart',
      runtimeLeaseId: 'lease-restart',
      pluginInstanceId: INSTANCE_ID,
      packageDigest: candidateHello().packageDigest,
      grantRevision: 1,
      method: 'events.publish',
      settlementKey: 'settlement-forged',
      inputDigest: 'digest-forged',
      phase: 'settled_success',
      revision: 2,
      createdAt: 5_000,
      updatedAt: 5_001,
    });
    writeFileSync(malformedCallPath, JSON.stringify(malformed));

    await assert.rejects(
      () => new FileHostBrokerStore(forgedAuthorityPath).snapshot(),
      (error) => error instanceof HostBrokerError && error.code === 'CORRUPT_SNAPSHOT',
    );
    await assert.rejects(
      () => new FileHostBrokerStore(malformedCallPath).snapshot(),
      (error) => error instanceof HostBrokerError && error.code === 'CORRUPT_SNAPSHOT',
    );
  });

  it('never exposes a partially committed file snapshot when rename fails', async () => {
    const root = mkdtempSync(join(os.tmpdir(), 'host-broker-atomic-'));
    const path = join(root, 'broker.json');
    const { store } = await activePersistedHarness(path);
    const before = await store.snapshot();
    const failing = new FileHostBrokerStore(path, {
      fileOps: {
        rename: async () => {
          throw new Error('simulated rename failure');
        },
      },
    });

    await assert.rejects(
      failing.transaction((transaction) => {
        const session = transaction.sessions.getByConnectionId('conn-restart');
        transaction.sessions.put({ ...session, phase: 'closed', updatedAt: 6_000 });
      }),
      /simulated rename failure/,
    );
    assert.deepEqual(await store.snapshot(), before);
  });
});
