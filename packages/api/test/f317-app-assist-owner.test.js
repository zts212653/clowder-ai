import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { MemoryConciergeConfigStore } from '../dist/domains/concierge/ConciergeConfigStore.js';
import { CompanionAppAssistOwner } from '../dist/domains/concierge/live/host/companion-app-assist-owner.js';
import { createAppAssistPipe } from '../dist/domains/plugin/desktop-window-runtime/app-assist-pipe.js';

const { createAppAssistHost } = createRequire(import.meta.url)('../../../desktop/plugin-window/app-assist-host.cjs');

async function fixture(t, store = new MemoryConciergeConfigStore()) {
  let now = Date.parse('2030-01-02T09:59:59Z');
  let valid = true;
  let zone = 'Pacific/Honolulu';
  let emit;
  const owner = new CompanionAppAssistOwner({
    store,
    ownerUserId: 'fixture-owner',
    timeZone: () => zone,
    now: () => now,
    assertCurrent: async () => {
      if (!valid) throw new Error('Lease lost');
    },
  });
  const host = createAppAssistHost({
    owner: { read: () => owner.request({ kind: 'read' }), claim: (appKey) => owner.request({ kind: 'claim', appKey }) },
    selfBundleIds: ['ai.fixture.self'],
    sourceFactory: async (observe) => {
      emit = observe;
      return { close: async () => {} };
    },
  });
  const dispose = await owner.watch((allowed) => host.policyChanged(allowed));
  t.after(async () => {
    await host.close();
    await dispose();
  });
  return {
    store,
    owner,
    host,
    event: () => emit({ bundleId: 'org.fixture.editor', name: 'Fixture Editor' }),
    tomorrow: () => {
      now += 2000;
    },
    rollback: () => {
      now -= 86400000;
    },
    expireLease: () => {
      valid = false;
    },
    noZone: () => {
      zone = undefined;
    },
  };
}

test('real owner and Host use the verified owner day, preserve daily claim through reload and reject rollback', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.host.resume()).status, 'off');
  await f.store.patch('fixture-owner', { appAssistEnabled: true });
  await f.host.resume();
  await f.event();
  let state = f.host.snapshot();
  assert.equal(state.offer.appName, 'Fixture Editor');
  f.host.settle({ scopeRef: state.scopeRef, offerRef: state.offer.offerRef, action: 'accept' });
  await f.event();
  assert.equal(f.host.snapshot().offer, null);
  await f.host.reset();
  await f.host.resume();
  await f.event();
  assert.equal(f.host.snapshot().offer, null);
  f.tomorrow();
  await f.event();
  state = f.host.snapshot();
  assert.equal(state.offer.appName, 'Fixture Editor');
  f.host.settle({ scopeRef: state.scopeRef, offerRef: state.offer.offerRef, action: 'timeout' });
  f.rollback();
  await f.event();
  assert.equal(f.host.snapshot().offer, null);
  f.noZone();
  await f.host.suspend();
  assert.equal((await f.host.resume()).status, 'timezone_required');
});

test('original settings owner revokes two actual Host instances without an application event', async (t) => {
  const store = new MemoryConciergeConfigStore();
  const a = await fixture(t, store),
    b = await fixture(t, store);
  await store.patch('fixture-owner', { appAssistEnabled: true });
  await Promise.all([a.host.resume(), b.host.resume()]);
  await Promise.all([a.event(), b.event()]);
  assert.equal([a.host.snapshot(), b.host.snapshot()].filter((s) => s.offer).length, 1);
  await store.patch('fixture-owner', { appAssistEnabled: false });
  for (const f of [a, b]) {
    assert.equal(f.host.snapshot().offer, null);
    assert.equal(f.host.snapshot().status, 'off');
  }
  assert.deepEqual(await a.owner.request({ kind: 'read' }), { status: 'off' });
  await assert.rejects(
    a.owner.request({ kind: 'claim', appKey: 'org.fixture.raw', ownerUserId: 'other', day: '2030-01-02' }),
  );
  a.expireLease();
  await assert.rejects(a.owner.request({ kind: 'read' }));
});

