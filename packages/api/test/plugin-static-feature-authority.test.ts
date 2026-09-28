import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HostBrokerControlPlane } from '../src/domains/plugin/host-broker/control-plane.js';
import { StaticFeatureAuthority } from '../src/domains/plugin/host-broker/static-feature-authority.js';
import { FileHostBrokerStore, MemoryHostBrokerStore } from '../src/domains/plugin/host-broker/stores.js';
import { candidateHello, INSTANCE_ID, PACKAGE_DIGEST, readyInventory } from './plugin-host-broker-helpers.js';

async function fixture(store = new MemoryHostBrokerStore()) {
  const inventory = await readyInventory({ effectiveGrants: [] });
  await inventory.transaction((tx) => {
    const pkg = tx.packages.get(PACKAGE_DIGEST)!;
    tx.packages.put({
      ...pkg,
      manifest: {
        ...pkg.manifest,
        features: [...pkg.manifest.features, { id: 'second', name: 'Second', resources: [], capabilities: [] }],
      },
    });
  });
  let damaged = false;
  const broker = new HostBrokerControlPlane({ inventory, store, now: () => 2_000 });
  const connection = await broker.openBuiltinConnection(INSTANCE_ID);
  const binding = await connection.hello(candidateHello());
  await connection.ready({ bindingNonce: binding.bindingNonce });
  const authority = new StaticFeatureAuthority({
    inventory,
    store,
    broker,
    now: () => 2_000,
    verifyActivePackage: async (instanceId: string, digest: string) => {
      assert.equal(instanceId, INSTANCE_ID);
      assert.equal(digest, PACKAGE_DIGEST);
      if (damaged) throw new Error('active tree digest mismatch');
    },
  });
  return {
    inventory,
    store,
    broker,
    connection,
    authority,
    damage: () => {
      damaged = true;
    },
  };
}

test('inventory enabled alone cannot mint a feature lease; a live Broker binding is required', async () => {
  const f = await fixture();
  await f.connection.close('test');
  await assert.rejects(f.authority.begin(INSTANCE_ID, 'source'), /authority|active|ready/i);
  assert.equal((await f.store.snapshot()).staticFeatures?.leases.length ?? 0, 0);
});

test('provisioning has no effects; activation commits declarations and lease together', async () => {
  const f = await fixture();
  const pending = await f.authority.begin(INSTANCE_ID, 'source');
  let effects = 0;
  await assert.rejects(
    f.authority.run(pending.executionLease, async () => {
      effects++;
    }),
    /active/i,
  );
  assert.equal(effects, 0);
  const live = await f.authority.commit(pending.executionLease);
  assert.equal(live.state, 'active');
  await f.authority.run(live.executionLease, async (record) => {
    assert.equal(record.featureId, 'source');
    effects++;
  });
  assert.equal(effects, 1);
});

test('feature disable revokes pending work and old contexts; re-enable creates a new revision', async () => {
  const f = await fixture();
  const pending = await f.authority.begin(INSTANCE_ID, 'source');
  await f.authority.setDesired(INSTANCE_ID, 'source', false);
  await assert.rejects(f.authority.commit(pending.executionLease), /revoked|disabled/i);
  await assert.rejects(f.authority.begin(INSTANCE_ID, 'source'), /disabled/i);
  await f.authority.setDesired(INSTANCE_ID, 'source', true);
  const next = await f.authority.begin(INSTANCE_ID, 'source');
  assert.ok(next.activationRevision > pending.activationRevision);
  assert.notEqual(next.executionLease, pending.executionLease);
  await f.authority.commit(next.executionLease);
  await assert.rejects(
    f.authority.run(pending.executionLease, async () => assert.fail('old effect')),
    /revoked/i,
  );
});

test('Broker close atomically revokes its feature leases without changing feature preference', async () => {
  const f = await fixture();
  const pending = await f.authority.begin(INSTANCE_ID, 'source');
  await f.authority.commit(pending.executionLease);
  await f.connection.close('plugin_disabled');
  const snapshot = await f.store.snapshot();
  assert.equal(snapshot.staticFeatures?.leases[0]?.state, 'revoked');
  assert.equal(snapshot.staticFeatures?.preferences[0]?.enabled, true);
  await assert.rejects(
    f.authority.run(pending.executionLease, async () => assert.fail('late effect')),
    /revoked/i,
  );
});

