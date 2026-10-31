import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { HostBrokerControlPlane } from '../src/domains/plugin/host-broker/control-plane.js';
import { StaticFeatureAuthority } from '../src/domains/plugin/host-broker/static-feature-authority.js';
import { MemoryHostBrokerStore } from '../src/domains/plugin/host-broker/stores.js';
import { staticEditorFixture, staticEditorManifest } from './plugin-static-editor.fixture.js';

async function fixture(t: TestContext) {
  const f = await staticEditorFixture(staticEditorManifest());
  t.after(f.cleanup);
  const installed = await f.install();
  await f.store.transaction((tx) => {
    const instance = tx.instances.get(installed.pluginInstanceId)!;
    tx.instances.put({ ...instance, configReadiness: 'ready', activationState: 'enabled', runtimeState: 'healthy' });
  });
  let now = 2_000;
  let verify: () => Promise<void> = async () => {};
  const store = new MemoryHostBrokerStore();
  const broker = new HostBrokerControlPlane({ inventory: f.store, store, now: () => now });
  const connection = await broker.openBuiltinConnection(installed.pluginInstanceId);
  const hello = await connection.hello({
    pluginId: f.entry.pluginId,
    packageDigest: f.entry.packageDigest,
    contractVersion: '0.1.0',
    wireVersion: '0.1.0',
  });
  await connection.ready({ bindingNonce: hello.bindingNonce });
  const authority = new StaticFeatureAuthority({
    inventory: f.store,
    store,
    broker,
    now: () => now,
    verifyActivePackage: () => verify(),
  });
  const pending = await authority.begin(installed.pluginInstanceId, 'edit');
  await authority.commit(pending.executionLease);
  return {
    ...f,
    inventory: f.store,
    installed,
    store,
    connection,
    authority,
    lease: pending.executionLease,
    setTime: (value: number) => {
      now = value;
    },
    setVerify: (value: () => Promise<void>) => {
      verify = value;
    },
  };
}

test('package integrity IO cannot starve lease renewal or owner disable behind Host store locks', async (t) => {
  const f = await fixture(t);
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setVerify(async () => {
    entered();
    await blocked;
  });
  let effects = 0;
  const running = f.authority
    .run(f.lease, async () => {
      effects++;
    })
    .then(
      () => 'effect',
      () => 'denied',
    );
  await started;
  f.setTime(31_000);
  const renew = f.connection.renewRuntimeLease();
  const progressed = await Promise.race([
    renew.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
  ]);
  if (!progressed) {
    release();
    await Promise.allSettled([running, renew]);
  }
  assert.equal(progressed, true, 'integrity scan must not hold either authority store while renewal waits');
  await f.inventory.transaction((tx) => {
    const instance = tx.instances.get(f.installed.pluginInstanceId)!;
    tx.instances.put({ ...instance, activationState: 'disabled', lifecycleRevision: instance.lifecycleRevision + 1 });
  });
  release();
  assert.equal(await running, 'denied', 'owner disable during verification wins before an effect');
  assert.equal(effects, 0);
});

test('clock crossing TTL during package verification rejects effects and revokes the old feature lease', async (t) => {
  const f = await fixture(t);
  f.setVerify(async () => {
    f.setTime(32_000);
  });
  let effects = 0;
  await assert.rejects(
    f.authority.run(f.lease, async () => {
      effects++;
    }),
    /authority/,
  );
  assert.equal(effects, 0);
  assert.equal((await f.store.snapshot()).staticFeatures?.leases[0]?.state, 'revoked');
  await assert.rejects(f.connection.renewRuntimeLease(), /active|authority/i, 'expired authority cannot renew');
});
