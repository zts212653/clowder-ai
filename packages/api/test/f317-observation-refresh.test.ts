import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DesktopWindowObserver } from '../src/domains/plugin/desktop-window-runtime/observer.js';
import { HostBrokerControlPlane } from '../src/domains/plugin/host-broker/control-plane.js';
import { StaticFeatureAuthority } from '../src/domains/plugin/host-broker/static-feature-authority.js';
import { MemoryHostBrokerStore } from '../src/domains/plugin/host-broker/stores.js';
import { candidateHello, INSTANCE_ID, PLUGIN_ID, readyInventory } from './plugin-host-broker-helpers.js';
import { staticEditorManifest } from './plugin-static-editor.fixture.js';

async function fixture() {
  const manifest = staticEditorManifest();
  manifest.pluginId = PLUGIN_ID;
  const inventory = await readyInventory({ manifest });
  let now = 2_000;
  let verify = async () => {};
  let polls = 0;
  let read: () => Promise<'visible' | 'hidden'> = async () => 'visible';
  const store = new MemoryHostBrokerStore();
  const broker = new HostBrokerControlPlane({ inventory, store, now: () => now });
  const connection = await broker.openBuiltinConnection(INSTANCE_ID);
  const hello = await connection.hello(candidateHello());
  await connection.ready({ bindingNonce: hello.bindingNonce });
  const features = new StaticFeatureAuthority({
    inventory,
    store,
    broker,
    now: () => now,
    verifyActivePackage: () => verify(),
  });
  const lease = await features.begin(INSTANCE_ID, 'edit');
  await features.commit(lease.executionLease);
  const observer = new DesktopWindowObserver({
    id: INSTANCE_ID,
    lease: lease.executionLease,
    window: {
      poll: async () => {
        polls++;
        return read();
      },
      show: async () => {},
      close: async () => {},
    },
    features,
    connection,
    freshnessMs: 15_000,
    now: () => now,
    isCurrent: () => true,
  });
  return {
    observer,
    store,
    features,
    inventory,
    now: () => now,
    polls: () => polls,
    setPoll: (next: () => Promise<'visible' | 'hidden'>) => {
      read = next;
    },
    advance: (ms: number) => {
      now += ms;
    },
    setVerify: (next: () => Promise<void>) => {
      verify = next;
    },
  };
}

// The natural r170 trace spends21.973s after a healthy native reply while its
// renewed30s binding is still live. Exercise the actual observer and authority;
// only the package service time is controlled, with no wall-clock sleep.
test('slow Host preparation obtains a genuinely fresh reply before publishing under current authority', async () => {
  const f = await fixture();
  let checks = 0;
  f.setVerify(async () => {
    checks++;
    f.advance(22_000);
  });
  for (let cycle = 0; cycle < 3; cycle++) {
    await f.observer.observe();
    const observation = f.observer.observation;
    assert.ok(observation);
    assert.equal(observation.state, 'visible');
    assert.equal(observation.observedAt, f.now(), 'publication must use a new native reply, never redate the old one');
    assert.equal(observation.expiresAt - observation.observedAt, 15_000);
  }
  assert.equal(checks, 3, 'every observation retains the full package verification');
  assert.ok(f.polls() >= 6, 'a slow preparation needs a new native witness on every cycle');
  assert.equal((await f.store.snapshot()).staticFeatures?.leases[0]?.state, 'active');
});

test('a refreshed reply uses the new native state and a failed refresh cannot be retried into success', async () => {
  const f = await fixture();
  f.setVerify(async () => {
    f.advance(22_000);
  });
  f.setPoll(async () => (f.polls() === 1 ? 'visible' : 'hidden'));
  await f.observer.observe();
  assert.equal(f.observer.observation?.state, 'hidden');
  assert.equal(f.polls(), 2);

  const failed = await fixture();
  const fault = new Error('original refresh rejection');
  failed.setVerify(async () => {
    failed.advance(22_000);
  });
  failed.setPoll(async () => {
    if (failed.polls() === 2) throw fault;
    return 'visible';
  });
  await assert.rejects(failed.observer.observe(), (error) => error === fault);
  assert.equal(failed.polls(), 2, 'a third successful reply must never replace this failure');
  assert.equal(failed.observer.observation, undefined);
  assert.equal(failed.observer.diagnostic()?.phase, 'poll');
  assert.equal(failed.observer.diagnostic()?.pending, false);
  const stages = failed.observer.diagnostic()?.stages;
  assert.equal(stages?.find((stage) => stage.stage === 'poll')?.status, 'ok');
  assert.equal(stages?.find((stage) => stage.stage === 'poll-refresh')?.status, 'failed');
});

