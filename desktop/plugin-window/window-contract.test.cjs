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
  for (const contract of [legacy, modern, unified]) {
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
    assert.deepEqual(toPublishedWindowReply(state, legacy), { kind: 'state', phase: 'idle' });
    assert.deepEqual(toPublishedWindowReply(state), { kind: 'state', phase: 'idle' });
    assert.equal(state.behaviorEnabled, behaviorEnabled, 'conversion must not mutate the trusted Host reply');
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
