const assert = require('node:assert/strict');
const test = require('node:test');
const { createManagedWindow } = require('./window.cjs');
const { fixture, input } = require('./window-motion-fixture.cjs');

function deskFixture() {
  const calls = { visible: [], requests: [] };
  const snapshot = { scopeRef: 'desk-scope', revision: 3, status: 'ready', delivery: null };
  return {
    calls,
    snapshot,
    host: {
      snapshot: () => snapshot,
      setVisible: (value) => calls.visible.push(value),
      request: async (command) => {
        calls.requests.push(command.kind);
        return {
          kind: 'desk-settlement',
          scopeRef: 'desk-scope',
          revision: 4,
          deliveryRef: 'd',
          action: 'shown',
          outcome: 'settled',
        };
      },
    },
  };
}

test('F335 desk: state carries the desk snapshot; desk commands go to the desk, never the ordinary owner', async () => {
  const f = fixture();
  const desk = deskFixture();
  const forwarded = [];
  const managed = await createManagedWindow(
    f.electron,
    { ...input, publicCompanionV2: true, companionContract: '0.3.3-candidate.0' },
    {
      desk: desk.host,
      validate: () => true,
      request: async (command) => {
        forwarded.push(command.kind);
        if (command.kind === 'state') return { kind: 'state', phase: 'idle', behaviorEnabled: true };
        return { kind: 'ok' };
      },
    },
  );
  try {
    const state = await f.request({ kind: 'state' });
    assert.deepEqual(state.desk, desk.snapshot);
    for (const kind of ['desk.settle', 'desk.thumbnail.read', 'desk.avatar.read']) {
      await f.request({ kind, scopeRef: 'desk-scope', deliveryRef: 'd', action: 'shown' }, true);
    }
    assert.deepEqual(desk.calls.requests, ['desk.settle', 'desk.thumbnail.read', 'desk.avatar.read']);
    assert.equal(
      forwarded.some((kind) => kind.startsWith('desk.')),
      false,
      'desk commands never reach the API bridge',
    );
    f.win.emit('hide');
    f.win.emit('show');
    managed.poll();
    assert.ok(desk.calls.visible.length >= 2, 'visibility follows the window');
  } finally {
    managed.close();
  }
});

test('F335 desk: an archive whose contract has no desk never carries one, even when a host is offered', async () => {
  const f = fixture();
  const desk = deskFixture();
  const managed = await createManagedWindow(
    f.electron,
    { ...input, publicCompanionV2: true, companionContract: '0.1.0-beta.29' },
    {
      desk: desk.host,
      validate: () => true,
      request: async (command) =>
        command.kind === 'state' ? { kind: 'state', phase: 'idle', behaviorEnabled: true } : { kind: 'ok' },
    },
  );
  try {
    const state = await f.request({ kind: 'state' });
    assert.equal('desk' in state, false);
    managed.poll();
    assert.deepEqual(desk.calls.visible, [], 'the offered host is never driven');
  } finally {
    managed.close();
  }
});

test('F335 desk: without a desk host the state has no desk field', async () => {
  const f = fixture();
  const managed = await createManagedWindow(
    f.electron,
    { ...input, publicCompanionV2: true, companionContract: '0.1.0-beta.29' },
    {
      validate: () => true,
      request: async (command) =>
        command.kind === 'state' ? { kind: 'state', phase: 'idle', behaviorEnabled: true } : { kind: 'ok' },
    },
  );
  try {
    const state = await f.request({ kind: 'state' });
    assert.equal('desk' in state, false);
  } finally {
    managed.close();
  }
});
