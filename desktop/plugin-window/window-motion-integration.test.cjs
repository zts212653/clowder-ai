const assert = require('node:assert/strict');
const test = require('node:test');
const { createManagedWindow } = require('./window.cjs');

const { input, fixture, open, deferred } = require('./window-motion-fixture.cjs');

test('a late enabled state cannot override a newer disabled preference', async (t) => {
  const f = fixture();
  const old = deferred();
  let reads = 0;
  const managed = await createManagedWindow(f.electron, input, {
    validate: () => true,
    request: async () => (++reads === 1 ? old.promise : { kind: 'state', phase: 'idle', behaviorEnabled: false }),
  });
  t.after(() => managed.close());
  const first = f.request({ kind: 'state' });
  await f.request({ kind: 'state' });
  old.resolve({ kind: 'state', phase: 'idle', behaviorEnabled: true });
  await first;
  assert.equal(managed.motionLease(), null);
});

test('lock and suspend reject old state replies and require a fresh read after both resume', async (t) => {
  const f = fixture();
  const old = deferred();
  let reads = 0;
  const managed = await createManagedWindow(f.electron, input, {
    validate: () => true,
    request: async (command) =>
      command.kind === 'state'
        ? ++reads === 2
          ? old.promise
          : { kind: 'state', phase: 'idle', behaviorEnabled: true }
        : { kind: 'ok' },
  });
  t.after(() => managed.close());
  await f.request({ kind: 'state' });
  const first = managed.motionLease();
  const late = f.request({ kind: 'state' });
  f.electron.powerMonitor.emit('lock-screen');
  f.electron.powerMonitor.emit('suspend');
  assert.equal(first.signal.aborted, true);
  f.electron.powerMonitor.emit('unlock-screen');
  await f.request({ kind: 'state' });
  assert.equal(managed.motionLease(), null, 'resume of one boundary cannot undo the other');
  f.electron.powerMonitor.emit('resume');
  old.resolve({ kind: 'state', phase: 'idle', behaviorEnabled: true });
  await late;
  assert.equal(managed.motionLease(), null, 'a pre-boundary read cannot arm after resume');
  await f.request({ kind: 'state' });
  assert.ok(managed.motionLease().generation > first.generation);
  assert.equal((await f.request({ kind: 'screen.pick' }, true)).code, 'permission_required');
  managed.close();
  for (const event of ['lock-screen', 'unlock-screen', 'suspend', 'resume'])
    assert.equal(f.electron.powerMonitor.listenerCount(event), 0);
});

test('a preference mutation begun before lock cannot arm movement from its late state after unlock', async (t) => {
  const f = fixture();
  const old = deferred();
  const managed = await createManagedWindow(f.electron, input, {
    validate: () => true,
    request: async (command) =>
      command.kind === 'documents'
        ? old.promise
        : command.kind === 'state'
          ? { kind: 'state', phase: 'idle', behaviorEnabled: true }
          : { kind: 'ok' },
  });
  t.after(() => managed.close());
  await f.request({ kind: 'state' });
  const first = managed.motionLease();
  const changing = f.request({ kind: 'documents', allowed: false }, true);
  f.electron.powerMonitor.emit('lock-screen');
  f.electron.powerMonitor.emit('unlock-screen');
  old.resolve({ kind: 'state', phase: 'idle', behaviorEnabled: true });
  await changing;
  assert.equal(first.signal.aborted, true);
  assert.equal(managed.motionLease(), null);
  await f.request({ kind: 'state' });
  assert.ok(managed.motionLease().generation > first.generation);
});