test('integrity damage contains all authority in the same durable epoch and cannot be revived', async () => {
  const f = await fixture();
  const pending = await f.authority.begin(INSTANCE_ID, 'source');
  await f.authority.commit(pending.executionLease);
  f.damage();
  await assert.rejects(
    f.authority.run(pending.executionLease, async () => assert.fail('untrusted effect')),
    /integrity/i,
  );
  const snapshot = await f.store.snapshot();
  assert.equal(snapshot.staticFeatures?.epochs[0]?.state, 'damaged');
  assert.equal(snapshot.staticFeatures?.leases[0]?.state, 'revoked');
  await assert.rejects(f.authority.commit(pending.executionLease), /revoked|integrity/i);
});

test('owner revocation cannot cross an in-flight authorized commit', async () => {
  const f = await fixture();
  const pending = await f.authority.begin(INSTANCE_ID, 'source');
  await f.authority.commit(pending.executionLease);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let finish!: () => void;
  const effect = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const order: string[] = [];
  const running = f.authority.run(pending.executionLease, async () => {
    entered();
    await effect;
    order.push('owner receipt');
  });
  await started;
  const disabling = f.inventory.transaction((tx) => {
    const instance = tx.instances.get(INSTANCE_ID)!;
    tx.instances.put({ ...instance, activationState: 'disabling', lifecycleRevision: instance.lifecycleRevision + 1 });
    order.push('disabled');
  });
  finish();
  await Promise.all([running, disabling]);
  assert.deepEqual(order, ['owner receipt', 'disabled']);
  await assert.rejects(
    f.authority.run(pending.executionLease, async () => assert.fail('new effect')),
    /authority|ready/i,
  );
});

test('durable restart revokes active leases and preserves monotonic history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'f309-feature-authority-'));
  const path = join(directory, 'broker.json');
  const f = await fixture(new FileHostBrokerStore(path));
  const pending = await f.authority.begin(INSTANCE_ID, 'source');
  await f.authority.commit(pending.executionLease);
  const reopened = new FileHostBrokerStore(path);
  const broker = new HostBrokerControlPlane({ inventory: f.inventory, store: reopened, now: () => 2_100 });
  await broker.recoverAfterRestart();
  const snapshot = await reopened.snapshot();
  assert.equal(snapshot.staticFeatures?.leases[0]?.state, 'revoked');
  assert.equal(snapshot.staticFeatures?.leases[0]?.executionLease, pending.executionLease);
  assert.equal(snapshot.staticFeatures?.preferences[0]?.enabled, true);
});

test('a sibling activation that detects damage also revokes the already-active feature', async () => {
  const f = await fixture();
  const pending = await f.authority.begin(INSTANCE_ID, 'source');
  await f.authority.commit(pending.executionLease);
  f.damage();
  await assert.rejects(f.authority.begin(INSTANCE_ID, 'second'), /integrity|digest/);
  const snapshot = await f.store.snapshot();
  assert.equal(snapshot.staticFeatures?.epochs[0]?.state, 'damaged');
  assert.equal(snapshot.staticFeatures?.leases[0]?.state, 'revoked');
});

test('disabling one feature preserves a sibling lease and its own activation revision', async () => {
  const f = await fixture();
  const first = await f.authority.begin(INSTANCE_ID, 'source');
  const second = await f.authority.begin(INSTANCE_ID, 'second');
  await f.authority.commit(first.executionLease);
  await f.authority.commit(second.executionLease);
  await f.authority.setDesired(INSTANCE_ID, 'source', false);
  await assert.rejects(
    f.authority.run(first.executionLease, async () => assert.fail('disabled feature')),
    /revoked/,
  );
  const actual = await f.authority.run(second.executionLease, async (record) => record);
  assert.equal(actual.activationRevision, second.activationRevision);
  assert.equal(actual.integrityEpoch, first.integrityEpoch);
});

test('an expired runtime lease revokes the feature before its next effect', async () => {
  const f = await fixture();
  const pending = await f.authority.begin(INSTANCE_ID, 'source');
  await f.authority.commit(pending.executionLease);
  await f.store.transaction((tx) => {
    const runtime = tx.runtimeLeases.get(pending.runtimeLeaseId)!;
    tx.runtimeLeases.put({ ...runtime, expiresAt: 1_999 });
  });
  await assert.rejects(
    f.authority.run(pending.executionLease, async () => assert.fail('expired effect')),
    /authority/,
  );
  assert.equal((await f.store.snapshot()).staticFeatures?.leases[0]?.state, 'revoked');
});
