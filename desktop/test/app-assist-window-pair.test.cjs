const assert = require('node:assert/strict');
const { resolve } = require('node:path');
const test = require('node:test');
const { createAppAssistHost } = require('../plugin-window/app-assist-host.cjs');
// Cross-writer staging is a test input only; production always uses its own fixed Host tree.
const windowRoot = process.env.F317_WINDOW_WRITER_ROOT || resolve(__dirname, '../..');
const { createManagedWindow } = require(resolve(windowRoot, 'desktop/plugin-window/window.cjs'));
const { fixture, input } = require(resolve(windowRoot, 'desktop/plugin-window/window-motion-fixture.cjs'));
const flush = () => new Promise((done) => setImmediate(done));

function appAssistFixture() {
  let observe;
  let starts = 0;
  let stops = 0;
  const host = createAppAssistHost({
    selfBundleIds: ['ai.fixture.self'],
    owner: { read: async () => ({ status: 'ready', keyScope: 'fixture-owner' }), claim: async () => 'claimed' },
    sourceFactory: async (onEvent) => {
      starts++;
      observe = onEvent;
      return { close: async () => stops++ };
    },
  });
  return {
    host,
    event: (value) => observe(value),
    starts: () => starts,
    stops: () => stops,
  };
}

test('actual window with the actual app-assist Host stays stopped on show while locked and resumes after unlock', async () => {
  const f = fixture();
  let starts = 0;
  const host = createAppAssistHost({
    selfBundleIds: ['ai.fixture.self'],
    owner: { read: async () => ({ status: 'ready', keyScope: 'fixture-owner' }), claim: async () => 'claimed' },
    sourceFactory: async () => {
      starts++;
      return { close: async () => {} };
    },
  });
  const managed = await createManagedWindow(
    f.electron,
    { ...input, publicCompanionV2: true, companionContract: '0.1.0-beta.29' },
    {
      appAssist: host,
      validate: () => true,
      request: async () => ({ kind: 'state', phase: 'idle', behaviorEnabled: true }),
    },
  );
  try {
    assert.equal(host.snapshot().status, 'ready');
    assert.equal(starts, 1);
    f.electron.powerMonitor.emit('lock-screen');
    await flush();
    assert.equal(host.snapshot().status, 'suspended');
    f.win.emit('show');
    await flush();
    assert.equal(host.snapshot().status, 'suspended', 'a native show event must not override the lock suspension');
    assert.equal(starts, 1);
    f.electron.powerMonitor.emit('unlock-screen');
    await flush();
    assert.equal(host.snapshot().status, 'ready');
    assert.equal(starts, 2);
  } finally {
    managed.close();
    await host.close();
  }
});

test('a timely all-workspaces hide handoff preserves the active offer while a persistent hide suspends it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  const assist = appAssistFixture();
  const managed = await createManagedWindow(
    f.electron,
    { ...input, publicCompanionV2: true, companionContract: '0.1.0-beta.29' },
    {
      appAssist: assist.host,
      validate: () => true,
      request: async () => ({ kind: 'state', phase: 'idle', behaviorEnabled: true }),
    },
  );
  try {
    await assist.event({ bundleId: 'org.fixture.editor', name: 'Fixture Editor' });
    const offer = assist.host.snapshot().offer;
    assert.ok(offer);

    f.win.emit('hide');
    await flush();
    assert.equal(assist.host.snapshot().status, 'ready');
    assert.deepEqual(assist.host.snapshot().offer, offer);
    assert.equal(assist.stops(), 0);

    t.mock.timers.tick(545);
    f.win.emit('show');
    await flush();
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(assist.host.snapshot().status, 'ready');
    assert.deepEqual(assist.host.snapshot().offer, offer);
    assert.equal(assist.starts(), 1);
    assert.equal(assist.stops(), 0);

    f.win.emit('hide');
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(assist.host.snapshot().status, 'suspended');
    assert.equal(assist.host.snapshot().offer, null);
    assert.equal(assist.stops(), 1);
  } finally {
    managed.close();
    await assist.host.close();
  }
});

test('an explicit hide gesture still suspends app assistance immediately', async () => {
  const f = fixture();
  const assist = appAssistFixture();
  const managed = await createManagedWindow(
    f.electron,
    { ...input, publicCompanionV2: true, companionContract: '0.1.0-beta.29' },
    {
      appAssist: assist.host,
      validate: () => true,
      request: async () => ({ kind: 'state', phase: 'idle', behaviorEnabled: true }),
    },
  );
  try {
    await assist.event({ bundleId: 'org.fixture.editor', name: 'Fixture Editor' });
    assert.ok(assist.host.snapshot().offer);
    assert.equal((await f.request({ kind: 'view.hide' }, true)).kind, 'ok');
    await flush();
    assert.equal(assist.host.snapshot().status, 'suspended');
    assert.equal(assist.host.snapshot().offer, null);
    assert.equal(assist.stops(), 1);
  } finally {
    managed.close();
    await assist.host.close();
  }
});

test('an actual app hide still suspends app assistance immediately', async () => {
  const f = fixture();
  const assist = appAssistFixture();
  let appHidden = false;
  f.electron.app.isHidden = () => appHidden;
  const managed = await createManagedWindow(
    f.electron,
    { ...input, publicCompanionV2: true, companionContract: '0.1.0-beta.29' },
    {
      appAssist: assist.host,
      validate: () => true,
      request: async () => ({ kind: 'state', phase: 'idle', behaviorEnabled: true }),
    },
  );
  try {
    await assist.event({ bundleId: 'org.fixture.editor', name: 'Fixture Editor' });
    assert.ok(assist.host.snapshot().offer);
    appHidden = true;
    f.win.emit('hide');
    await flush();
    assert.equal(assist.host.snapshot().status, 'suspended');
    assert.equal(assist.host.snapshot().offer, null);
    assert.equal(assist.stops(), 1);
  } finally {
    managed.close();
    await assist.host.close();
  }
});
