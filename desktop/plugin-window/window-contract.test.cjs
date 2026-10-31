const assert = require('node:assert/strict');
const test = require('node:test');
const { createManagedWindow, toPublishedWindowReply, validateLaunch } = require('./window.cjs');
const { fixture, input, deferred } = require('./window-motion-fixture.cjs');

const launch = {
  url: `http://companion-${'a'.repeat(32)}.localhost:4187/packages/fixture/assets/body/index.html`,
  presentation: { width: 320, height: 350, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true },
  publicCompanionV2: true,
};
const legacy = '0.1.0-beta.21';
const modern = '0.1.0-beta.23';
const unified = '0.1.0-beta.24';

test('the trusted launch retains its exact companion contract instead of inferring ABI from a bridge version', () => {
  for (const contract of [
    legacy,
    modern,
    unified,
    '0.1.0-beta.25',
    '0.1.0-beta.27',
    '0.1.0-beta.28',
    '0.1.0-beta.29',
  ]) {
    const admitted = validateLaunch({ ...launch, companionContract: contract });
    assert.equal(admitted.companionContract, contract);
    assert.equal(admitted.publicCompanionV2, true);
  }
});

test('unknown contracts and a contract without verified public archive admission are refused', () => {
  for (const contract of ['1.3.0', '0.1.0-beta.22', null, 23]) {
    assert.throws(() => validateLaunch({ ...launch, companionContract: contract }));
  }
  const { publicCompanionV2: _notAdmitted, ...unpaired } = launch;
  assert.throws(() => validateLaunch({ ...unpaired, companionContract: modern }));
});

test('the modern renderer receives the required persisted behavior flag while legacy strips the private extra', () => {
  for (const behaviorEnabled of [true, false]) {
    const state = { kind: 'state', phase: 'idle', behaviorEnabled };
    assert.deepEqual(toPublishedWindowReply(state, modern), state);
    assert.deepEqual(toPublishedWindowReply(state, unified), state);
    assert.deepEqual(toPublishedWindowReply(state, '0.1.0-beta.25'), state);
    assert.deepEqual(toPublishedWindowReply(state, '0.1.0-beta.27'), state);
    assert.deepEqual(toPublishedWindowReply(state, '0.1.0-beta.28'), state);
    assert.deepEqual(toPublishedWindowReply(state, '0.1.0-beta.29'), state);
    assert.deepEqual(toPublishedWindowReply(state, legacy), { kind: 'state', phase: 'idle' });
    assert.deepEqual(toPublishedWindowReply(state), { kind: 'state', phase: 'idle' });
    assert.equal(state.behaviorEnabled, behaviorEnabled, 'conversion must not mutate the trusted Host reply');
  }
});

function appAssistFixture() {
  const calls = [];
  const snapshot = {
    scopeRef: 'fixture-view-a',
    revision: 4,
    status: 'ready',
    offer: { offerRef: 'fixture-offer-a', appName: 'Fixture Writer' },
  };
  const host = {
    async reset() {
      calls.push('reset');
    },
    async resume() {
      calls.push('resume');
    },
    async suspend() {
      calls.push('suspend');
    },
    async close() {
      calls.push('close');
    },
    snapshot: () => ({ ...snapshot, offer: { ...snapshot.offer } }),
    async request(command, forward) {
      calls.push(`request:${command.kind}`);
      if (command.kind === 'app-assist.settle')
        return {
          kind: 'app-assist-settlement',
          scopeRef: command.scopeRef,
          revision: 5,
          offerRef: command.offerRef,
          action: command.action,
          outcome: 'settled',
        };
      return forward(command);
    },
  };
  return { host, calls, snapshot };
}

test('beta.29 binds one optional Host offer owner to page, request, state and visibility lifecycles', async () => {
  const f = fixture();
  const appAssist = appAssistFixture();
  const forwarded = [];
  const managed = await createManagedWindow(
    f.electron,
    { ...input, publicCompanionV2: true, companionContract: '0.1.0-beta.29' },
    {
      appAssist: appAssist.host,
      validate: () => true,
      request: async (command) => {
        forwarded.push(command.kind);
        if (command.kind === 'state') return { kind: 'state', phase: 'idle', behaviorEnabled: true };
        if (command.kind === 'settings.update')
          return {
            kind: 'settings-update',
            field: command.field,
            outcome: 'saved',
            callStatus: 'unchanged',
            applies: 'now',
          };
        return { kind: 'ok' };
      },
    },
  );
  try {
    assert.deepEqual(appAssist.calls.slice(0, 2), ['reset', 'resume']);
    const state = await f.request({ kind: 'state' });
    assert.deepEqual(state.appAssist, appAssist.snapshot);

    const settlement = await f.request(
      {
        kind: 'app-assist.settle',
        scopeRef: 'fixture-view-a',
        offerRef: 'fixture-offer-a',
        action: 'accept',
      },
      true,
    );
    assert.equal(settlement.kind, 'app-assist-settlement');
    assert.equal(forwarded.includes('app-assist.settle'), false, 'settlement never enters the ordinary request owner');

    await f.request({ kind: 'settings.update', field: 'appAssistEnabled', value: false }, true);
    assert.equal(forwarded.includes('settings.update'), true, 'the Host wrapper preserves the canonical setting owner');

    f.win.webContents.emit('did-start-loading');
    f.win.webContents.emit('did-finish-load');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      appAssist.calls.filter((value) => value === 'reset').length,
      2,
      'a trusted page reload rotates the transient scope once',
    );
    assert.equal(appAssist.calls.filter((value) => value === 'resume').length >= 2, true);

    await f.request({ kind: 'view.hide' }, true);
    assert.equal(appAssist.calls.includes('suspend'), true);
    managed.show();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(appAssist.calls.at(-1), 'resume');
    f.electron.powerMonitor.emit('lock-screen');
    assert.equal(appAssist.calls.at(-1), 'suspend');
  } finally {
    managed.close();
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(appAssist.calls.at(-1), 'close');
});