test('missing or malformed persisted preference fails closed even after media preparation', async (t) => {
  const f = fixture();
  let flag = true;
  const managed = await createManagedWindow(f.electron, input, {
    validate: () => true,
    request: async () => ({ kind: 'state', phase: 'ready', behaviorEnabled: flag }),
  });
  t.after(() => managed.close());
  await f.request({ kind: 'prepare' }, true);
  for (const unknown of [undefined, 'true', 1, null, false]) {
    const previous = managed.motionLease();
    flag = unknown;
    await f.request({ kind: 'state', behaviorEnabled: true });
    assert.equal(managed.motionLease(), null, 'renderer input and media readiness cannot replace Host truth');
    if (previous) assert.equal(previous.signal.aborted, true);
    flag = true;
    await f.request({ kind: 'state' });
    assert.ok(managed.motionLease());
  }
});

test('an unavailable preference read revokes the current movement lease', async (t) => {
  const f = fixture();
  let available = true;
  const managed = await createManagedWindow(f.electron, input, {
    validate: () => true,
    request: async () =>
      available ? { kind: 'state', phase: 'idle', behaviorEnabled: true } : { kind: 'error', code: 'unavailable' },
  });
  t.after(() => managed.close());
  await f.request({ kind: 'state' });
  const previous = managed.motionLease();
  available = false;
  await f.request({ kind: 'state' });
  assert.equal(previous.signal.aborted, true);
  assert.equal(managed.motionLease(), null);
});

test('settings geometry survives concurrent state polling but rejects an older settings read', async (t) => {
  const f = fixture();
  const old = deferred();
  const latest = deferred();
  let reads = 0;
  const managed = await createManagedWindow(f.electron, input, {
    validate: () => true,
    request: async (command) =>
      command.kind === 'settings.read'
        ? ++reads === 1
          ? old.promise
          : latest.promise
        : { kind: 'state', phase: 'idle', behaviorEnabled: true },
  });
  t.after(() => managed.close());
  const first = f.request({ kind: 'settings.read' });
  const second = f.request({ kind: 'settings.read' });
  await f.request({ kind: 'state' });
  latest.resolve({ kind: 'settings', status: 'available', values: { ballSize: 192 } });
  await second;
  old.resolve({ kind: 'settings', status: 'available', values: { ballSize: 48 } });
  await first;
  const layout = await f.request({ kind: 'view.layout', panel: 'none', width: 120, height: 130 });
  assert.ok(layout.pet.x + 320 <= f.win.getBounds().width, 'polling cannot starve settings geometry');
});

test('persisted autonomous preference arms native movement without preparing media', async (t) => {
  const f = fixture();
  let behaviorEnabled = true;
  const commands = [];
  const managed = await createManagedWindow(f.electron, input, {
    validate: () => true,
    request: async (command) => {
      commands.push(command);
      if (command.kind === 'state')
        return {
          kind: 'state',
          phase: 'idle',
          behaviorEnabled,
        };
      return { kind: 'ok' };
    },
  });
  t.after(() => managed.close());

  assert.equal(managed.motionLease(), null);
  assert.equal(
    'behaviorEnabled' in (await f.request({ kind: 'state' })),
    false,
    'native-only policy stays off the legacy renderer reply',
  );
  const first = managed.motionLease();
  assert.ok(first, 'visible installed cat can move while media remains unprepared');
  assert.equal(
    commands.some((command) => command.kind === 'prepare' || command.kind === 'offer'),
    false,
  );

  behaviorEnabled = false;
  await f.request({ kind: 'state' });
  assert.equal(first.signal.aborted, true, 'switching the persisted preference off cancels immediately');
  assert.equal(managed.motionLease(), null);

  behaviorEnabled = true;
  await f.request({ kind: 'state' });
  const second = managed.motionLease();
  assert.ok(second && second.generation > first.generation);
  assert.equal(
    commands.some((command) => command.kind === 'prepare' || command.kind === 'offer'),
    false,
    're-enabling movement never arms microphone or screen authority',
  );

  const layout = await f.request({ kind: 'view.layout', panel: 'settings', width: 360, height: 420 });
  assert.equal(layout.kind, 'layout');
  assert.equal(second.signal.aborted, true, 'opening an interactive panel cancels autonomous movement');
  await f.request({ kind: 'view.layout', panel: 'none', width: 120, height: 130 });
  const third = managed.motionLease();
  assert.ok(third && third.generation > second.generation);
  f.setReducedMotion(true);
  assert.equal(third.moveTo({ x: 500, y: 300 }).status, 'reduced_motion');
  assert.equal(managed.motionLease(), null);
});