for (const refreshFails of [false, true]) {
  test(`damaged slow verification contains its epoch without an extra native read (${refreshFails ? 'failing' : 'healthy'} child)`, async () => {
    const f = await fixture();
    f.setVerify(async () => {
      f.advance(22_000);
      throw new Error('damaged shared generation');
    });
    f.setPoll(async () => {
      if (refreshFails && f.polls() === 2) throw new Error('native gone during extra read');
      return 'visible';
    });
    await assert.rejects(f.observer.observe(), /package integrity is untrusted/);
    assert.equal(f.polls(), 1, 'a damaged seal must not dispatch another native read');
    assert.equal(f.observer.observation, undefined);
    const ledger = (await f.store.snapshot()).staticFeatures;
    assert.equal(ledger?.leases[0]?.state, 'revoked');
    assert.equal(ledger?.epochs[0]?.state, 'damaged', 'a poll failure cannot bypass durable containment');
  });
}

for (const loss of ['owner-disable', 'lease-expiry', 'package-damage'] as const) {
  test(`${loss} during the fresh input read denies publication under the final current authority`, async () => {
    const f = await fixture();
    f.setVerify(async () => {
      f.advance(22_000);
    });
    f.setPoll(async () => {
      if (f.polls() === 2) {
        if (loss === 'owner-disable') await f.features.setDesired(INSTANCE_ID, 'edit', false);
        if (loss === 'lease-expiry') f.advance(10_001);
        if (loss === 'package-damage') {
          f.setVerify(async () => {
            throw new Error('damaged shared generation');
          });
          const lease = (await f.store.snapshot()).staticFeatures?.leases[0];
          assert.ok(lease);
          await assert.rejects(f.features.run(lease.executionLease, async () => assert.fail('untrusted effect')));
        }
      }
      return 'visible';
    });
    await assert.rejects(f.observer.observe());
    assert.equal(f.observer.observation, undefined);
    assert.equal(f.polls(), 2);
    assert.equal((await f.store.snapshot()).staticFeatures?.leases[0]?.state, 'revoked');
  });
}

test('a second reply held beyond its deadline stays terminal and cannot leapfrog to another control poll', async (t) => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  f.setVerify(async () => {
    f.advance(22_000);
  });
  let entered!: () => void;
  const refresh = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.setPoll(async () => {
    if (f.polls() === 2) {
      entered();
      return new Promise<never>(() => {});
    }
    return 'visible';
  });
  const observed = assert.rejects(f.observer.observe(), /desktop heartbeat expired/);
  await refresh;
  t.mock.timers.tick(5_001);
  await observed;
  assert.equal(f.polls(), 2);
  assert.equal(f.observer.observation, undefined);
  assert.equal(f.observer.diagnostic()?.pending, true);
});

test('an old refreshed sample still fails closed when the final Broker transaction itself waits15s', async (t) => {
  const f = await fixture();
  t.mock.method(performance, 'now', () => f.now() - 2_000);
  f.setVerify(async () => {
    f.advance(10_000);
  });
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let blocker: Promise<void> | undefined;
  f.setPoll(async () => {
    if (f.polls() === 2) {
      const holding = new Promise<void>((resolve) => {
        blocker = f.store.transaction(async () => {
          resolve();
          await blocked;
        });
      });
      await holding;
      entered();
    }
    return 'visible';
  });
  const observed = assert.rejects(f.observer.observe(), /desktop observation expired/);
  try {
    await queued;
    // Flush the genuine poll continuation so receive time precedes the delay.
    await new Promise<void>((resolve) => setImmediate(resolve));
    f.advance(15_000);
  } finally {
    release();
  }
  await blocker;
  await observed;
  assert.equal(f.polls(), 2, 'no retry after the final authority attempt');
  assert.equal(f.observer.observation, undefined);
  assert.equal(f.observer.diagnostic()?.error?.reason, 'observation_expired');
  const clock = f.observer.diagnostic()?.costs?.clock;
  assert.ok(clock?.refreshed);
  assert.equal(clock.received.wallMs, 2_000, 'keep the original reply and slow preparation in the trace');
  assert.equal(clock.refreshed.wallMs, 12_000);
  assert.equal(clock.wallElapsedMs, 25_000);
  assert.equal(clock.monotonicElapsedMs, 25_000);
  assert.equal(clock.published.wallMs - clock.refreshed.wallMs, 15_000);
});
