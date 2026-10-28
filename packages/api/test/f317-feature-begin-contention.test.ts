import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { DesktopWindowObserver } from '../src/domains/plugin/desktop-window-runtime/observer.js';
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
  // Exercise the shared authority directly; the official editor runtime's
  // one-feature installation policy is a separate boundary, not this queue.
  const inventory = await readyInventory({ manifest });
  let now = 2_000;
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
    broker,
    connection,
    authority,
    first,
    now: () => now,
    setTime: (value: number) => {
      now = value;
    },
    setVerify: (value: () => Promise<void>) => {
      verify = value;
    },
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

test('a provisioning package scan cannot monopolize Broker snapshots or live lease renewal', async (t) => {
  const f = await fixture();
  const held = await holdBegin(t, f);
  let read = false;
  let renewed = false;
  const reading = f.store.snapshot().then(() => {
    read = true;
  });
  const renewing = f.connection.renewRuntimeLease().then(() => {
    renewed = true;
  });
  await turn(); // Memory stores: flush the actual transaction continuations, without a wall timeout.
  const beforeRelease = { read, renewed };
  held.release();
  await Promise.all([reading, renewing, held.result]);
  assert.deepEqual(beforeRelease, { read: true, renewed: true }, 'package IO must not own either shared queue');
});

test('a fresh observer can publish while a sibling feature activation is waiting for package IO', async (t) => {
  const f = await fixture();
  const held = await holdBegin(t, f);
  let polls = 0;
  const observer = new DesktopWindowObserver({
    id: f.id,
    window: {
      poll: async () => {
        polls++;
        return 'visible';
      },
      show: async () => {},
      close: async () => {},
    },
    lease: f.first.executionLease,
    connection: f.connection,
    features: f.authority,
    freshnessMs: 15_000,
    now: f.now,
    isCurrent: () => true,
  });
  const observed = observer.observe().then(
    () => 'published',
    () => 'rejected',
  );
  await turn();
  const beforeRelease = observer.observation;
  // The blocked activation takes longer than a genuine reply may be retained.
  f.setTime(18_000);
  held.release();
  await held.result;
  const result = await observed;
  assert.equal(beforeRelease?.state, 'visible', 'unrelated activation IO cannot age a reply inside shared locks');
  assert.equal(beforeRelease.observedAt, 2_000);
  assert.equal(beforeRelease.expiresAt, 17_000, 'freshness stays exactly15s, never reset at publication');
  assert.equal(result, 'published');
  assert.equal(polls, 1);
});

test('an owner can disable a provisioning feature during its scan and the fresh check denies its lease', async (t) => {
  const f = await fixture();
  const held = await holdBegin(t, f);
  let disabled = false;
  const disabling = f.authority.setDesired(f.id, 'second', false).then(() => {
    disabled = true;
  });
  await turn();
  const beforeRelease = disabled;
  held.release();
  const result = await held.result;
  await disabling;
  assert.equal(beforeRelease, true, 'package verification must not postpone the owner revocation');
  assert.ok('error' in result, 'the post-scan check must observe the disable before minting authority');
  assert.equal(
    (await f.store.snapshot()).staticFeatures?.leases.some((r) => r.featureId === 'second'),
    false,
  );
});

test('a runtime lease expiring during provisioning verification cannot mint a feature lease', async (t) => {
  const f = await fixture();
  const held = await holdBegin(t, f);
  f.setTime(33_000); // The initial binding expires at32s; no renewal occurs in this case.
  held.release();
  const result = await held.result;
  assert.ok('error' in result, 'binding authority must be checked at the end of package IO, not at its start');
  assert.equal(
    (await f.store.snapshot()).staticFeatures?.leases.some((r) => r.featureId === 'second'),
    false,
  );
});

test('a damaged epoch detected by a concurrent reader cannot be revived by a scan that finishes later', async (t) => {
  const f = await fixture();
  const held = await holdBegin(t, f);
  f.setVerify(async () => {
    throw new Error('fixture integrity damage');
  });
  const damage = f.authority.run(f.first.executionLease, async () => assert.fail('untrusted effect')).catch(() => {});
  await turn();
  held.release();
  const result = await held.result;
  await damage;
  assert.ok('error' in result, 'the current durable damaged epoch must win over the earlier scan');
  const ledger = (await f.store.snapshot()).staticFeatures;
  assert.ok(ledger);
  assert.equal(ledger.epochs[0].state, 'damaged');
  assert.ok(ledger.leases.every((r) => r.state === 'revoked'));
});
