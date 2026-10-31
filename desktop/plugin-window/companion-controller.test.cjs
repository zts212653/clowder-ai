const assert = require('node:assert/strict');
const test = require('node:test');
const { createCompanionController } = require('./companion-controller.cjs');
const ready = { kind: 'state', phase: 'ready' };

test('unified decision navigation requires activation at the managed window boundary', async () => {
  const { fixture, input } = require('./window-motion-fixture.cjs');
  const { createManagedWindow } = require('./window.cjs');
  const f = fixture();
  const reached = [];
  const managed = await createManagedWindow(
    f.electron,
    { ...input, publicCompanionV2: true, companionContract: '0.1.0-beta.24' },
    {
      validate: () => true,
      request: async (command) => {
        reached.push(command.kind);
        return { kind: 'navigation', delivery: 'requested' };
      },
    },
  );
  try {
    for (const kind of ['conversation.open', 'decision.open']) {
      const command = kind === 'decision.open' ? { kind, variantRef: 'a'.repeat(64), target: 'origin' } : { kind };
      for (const activated of [false, undefined, 'true']) {
        assert.deepEqual(await f.request(command, activated), { kind: 'error', code: 'permission_required' });
        assert.deepEqual(reached, []);
      }
    }
    assert.deepEqual(await f.request({ kind: 'decision.open', variantRef: 'a'.repeat(64), target: 'origin' }, true), {
      kind: 'navigation',
      delivery: 'requested',
    });
    assert.deepEqual(reached, ['decision.open']);
  } finally {
    managed.close();
  }
});

test('settings writes and plugin disable require the trusted activation boundary', async () => {
  const calls = [];
  const controller = createCompanionController({
    request: async (command) => {
      calls.push(command);
      return { kind: 'ok' };
    },
    publish() {},
    resize() {},
  });
  for (const command of [
    { kind: 'settings.update', field: 'skin', value: 'xianxian-codex' },
    { kind: 'companion.disable' },
  ]) {
    assert.equal((await controller.request(command, false)).code, 'permission_required');
    assert.equal(calls.length, 0);
  }
  assert.equal(
    (await controller.request({ kind: 'settings.update', field: 'skin', value: 'xianxian-codex' }, true)).kind,
    'ok',
  );
  assert.equal(calls.length, 1);
  assert.equal(controller.armed, false);
  controller.close();
});

test('window creation and renderer calls grant no media until a real gesture and ready Host call', async () => {
  const calls = [];
  const controller = createCompanionController({
    request: async (value) => {
      calls.push(value);
      return ready;
    },
    publish() {},
    resize() {},
  });
  assert.equal(controller.armed, false);
  assert.deepEqual(await controller.request({ kind: 'prepare' }, false), {
    kind: 'error',
    code: 'permission_required',
  });
  assert.equal(calls.length, 0);
  await controller.request({ kind: 'prepare' }, true);
  assert.equal(controller.armed, true);
  assert.equal((await controller.request({ kind: 'prepare' }, true)).code, 'busy');
  assert.equal(controller.armed, true, 'a duplicate prepare cannot revoke an existing active voice');
  assert.equal(calls.length, 1);
  assert.equal(controller.display('media', []), false);
  assert.equal((await controller.request({ kind: 'screen.pick' }, false)).kind, 'error');
  const selection = await controller.request({ kind: 'screen.pick' }, true);
  assert.equal(selection.kind, 'selection');
  assert.equal(controller.display('media', []), true);
  assert.equal(
    (await controller.request({ kind: 'screen.open', selectionId: 'forged', label: 'Window' })).kind,
    'error',
  );
  await controller.request({ kind: 'screen.open', selectionId: selection.selectionId, label: 'Window' });
  assert.equal(controller.display('media', []), false);
  controller.suspend('locked');
  assert.equal(controller.armed, false);
  assert.equal(controller.display('media', []), false);
});

test('closing or stopping during prepare cannot rearm a late reply; preference changes stop captures', async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const events = [];
  const controller = createCompanionController({
    request: async (value) => (value.kind === 'prepare' ? pending : { kind: 'ok' }),
    publish: (value) => events.push(value),
    resize() {},
  });
  const preparing = controller.request({ kind: 'prepare' }, true);
  await controller.request({ kind: 'stop' });
  finish(ready);
  assert.equal((await preparing).code, 'cancelled');
  assert.equal(controller.armed, false);
  await controller.request({ kind: 'prepare' }, true);
  assert.equal(controller.armed, true);
  assert.equal((await controller.request({ kind: 'documents', allowed: false }, false)).kind, 'error');
  assert.equal(controller.armed, true);
  await controller.request({ kind: 'documents', allowed: false }, true);
  assert.equal(controller.armed, false);
  controller.close();
  assert.equal((await controller.request({ kind: 'prepare' }, true)).kind, 'error');
  assert.equal(events.at(-1).reason, 'closed');
});