test('beta.29 app assist waits for every native pause reason before it resumes', async () => {
  const f = fixture();
  const appAssist = appAssistFixture();
  const managed = await createManagedWindow(
    f.electron,
    { ...input, publicCompanionV2: true, companionContract: '0.1.0-beta.29' },
    {
      appAssist: appAssist.host,
      validate: () => true,
      request: async (command) =>
        command.kind === 'settings.update'
          ? { kind: 'settings-update', field: command.field, outcome: 'saved', callStatus: 'unchanged', applies: 'now' }
          : { kind: 'state', phase: 'idle', behaviorEnabled: true },
    },
  );
  try {
    f.electron.powerMonitor.emit('lock-screen');
    f.electron.powerMonitor.emit('suspend');
    const resumesWhilePaused = appAssist.calls.filter((value) => value === 'resume').length;

    managed.show();
    f.win.emit('show');
    f.win.webContents.emit('did-start-loading');
    f.win.webContents.emit('did-finish-load');
    await f.request({ kind: 'settings.update', field: 'appAssistEnabled', value: true }, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      appAssist.calls.filter((value) => value === 'resume').length,
      resumesWhilePaused,
      'show, reload and a saved setting cannot cross outstanding power boundaries',
    );

    f.electron.powerMonitor.emit('unlock-screen');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
      appAssist.calls.filter((value) => value === 'resume').length,
      resumesWhilePaused,
      'unlocking cannot cross an outstanding system suspend',
    );

    f.electron.powerMonitor.emit('resume');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(appAssist.calls.filter((value) => value === 'resume').length, resumesWhilePaused + 1);
  } finally {
    managed.close();
  }
});

test('older exact pairs ignore an accidentally supplied app-assist owner', async () => {
  const f = fixture();
  const appAssist = appAssistFixture();
  const managed = await createManagedWindow(
    f.electron,
    { ...input, publicCompanionV2: true, companionContract: '0.1.0-beta.28' },
    {
      appAssist: appAssist.host,
      validate: () => true,
      request: async () => ({ kind: 'state', phase: 'idle', behaviorEnabled: true }),
    },
  );
  try {
    assert.equal(Object.hasOwn(await f.request({ kind: 'state' }), 'appAssist'), false);
    f.electron.powerMonitor.emit('lock-screen');
    f.electron.powerMonitor.emit('suspend');
    f.electron.powerMonitor.emit('unlock-screen');
    f.electron.powerMonitor.emit('resume');
    f.win.emit('show');
    f.win.webContents.emit('did-start-loading');
    f.win.webContents.emit('did-finish-load');
    managed.show();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(appAssist.calls, []);
  } finally {
    managed.close();
  }
});

test('contract conversion preserves non-state receipt identity and settlement', () => {
  const receipt = {
    kind: 'settings-update',
    field: 'behaviorEnabled',
    outcome: 'unconfirmed',
    callStatus: 'stopped',
    reconcile: 'settings.read',
  };
  assert.equal(toPublishedWindowReply(receipt, modern), receipt);
});

test('disabling the current companion requires both activation and the trusted Host confirmation', async () => {
  const f = fixture();
  let prompts = 0;
  let disables = 0;
  f.electron.dialog = {
    showMessageBox: async () => {
      prompts++;
      return { response: 0 };
    },
  };
  const managed = await createManagedWindow(
    f.electron,
    { ...input, publicCompanionV2: true, companionContract: modern },
    {
      validate: () => true,
      request: async (command) => {
        if (command.kind === 'companion.disable') disables++;
        return { kind: 'companion-lifecycle', action: 'disable', outcome: 'disabled' };
      },
    },
  );
  try {
    assert.equal((await f.request({ kind: 'companion.disable' })).code, 'permission_required');
    assert.equal(prompts, 0);
    assert.deepEqual(await f.request({ kind: 'companion.disable' }, true), { kind: 'error', code: 'cancelled' });
    assert.equal(prompts, 1);
    assert.equal(disables, 0);
  } finally {
    managed.close();
  }
});

test('a stale confirmation after lock cannot disable the companion or renew its authority', async () => {
  const f = fixture();
  const answer = deferred();
  let disables = 0;
  f.electron.dialog = { showMessageBox: async () => answer.promise };
  const managed = await createManagedWindow(
    f.electron,
    { ...input, publicCompanionV2: true, companionContract: modern },
    {
      validate: () => true,
      request: async (command) => {
        if (command.kind === 'companion.disable') disables++;
        return { kind: 'ok' };
      },
    },
  );
  try {
    const pending = f.request({ kind: 'companion.disable' }, true);
    f.electron.powerMonitor.emit('lock-screen');
    answer.resolve({ response: 1 });
    assert.equal((await pending).code, 'cancelled');
    assert.equal(disables, 0);
  } finally {
    managed.close();
  }
});
