// F336 Phase C U3/U4: the Host window group. One cat, a panel window that always exists and a
// living body window only in living mode. Identity and lifecycle belong to the group, not a window.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createCompanionGroup } = require('./companion-group.cjs');

const origin = `http://companion-${'a'.repeat(32)}.localhost:4187/packages/fixture`;
const panelUrl = `${origin}/assets/body/index.html`;
const bodyUrl = `${origin}/assets/body/body.html`;

class FakeWindow extends EventEmitter {
  constructor(url) {
    super();
    this.visible = true;
    this.destroyed = false;
    this.shows = 0;
    this.webContents = new EventEmitter();
    this.webContents.mainFrame = { url };
  }
  isDestroyed() {
    return this.destroyed;
  }
  isVisible() {
    return this.visible;
  }
  showInactive() {
    this.visible = true;
    this.shows++;
  }
  hide() {
    this.visible = false;
    this.emit('hide');
  }
  destroy() {
    this.destroyed = true;
    this.emit('closed');
  }
}

function fixture({ body } = {}) {
  const handlers = new Map();
  const calls = { handle: 0, removeHandler: 0, revoke: [], failures: [], closed: 0, panel: [], body: [] };
  const ipcMain = {
    handle(name, handler) {
      if (name === 'companion:request') calls.handle++;
      handlers.set(name, handler);
    },
    removeHandler(name) {
      if (name === 'companion:request') calls.removeHandler++;
      handlers.delete(name);
    },
  };
  const panel = new FakeWindow(panelUrl);
  const group = createCompanionGroup({
    ipcMain,
    panel: { win: panel, url: panelUrl },
    routes: {
      panel: (_event, command) => {
        calls.panel.push(command.kind);
        return { kind: 'ok' };
      },
      ...(body ? { body } : {}),
    },
    onRevoke: (reason) => calls.revoke.push(reason),
    onFailure: (reason) => calls.failures.push(reason),
    onClosed: () => calls.closed++,
  });
  const from = (win, frame = win.webContents.mainFrame) => ({ sender: win.webContents, senderFrame: frame });
  const request = (win, command, frame) => handlers.get('companion:request')(from(win, frame), command, true);
  return { group, panel, handlers, calls, request, from };
}
const recorder = (seen, pick) => (sender, command) => {
  seen.push(pick(sender, command));
  return { kind: 'ok' };
};

test('a registered body reaches only its own route, carrying the Host-minted generation', async () => {
  const seen = [];
  const f = fixture({ body: recorder(seen, (sender, command) => ({ sender, kind: command.kind })) });
  const body = new FakeWindow(bodyUrl);
  assert.equal(f.group.attachBody(body, bodyUrl), 1);
  assert.deepEqual(await f.request(body, { kind: 'body.hit', rects: [] }), { kind: 'ok' });
  assert.deepEqual(await f.request(body, { kind: 'scene.report' }), { kind: 'ok' });
  assert.deepEqual(seen, [
    { sender: { role: 'body', generation: 1 }, kind: 'body.hit' },
    { sender: { role: 'body', generation: 1 }, kind: 'scene.report' },
  ]);
  assert.deepEqual(await f.request(f.panel, { kind: 'state' }), { kind: 'ok' });
  assert.deepEqual(f.calls.panel, ['state'], 'the panel keeps its unchanged route');
  assert.deepEqual(f.group.resolveSender(f.from(f.panel)), { role: 'panel', generation: 0 });
});

test('without a body route (no livingBody line) a registered body is heard for nothing', async () => {
  const f = fixture();
  const body = new FakeWindow(bodyUrl);
  f.group.attachBody(body, bodyUrl);
  for (const kind of ['body.hit', 'body.hit.renew', 'body.anchor', 'body.menu', 'scene.get', 'scene.report'])
    assert.deepEqual(await f.request(body, { kind }), { kind: 'error', code: 'permission_required' }, kind);
});

test('the role gate: a body cannot send panel commands and the panel cannot send body commands', async () => {
  const seen = [];
  const f = fixture({ body: recorder(seen, (_sender, command) => command.kind) });
  const body = new FakeWindow(bodyUrl);
  f.group.attachBody(body, bodyUrl);
  for (const kind of ['view.layout', 'view.hide', 'audio.connect', 'audio.close', 'prepare', 'state', 'desk.settle'])
    assert.deepEqual(await f.request(body, { kind }), { kind: 'error', code: 'permission_required' }, kind);
  assert.deepEqual(await f.request(body, null), { kind: 'error', code: 'permission_required' });
  for (const kind of ['body.hit', 'body.anchor', 'scene.get', 'scene.report'])
    assert.deepEqual(await f.request(f.panel, { kind }), { kind: 'error', code: 'permission_required' }, kind);
  assert.deepEqual(seen, []);
  assert.deepEqual(f.calls.panel, []);
});

