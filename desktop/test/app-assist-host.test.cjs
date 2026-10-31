const assert = require('node:assert/strict');
const test = require('node:test');
const { createAppAssistHost } = require('../plugin-window/app-assist-host.cjs');

function fixture() {
  let tick = 0;
  let allowed = false;
  let observe;
  let lost;
  let stops = 0;
  const claims = new Set();
  const timers = new Set();
  const host = createAppAssistHost({
    owner: {
      read: async () => ({ status: allowed ? 'ready' : 'off', keyScope: 'fixture-owner' }),
      claim: async (key) => {
        if (!allowed) return 'disabled';
        if (claims.has(key)) return 'already_claimed';
        claims.add(key);
        return 'claimed';
      },
    },
    sourceFactory: async (onEvent, onLost) => {
      observe = onEvent;
      lost = onLost;
      return {
        close: async () => {
          stops++;
        },
      };
    },
    selfBundleIds: ['ai.fixture.cat-cafe'],
    now: () => tick,
    setTimer: (fn) => {
      timers.add(fn);
      return fn;
    },
    clearTimer: (timer) => timers.delete(timer),
  });
  return {
    host,
    claims,
    timers,
    enable: () => {
      allowed = true;
    },
    disable: () => {
      allowed = false;
    },
    event: (value = { bundleId: 'org.fixture.editor', name: 'Fixture Editor' }) => observe(value),
    lose: () => lost(),
    stops: () => stops,
    advance: () => {
      tick += 15001;
      for (const fn of [...timers]) fn();
    },
  };
}

test('default-off never starts a source; explicit confirmed enable does', async () => {
  const f = fixture();
  assert.equal((await f.host.resume()).status, 'off');
  f.enable();
  assert.equal((await f.host.resume()).status, 'ready');
  await f.event();
  assert.equal(f.host.snapshot().offer.appName, 'Fixture Editor');
  assert.equal(f.claims.size, 1);
  await f.host.close();
});

test('unconfirmed opt-out cannot be rearmed by reads, resume, policy true, or renderer reload', async () => {
  const f = fixture();
  f.enable();
  await f.host.resume();
  await f.event();
  await f.host.request({ kind: 'settings.update', field: 'appAssistEnabled', value: false }, async () => ({
    kind: 'settings-update',
    outcome: 'unconfirmed',
  }));
  assert.equal((await f.host.resume()).status, 'suspended');
  f.host.policyChanged(true);
  f.host.reset();
  assert.equal((await f.host.resume()).status, 'suspended');
  assert.equal(f.host.snapshot().offer, null);
  await f.host.request({ kind: 'settings.update', field: 'appAssistEnabled', value: true }, async () => ({
    kind: 'settings-update',
    outcome: 'saved',
  }));
  assert.equal(f.host.snapshot().status, 'ready');
  await f.host.close();
});

test('settlement, expiry, stale refs and reload cannot resurrect an offer', async () => {
  const f = fixture();
  f.enable();
  await f.host.resume();
  await f.event();
  const first = f.host.snapshot();
  assert.equal(
    f.host.settle({ scopeRef: first.scopeRef, offerRef: 'wrong', action: 'dismiss' }).outcome,
    'stale_offer',
  );
  assert.deepEqual(f.host.snapshot(), first);
  assert.equal(
    f.host.settle({ scopeRef: first.scopeRef, offerRef: first.offer.offerRef, action: 'dismiss' }).outcome,
    'settled',
  );
  await f.event();
  assert.equal(f.host.snapshot().offer, null);
  await f.event({ bundleId: 'org.fixture.other', name: 'Other' });
  assert.equal(f.host.snapshot().offer.appName, 'Other');
  f.advance();
  assert.equal(f.host.snapshot().offer, null);
  const scope = f.host.snapshot().scopeRef;
  f.host.reset();
  assert.notEqual(f.host.snapshot().scopeRef, scope);
  await f.host.resume();
  await f.event();
  assert.equal(f.host.snapshot().offer, null);
  await f.host.close();
});

test('disable, source loss and hide stop collection; late claims cannot publish', async () => {
  const f = fixture();
  f.enable();
  await f.host.resume();
  f.host.policyChanged(false);
  assert.equal(f.host.snapshot().offer, null);
  assert.notEqual(f.host.snapshot().status, 'ready');
  await f.event();
  assert.equal(f.claims.size, 0);
  await f.host.resume();
  f.lose();
  assert.equal(f.host.snapshot().status, 'source_unavailable');
  await f.host.resume();
  await f.host.suspend();
  assert.equal(f.host.snapshot().status, 'suspended');
  await f.host.close();
  assert.ok(f.stops() >= 2);
});

test('trusted projection rejects extra fields, invalid identity and self without persisting or logging content', async () => {
  const f = fixture();
  f.enable();
  await f.host.resume();
  for (const event of [
    { bundleId: 'ai.fixture.cat-cafe', name: 'Self' },
    { bundleId: '', name: 'Missing' },
    { bundleId: 'org.fixture.editor', name: 'bad\nname' },
    { bundleId: 'org.fixture.editor', name: 'Fixture', title: 'Forbidden' },
  ])
    await f.event(event);
  assert.equal(f.claims.size, 0);
  assert.equal(f.host.snapshot().offer, null);
  await f.host.close();
});
