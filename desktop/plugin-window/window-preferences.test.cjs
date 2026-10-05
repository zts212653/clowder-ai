const assert = require('node:assert/strict');
const test = require('node:test');
const { createManagedWindow } = require('./window.cjs');
const { fixture, input, deferred } = require('./window-motion-fixture.cjs');

for (const command of [
  { kind: 'settings.update', field: 'behaviorEnabled', value: false },
  { kind: 'companion.disable' },
]) {
  test(`${command.kind} fences overlapping and late state reads until a fresh post-settlement observation`, async (t) => {
    const f = fixture();
    f.electron.dialog = { showMessageBox: async () => ({ response: 1 }) };
    const mutation = deferred();
    const late = deferred();
    let reads = 0;
    const managed = await createManagedWindow(
      f.electron,
      { ...input, publicCompanionV2: true, companionContract: '0.1.0-beta.23' },
      {
        validate: () => true,
        request: async (request) =>
          request.kind === command.kind
            ? mutation.promise
            : request.kind === 'state' && ++reads === 3
              ? late.promise
              : { kind: 'state', phase: 'idle', behaviorEnabled: true },
      },
    );
    t.after(() => managed.close());
    await f.request({ kind: 'state' });
    assert.ok(managed.motionLease());
    const changing = f.request(command, true);
    assert.equal(managed.motionLease(), null);
    await f.request({ kind: 'state' });
    assert.equal(managed.motionLease(), null, 'polling the pre-save value cannot re-arm during mutation');
    const delayed = f.request({ kind: 'state' });
    mutation.resolve({ kind: 'error', code: 'unavailable' });
    await changing;
    late.resolve({ kind: 'state', phase: 'idle', behaviorEnabled: true });
    await delayed;
    assert.equal(managed.motionLease(), null, 'a read started before settlement remains fenced afterwards');
    await f.request({ kind: 'state' });
    assert.ok(managed.motionLease(), 'a failed mutation needs a genuinely fresh Host observation');
    assert.equal((await f.request({ kind: 'screen.pick' }, true)).code, 'permission_required');
  });
}

test('overlapping mutations retain the barrier until all settle; confirmed disable stays terminal', async (t) => {
  const f = fixture();
  f.electron.dialog = { showMessageBox: async () => ({ response: 1 }) };
  const update = deferred();
  const disable = deferred();
  const managed = await createManagedWindow(
    f.electron,
    { ...input, publicCompanionV2: true, companionContract: '0.1.0-beta.23' },
    {
      validate: () => true,
      request: async (command) =>
        command.kind === 'settings.update'
          ? update.promise
          : command.kind === 'companion.disable'
            ? disable.promise
            : { kind: 'state', phase: 'idle', behaviorEnabled: true },
    },
  );
  t.after(() => managed.close());
  await f.request({ kind: 'state' });
  const first = f.request({ kind: 'settings.update', field: 'behaviorEnabled', value: false }, true);
  const second = f.request({ kind: 'companion.disable' }, true);
  update.resolve({
    kind: 'settings-update',
    field: 'behaviorEnabled',
    outcome: 'saved',
    callStatus: 'unchanged',
    applies: 'now',
  });
  await first;
  await f.request({ kind: 'state' });
  assert.equal(managed.motionLease(), null);
  disable.resolve({ kind: 'companion-lifecycle', action: 'disable', outcome: 'disabled' });
  await second;
  await f.request({ kind: 'state' });
  assert.equal(managed.motionLease(), null, 'disabled window generation cannot recover movement from later reads');
});