test('trusted settings read updates native ball geometry while renderer layout stays selector-free', async (t) => {
  const f = fixture();
  const managed = await createManagedWindow(f.electron, input, {
    validate: () => true,
    request: async (command) =>
      command.kind === 'settings.read'
        ? {
            kind: 'settings',
            status: 'available',
            values: {
              dutyCatProfileId: 'fable-5',
              skin: 'xianxian-codex',
              ballSize: 192,
              behaviorEnabled: false,
              proactivePolicy: 'ambient',
              personaTone: '温暖',
              householdReadsAllowed: true,
            },
            companions: [{ catProfileId: 'fable-5', displayName: '宪宪', available: true }],
            selectedCompanionStatus: 'available',
          }
        : { kind: 'ok' },
  });
  t.after(() => managed.close());

  assert.equal((await f.request({ kind: 'settings.read' })).values.ballSize, 192);
  const layout = await f.request({ kind: 'view.layout', panel: 'none', width: 120, height: 130 });
  const native = f.win.getBounds();
  assert.ok(layout.pet.x + 320 <= native.width);
  assert.ok(layout.pet.y + 347 <= native.height);
  assert.ok(native.width >= 440, 'scaled living art is part of the occupied native surface');
});

test('media stop preserves the persisted movement preference; reduced motion revokes it', async (t) => {
  const f = fixture();
  const managed = await open(f);
  t.after(() => managed.close());
  assert.equal(managed.motionLease(), null);
  await f.request({ kind: 'prepare' }, true);
  const first = managed.motionLease();
  assert.ok(first);
  assert.equal(first.moveTo({ x: 700, y: 400 }).status, 'moved');
  await f.request({ kind: 'stop' }, true);
  assert.equal(first.signal.aborted, false, 'stop affects media authority only');
  assert.equal(managed.motionLease(), first);
  f.setReducedMotion(true);
  assert.equal(first.moveTo({ x: 500, y: 300 }).status, 'reduced_motion');
  f.setReducedMotion(false);
  await f.request({ kind: 'state' });
  const second = managed.motionLease();
  assert.ok(second.generation > first.generation);
  f.setReducedMotion(true);
  assert.equal(second.moveTo({ x: 500, y: 300 }).status, 'reduced_motion');
  assert.equal(second.signal.aborted, true);
  assert.equal(managed.motionLease(), null);
});

test('manual drag and an open panel stop travel before another target applies', async (t) => {
  const f = fixture();
  const managed = await open(f);
  t.after(() => managed.close());
  await f.request({ kind: 'prepare' }, true);
  const none = await f.request({ kind: 'view.layout', panel: 'none', width: 120, height: 130 });
  const bounds = f.win.getBounds();
  f.setCursor({ x: bounds.x + none.pet.x + 20, y: bounds.y + none.pet.y + 20 });
  const first = managed.motionLease();
  assert.equal((await f.request({ kind: 'view.drag', phase: 'start' }, true)).kind, 'ok');
  assert.equal(first.signal.aborted, true);
  assert.equal(first.moveTo({ x: 500, y: 300 }).status, 'cancelled');
  assert.equal((await f.request({ kind: 'view.drag', phase: 'end' }, true)).kind, 'ok');
  const second = managed.motionLease();
  assert.ok(second.generation > first.generation);
  await f.request({ kind: 'view.layout', panel: 'bubble', width: 240, height: 80 });
  assert.equal(second.signal.aborted, true);
  assert.equal(managed.motionLease(), null);
  await f.request({ kind: 'view.layout', panel: 'none', width: 120, height: 130 });
  assert.ok(managed.motionLease().generation > second.generation);
});