test('claim result in flight across opt-out cannot publish, and unconfirmed opt-out survives renderer reload', async (t) => {
  const f = await fixture(t);
  await f.store.patch('fixture-owner', { appAssistEnabled: true });
  await f.host.resume();
  let release, claimed;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    claimed = resolve;
  });
  const claim = f.store.claimAppAssistDay.bind(f.store);
  f.store.claimAppAssistDay = async (...args) => {
    const result = await claim(...args);
    claimed();
    await gate;
    return result;
  };
  const pending = f.event();
  await started;
  await f.store.patch('fixture-owner', { appAssistEnabled: false });
  release();
  await pending;
  assert.equal(f.host.snapshot().offer, null);
  await f.store.patch('fixture-owner', { appAssistEnabled: true });
  await f.host.resume();
  await f.host.request({ kind: 'settings.update', field: 'appAssistEnabled', value: false }, async () => ({
    kind: 'settings-update',
    outcome: 'unconfirmed',
  }));
  await f.host.reset();
  assert.equal((await f.host.resume()).status, 'suspended');
  await f.event();
  assert.equal(f.host.snapshot().offer, null);
});

test('private kernel pipe admits only hashed claims and never renderer app identities or caller-selected owners', async () => {
  const replies = [];
  const calls = [];
  const pipe = createAppAssistPipe(
    {
      request: async (input) => {
        calls.push(input);
        return { status: 'off' };
      },
    },
    (line) => replies.push(JSON.parse(line)),
  );
  const base = { v: 1, type: 'app_assist', id: '10000000-0000-4000-8000-000000000001' };
  assert.equal(pipe.accept({ ...base, command: { kind: 'read' } }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ kind: 'read' }]);
  assert.equal(replies.length, 1);
  assert.equal(
    pipe.accept({ ...base, command: { kind: 'claim', bundleId: 'org.fixture.raw', name: 'Fixture' } }),
    false,
  );
  pipe.close();
  assert.throws(() => pipe.accept({ ...base, command: { kind: 'read' } }));
});

test('a saved opt-out revokes observation even when the execution-lease read is stalled', async (t) => {
  const store = new MemoryConciergeConfigStore();
  let waitForLease = false,
    release;
  const lease = new Promise((done) => {
    release = done;
  });
  const owner = new CompanionAppAssistOwner({
    store,
    ownerUserId: 'fixture-owner',
    timeZone: () => 'UTC',
    assertCurrent: async () => {
      if (waitForLease) await lease;
    },
  });
  let revoked = false;
  const dispose = await owner.watch((allowed) => {
    if (allowed === false) revoked = true;
  });
  t.after(async () => {
    release();
    await dispose();
  });
  waitForLease = true;
  const saving = store.patch('fixture-owner', { appAssistEnabled: false });
  await Promise.race([saving, new Promise((done) => setTimeout(done, 25))]);
  assert.equal(revoked, true, 'revocation must precede a potentially stalled affirmative authority check');
  release();
  await saving;
});

test('production without its durable owner adapter cannot start collection', async () => {
  const owner = new CompanionAppAssistOwner({
    store: undefined,
    ownerUserId: 'fixture-owner',
    timeZone: () => 'UTC',
    assertCurrent: async () => {},
  });
  let policy;
  const dispose = await owner.watch((value) => {
    policy = value;
  });
  assert.equal(policy, null);
  assert.deepEqual(await owner.request({ kind: 'read' }), { status: 'source_unavailable' });
  await dispose();
});

test('Host lifetime revocation clears observation independently of the durable broker close', async (t) => {
  const f = await fixture(t);
  await f.store.patch('fixture-owner', { appAssistEnabled: true });
  await f.host.resume();
  await f.event();
  assert.ok(f.host.snapshot().offer);
  await f.owner.revoke?.();
  assert.equal(f.host.snapshot().offer, null);
  assert.notEqual(f.host.snapshot().status, 'ready');
  assert.deepEqual(await f.owner.request({ kind: 'read' }), { status: 'source_unavailable' });
});

test('subscription setup failure leaves app assistance unavailable without failing the independent desktop body', async () => {
  const store = new MemoryConciergeConfigStore();
  store.watchAppAssistPolicy = async () => {
    throw new Error('Fixture source unavailable');
  };
  const owner = new CompanionAppAssistOwner({
    store,
    ownerUserId: 'fixture-owner',
    timeZone: () => 'UTC',
    assertCurrent: async () => {},
  });
  let policy;
  const dispose = await owner.watch((value) => {
    policy = value;
  });
  assert.equal(policy, null);
  assert.deepEqual(await owner.request({ kind: 'read' }), { status: 'source_unavailable' });
  await dispose();
});