test('an unregistered same-origin side window, a subframe and a navigated frame are refused', async () => {
  const f = fixture();
  const body = new FakeWindow(bodyUrl);
  f.group.attachBody(body, bodyUrl);
  for (const side of [new FakeWindow(panelUrl), new FakeWindow(bodyUrl)]) {
    assert.equal(f.group.resolveSender(f.from(side)), null);
    assert.deepEqual(await f.request(side, { kind: 'state' }), { kind: 'error', code: 'permission_required' });
    assert.deepEqual(await f.request(side, { kind: 'body.hit' }), { kind: 'error', code: 'permission_required' });
  }
  for (const win of [f.panel, body]) {
    const iframe = { url: win.webContents.mainFrame.url };
    assert.equal(f.group.resolveSender(f.from(win, iframe)), null, 'a same-URL subframe is not the main frame');
  }
  body.webContents.mainFrame.url = `${origin}/assets/body/other.html`;
  assert.equal(f.group.resolveSender(f.from(body)), null, 'the exact registered URL is required');
  assert.equal(f.group.resolveSender({ sender: f.panel.webContents }), null);
  assert.equal(f.group.resolveSender(undefined), null);
  assert.deepEqual(f.calls.panel, []);
});

test('a replaced or destroyed body is refused, and replacing a body is not a whole-cat close', async () => {
  const seen = [];
  const f = fixture({ body: recorder(seen, (sender) => sender.generation) });
  const first = new FakeWindow(bodyUrl);
  const second = new FakeWindow(bodyUrl);
  assert.equal(f.group.attachBody(first, bodyUrl), 1);
  assert.equal(f.group.attachBody(second, bodyUrl), 2);
  assert.equal(first.destroyed, true, 'at most one body is ever on screen');
  assert.deepEqual(await f.request(first, { kind: 'scene.report' }), { kind: 'error', code: 'permission_required' });
  assert.deepEqual(await f.request(second, { kind: 'scene.report' }), { kind: 'ok' });
  assert.deepEqual(seen, [2]);
  second.destroyed = true; // mid-destroy: the closed event has not arrived yet
  assert.equal(f.group.resolveSender(f.from(second)), null);
  second.destroyed = false;
  f.group.detachBody({ internal: true });
  assert.equal(second.destroyed, true);
  assert.equal(f.group.resolveSender(f.from(second)), null);
  assert.equal(f.group.attachBody(new FakeWindow(bodyUrl), bodyUrl), 3, 'generations only move forward');
  assert.deepEqual(f.calls.failures, []);
  assert.equal(f.calls.closed, 0);
  assert.equal(f.panel.destroyed, false);
});

test('companion:request is registered once across attach and detach cycles and removed only by close', () => {
  const f = fixture();
  for (let cycle = 0; cycle < 4; cycle++) {
    f.group.attachBody(new FakeWindow(bodyUrl), bodyUrl);
    f.group.detachBody({ internal: true });
  }
  f.group.attachBody(new FakeWindow(bodyUrl), bodyUrl);
  assert.equal(f.calls.handle, 1);
  assert.equal(f.calls.removeHandler, 0);
  f.group.close();
  assert.equal(f.calls.removeHandler, 1);
  assert.equal(f.handlers.has('companion:request'), false);
});

test('an internal body swap never revokes media, never closes the cat and never hides the panel', () => {
  const f = fixture();
  f.group.attachBody(new FakeWindow(bodyUrl), bodyUrl);
  f.group.attachBody(new FakeWindow(bodyUrl), bodyUrl);
  f.group.detachBody({ internal: true });
  f.group.detachBody({ internal: true });
  assert.deepEqual(f.calls.revoke, []);
  assert.deepEqual(f.calls.failures, []);
  assert.equal(f.calls.closed, 0);
  assert.equal(f.calls.removeHandler, 0);
  assert.equal(f.panel.visible, true);
  assert.equal(f.group.state, 'shown');
  assert.throws(() => f.group.detachBody(), /internal/, 'detach exists only for an internal swap');
});

test('a user hide revokes once and hides every managed window; show brings the whole group back', () => {
  const f = fixture();
  const body = new FakeWindow(bodyUrl);
  f.group.attachBody(body, bodyUrl);
  assert.equal(f.group.poll(), 'visible');
  f.group.hide();
  assert.deepEqual(f.calls.revoke, ['hidden']);
  assert.equal(f.panel.visible, false);
  assert.equal(body.visible, false);
  assert.equal(f.group.state, 'hidden');
  assert.equal(f.group.poll(), 'hidden');
  f.group.show();
  assert.equal(f.panel.visible, true);
  assert.equal(body.visible, true);
  assert.equal(f.group.state, 'shown');
  assert.equal(f.group.poll(), 'visible');
  body.visible = false; // the OS hid only the body
  assert.equal(f.group.poll(), 'hidden', 'the cat is visible only when every window it shows is visible');
  assert.deepEqual(f.calls.revoke, ['hidden']);
});

