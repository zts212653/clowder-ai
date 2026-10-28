// Post-scan instance and activation guards for the shared Host authority.
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { HostBrokerControlPlane } from '../src/domains/plugin/host-broker/control-plane.js';
import { StaticFeatureAuthority } from '../src/domains/plugin/host-broker/static-feature-authority.js';
import { MemoryHostBrokerStore } from '../src/domains/plugin/host-broker/stores.js';
import { candidateHello, INSTANCE_ID, PLUGIN_ID, readyInventory } from './plugin-host-broker-helpers.js';
import { staticEditorManifest } from './plugin-static-editor.fixture.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const manifest = staticEditorManifest();
  manifest.pluginId = PLUGIN_ID;
  manifest.features.push({ id: 'second', name: 'Second', resources: [], capabilities: [] });
  const inventory = await readyInventory({ manifest });
  const now = 2_000;
  let verify = async () => {};
  const store = new MemoryHostBrokerStore();
  const broker = new HostBrokerControlPlane({ inventory, store, now: () => now });
  const connection = await broker.openBuiltinConnection(INSTANCE_ID);
  const hello = await connection.hello(candidateHello());
  await connection.ready({ bindingNonce: hello.bindingNonce });
  const authority = new StaticFeatureAuthority({
    inventory,
    store,
    broker,
    now: () => now,
    verifyActivePackage: () => verify(),
  });
  const first = await authority.begin(INSTANCE_ID, 'edit');
  await authority.commit(first.executionLease);
  return {
    inventory,
    id: INSTANCE_ID,
    store,
    connection,
    authority,
    first,
    setVerify: (value: () => Promise<void>) => (verify = value),
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function holdBegin(t: TestContext, f: Fixture) {
  const entered = deferred();
  const held = deferred();
  let first = true;
  f.setVerify(async () => {
    if (!first) return;
    first = false;
    entered.resolve();
    await held.promise;
  });
  const result = f.authority.begin(f.id, 'second').then(
    (lease) => ({ lease }),
    (error: unknown) => ({ error }),
  );
  t.after(async () => {
    held.resolve();
    await result;
  });
  await entered.promise;
  return { release: held.resolve, result };
}

const secondLeases = async (f: Fixture) =>
  ((await f.store.snapshot()).staticFeatures?.leases ?? []).filter(
    (r) => r.featureId === 'second' && r.state !== 'revoked',
  );

for (const [name, patch] of [
  ['the plugin is disabled', { activationState: 'disabled' }],
  ['the plugin runtime stops', { runtimeState: 'stopped' }],
  ['the plugin runtime crashes', { runtimeState: 'crashed' }],
] as const) {
  test(`a feature lease cannot be minted when ${name} during the scan`, async (t) => {
    const f = await fixture();
    const held = await holdBegin(t, f);
    await f.inventory.transaction((tx) => {
      const instance = tx.instances.get(f.id);
      assert.ok(instance);
      tx.instances.put({ ...instance, ...patch, updatedAt: 3_000 });
    });
    held.release();
    const result = await held.result;
    assert.ok('error' in result, 'the post-scan check must see the changed instance state');
    assert.equal((await secondLeases(f)).length, 0);
  });
}

test('a feature lease cannot be minted for an instance retired during the scan', async (t) => {
  const f = await fixture();
  const held = await holdBegin(t, f);
  await f.inventory.transaction((tx) => {
    const instance = tx.instances.get(f.id);
    assert.ok(instance);
    tx.instances.put({ ...instance, lifecycleState: 'retired', retiredAt: 3_000, updatedAt: 3_000 });
  });
  held.release();
  const result = await held.result;
  assert.ok('error' in result, 'the post-scan check must see that the instance is no longer current');
  assert.equal((await secondLeases(f)).length, 0);
});

test('two concurrent activations of one feature mint exactly one lease', async (t) => {
  const f = await fixture();
  const held = await holdBegin(t, f); // the first begin is parked at its scan
  const meanwhile = await f.authority.begin(f.id, 'second').then(
    (lease) => ({ lease }),
    (error: unknown) => ({ error }),
  );
  assert.ok('lease' in meanwhile, 'the second begin finishes its scan immediately and mints the lease');
  held.release();
  const late = await held.result;
  assert.ok('error' in late, 'the late begin must see the lease minted while its scan was pending');
  assert.equal((await secondLeases(f)).length, 1);
});
