const assert = require('node:assert/strict');
const test = require('node:test');
const { createCompanionController } = require('./companion-controller.cjs');
const ready = { kind: 'state', phase: 'ready' };
function fixture(request = async () => ready) {
  const events = [],
    calls = [];
  let reloads = 0;
  const controller = createCompanionController({
    request: (command) => {
      calls.push(command.kind);
      return request(command);
    },
    publish: (event) => events.push(event),
    resize() {},
    stopCapture: () => reloads++,
  });
  return {
    controller,
    events,
    calls,
    get reloads() {
      return reloads;
    },
  };
}

test('a state observation begun before preparation cannot revoke the new voice session', async () => {
  let finish;
  const f = fixture((command) =>
    command.kind === 'state'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(ready),
  );
  const oldState = f.controller.request({ kind: 'state' });
  await f.controller.request({ kind: 'prepare' }, true);
  finish({ kind: 'state', phase: 'idle' });
  await oldState;
  assert.equal(f.controller.armed, true);
  assert.ok(!f.calls.includes('stop'));
  assert.equal(f.events.length, 0);
});

test('voice-only revocation stops media without reloading away the visible failure and draft', async () => {
  const f = fixture();
  await f.controller.request({ kind: 'prepare' }, true);
  f.controller.suspend('closed');
  assert.equal(f.controller.armed, false);
  assert.equal(f.events.at(-1).kind, 'media-stopped');
  assert.equal(f.reloads, 0);
});

test('a screen picker grant forces capture revocation even when the package claims it closed the screen', async () => {
  const f = fixture();
  await f.controller.request({ kind: 'prepare' }, true);
  await f.controller.request({ kind: 'screen.pick' }, true);
  await f.controller.request({ kind: 'screen.close' });
  await f.controller.request({ kind: 'stop' });
  assert.equal(f.reloads, 1);
  assert.equal(f.controller.display('display-capture'), false);
});

test('a late screen-open failure cannot revoke a later independently activated call', async () => {
  let finish;
  const f = fixture((command) =>
    command.kind === 'screen.open'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(ready),
  );
  await f.controller.request({ kind: 'prepare' }, true);
  const selection = await f.controller.request({ kind: 'screen.pick' }, true);
  const opening = f.controller.request({ kind: 'screen.open', selectionId: selection.selectionId, label: 'Window' });
  await f.controller.request({ kind: 'stop' });
  await f.controller.request({ kind: 'prepare' }, true);
  const before = f.calls.filter((c) => c === 'stop').length;
  finish({ kind: 'error', code: 'unavailable' });
  await opening;
  assert.equal(f.controller.armed, true);
  assert.equal(f.calls.filter((c) => c === 'stop').length, before);
});

test('stopping voice preserves an already accepted text receipt and an independent history read', async () => {
  for (const kind of ['text', 'conversation.read']) {
    let finish;
    const f = fixture((command) =>
      command.kind === kind
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(ready),
    );
    await f.controller.request({ kind: 'prepare' }, true);
    const pending = f.controller.request({ kind, text: '一句', clientMessageId: 'same-id' }, true);
    await f.controller.request({ kind: 'stop' });
    const reply =
      kind === 'text'
        ? { kind: 'delivery', delivery: 'accepted' }
        : { kind: 'conversation', messages: [], hasMore: false };
    finish(reply);
    assert.deepEqual(await pending, reply, kind);
    assert.equal(f.controller.armed, false);
  }
});