test('a body attached while the group is hidden stays hidden until the group is shown', () => {
  const f = fixture();
  f.group.hide();
  const body = new FakeWindow(bodyUrl);
  body.visible = false;
  f.group.attachBody(body, bodyUrl);
  assert.equal(body.shows, 0);
  f.group.show();
  assert.equal(body.visible, true);
});

test('lock and sleep revoke once per boundary and hide only the body; the last release shows it again', () => {
  const f = fixture();
  const body = new FakeWindow(bodyUrl);
  f.group.attachBody(body, bodyUrl);
  f.group.lock('locked');
  assert.deepEqual(f.calls.revoke, ['locked']);
  assert.equal(body.visible, false);
  assert.equal(f.panel.visible, true, 'the panel keeps its ball-mode lock behaviour');
  assert.equal(f.group.state, 'locked');
  assert.equal(f.group.poll(), 'visible');
  f.group.lock('suspended');
  assert.deepEqual(f.calls.revoke, ['locked', 'suspended']);
  f.group.unlock('locked');
  assert.equal(body.visible, false, 'one release cannot cross the other boundary');
  f.group.unlock('suspended');
  assert.equal(body.visible, true);
  assert.equal(f.group.state, 'shown');
  f.group.hide();
  f.group.lock('locked');
  f.group.unlock('locked');
  assert.equal(body.visible, false, 'unlock does not undo a user hide');
});

test('disable revokes with a published reason, hides every managed window and stays terminal', () => {
  const f = fixture();
  const body = new FakeWindow(bodyUrl);
  f.group.attachBody(body, bodyUrl);
  f.group.disable();
  assert.deepEqual(f.calls.revoke, ['revoked']);
  assert.equal(f.panel.visible, false);
  assert.equal(body.visible, false);
  assert.equal(f.group.state, 'disabled');
  f.group.show();
  assert.equal(f.panel.visible, false);
  assert.equal(f.group.poll(), 'hidden');
});

test('close destroys every managed window in one batch and closes the cat once', () => {
  const f = fixture();
  const body = new FakeWindow(bodyUrl);
  f.group.attachBody(body, bodyUrl);
  let closedBeforeBatch = 0;
  f.panel.on('closed', () => {
    closedBeforeBatch += f.calls.closed;
  });
  f.group.close();
  assert.equal(f.panel.destroyed, true);
  assert.equal(body.destroyed, true);
  assert.equal(closedBeforeBatch, 0, 'Host cleanup runs after the whole batch is destroyed');
  assert.equal(f.calls.closed, 1);
  assert.deepEqual(f.calls.failures, ['window-closed']);
  assert.equal(f.handlers.has('companion:request'), false);
  assert.throws(() => f.group.poll(), /closed/);
  assert.throws(() => f.group.attachBody(new FakeWindow(bodyUrl), bodyUrl), /closed/);
  f.group.close();
  assert.equal(f.calls.closed, 1);
});

test('losing any managed window closes the whole cat; no half cat is left on screen', () => {
  const cases = [
    ['body', (body) => body.destroy(), 'window-closed'],
    ['body', (body) => body.webContents.emit('render-process-gone'), 'renderer-gone'],
    ['body', (body) => body.webContents.emit('unresponsive'), 'unresponsive'],
    ['panel', (_body, panel) => panel.webContents.emit('render-process-gone'), 'renderer-gone'],
    ['panel', (_body, panel) => panel.destroy(), 'window-closed'],
  ];
  for (const [role, lose, reason] of cases) {
    const f = fixture();
    const body = new FakeWindow(bodyUrl);
    f.group.attachBody(body, bodyUrl);
    lose(body, f.panel);
    const label = `${role} ${reason}`;
    assert.deepEqual(f.calls.failures, [reason], label);
    assert.equal(f.calls.closed, 1, label);
    assert.equal(f.panel.destroyed, true, label);
    assert.equal(body.destroyed, true, label);
    assert.equal(f.handlers.has('companion:request'), false, label);
    assert.deepEqual(f.calls.revoke, [], `${label}: close is not a revocation path`);
  }
});

test('ball mode: with no body the group is exactly the single panel window', () => {
  const f = fixture();
  assert.equal(f.group.poll(), 'visible');
  f.panel.visible = false;
  assert.equal(f.group.poll(), 'hidden');
  f.group.show();
  assert.equal(f.panel.shows, 1);
  assert.equal(f.group.poll(), 'visible');
  f.group.lock('locked');
  assert.equal(f.panel.visible, true);
  f.group.detachBody({ internal: true });
  assert.equal(f.calls.closed, 0);
});
