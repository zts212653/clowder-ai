const assert = require('node:assert/strict');
const test = require('node:test');
const { createPetWindow } = require('./pet-window.cjs');
function fixture() {
  let bounds = { x: 400, y: 400, width: 300, height: 270 };
  let cursor = { x: 550, y: 580 },
    time = 0,
    hidden = false;
  const events = [],
    ignores = [];
  const area = { x: 0, y: 0, width: 1280, height: 800 };
  const host = createPetWindow({
    win: {
      getBounds: () => bounds,
      setBounds: (value) => {
        bounds = value;
      },
      isDestroyed: () => false,
      setIgnoreMouseEvents: (value) => ignores.push(value),
      hide: () => {
        hidden = true;
      },
    },
    screen: {
      getDisplayMatching: () => ({ workArea: area }),
      getDisplayNearestPoint: () => ({ workArea: area }),
      getCursorScreenPoint: () => cursor,
    },
    publish: (event) => events.push(event),
    now: () => time,
  });
  return {
    host,
    events,
    ignores,
    bounds: () => bounds,
    hidden: () => hidden,
    cursor: (p) => {
      cursor = p;
    },
    time: (n) => {
      time = n;
    },
  };
}

test('trusted ball size changes resize the native pet and keep settings inside one occupied surface', (t) => {
  const f = fixture();
  t.after(() => f.host.close());
  assert.equal(f.host.setBallSize(192), true);
  const reply = f.host.request({ kind: 'view.layout', panel: 'settings', width: 360, height: 478 });
  assert.equal(reply.kind, 'layout');
  const native = f.bounds();
  assert.ok(reply.pet.x >= 0 && reply.pet.y >= 0);
  assert.ok(reply.pet.x + 320 <= native.width, '192px preference scales the 120px base hit target');
  assert.ok(reply.pet.y + 347 <= native.height, 'scaled pet height stays inside the Host surface');
  assert.ok(reply.panel.x >= 0 && reply.panel.y >= 0);
  assert.ok(reply.panel.x + reply.panel.width <= native.width);
  assert.ok(reply.panel.y + reply.panel.height <= native.height);
  assert.equal(f.host.setBallSize(500), false, 'untrusted or corrupt values cannot change native geometry');
});

test('reset position moves the whole current layout without changing panel-relative geometry', (t) => {
  const f = fixture();
  t.after(() => f.host.close());
  const before = f.host.request({ kind: 'view.layout', panel: 'settings', width: 360, height: 420 });
  f.cursor({ x: f.bounds().x + before.pet.x + 20, y: f.bounds().y + before.pet.y + 20 });
  assert.equal(f.host.request({ kind: 'view.drag', phase: 'start' }, true).kind, 'ok');
  f.cursor({ x: 100, y: 100 });
  f.host.tick();
  f.host.request({ kind: 'view.drag', phase: 'end' }, true);
  const relative = { x: before.pet.x, y: before.pet.y, panelX: before.panel.x, panelY: before.panel.y };
  assert.equal(f.host.request({ kind: 'view.reset' }, false).code, 'permission_required');
  assert.equal(f.host.request({ kind: 'view.reset' }, true).kind, 'ok');
  const after = f.host.request({ kind: 'view.layout', panel: 'settings', width: 360, height: 420 });
  assert.deepEqual({ x: after.pet.x, y: after.pet.y, panelX: after.panel.x, panelY: after.panel.y }, relative);
  const native = f.bounds();
  assert.ok(native.x >= 0 && native.y >= 0 && native.x + native.width <= 1280 && native.y + native.height <= 800);
});
test('click is not a drag; deliberate native movement folds controls and blank areas pass through', (t) => {
  const f = fixture();
  t.after(() => f.host.close());
  f.host.request({ kind: 'view.layout', panel: 'none', width: 120, height: 130 });
  const initial = f.bounds();
  assert.equal(f.host.request({ kind: 'view.drag', phase: 'start' }, false).code, 'permission_required');
  f.host.request({ kind: 'view.drag', phase: 'start' }, true);
  f.host.tick();
  assert.deepEqual(f.bounds(), initial);
  assert.equal(f.events.length, 0);
  f.cursor({ x: 750, y: 580 });
  f.host.tick();
  assert.equal(f.bounds().x, initial.x + 200);
  assert.deepEqual(f.events, [{ kind: 'view-dismiss' }]);
  f.host.request({ kind: 'view.drag', phase: 'end' });
  f.cursor({ x: 10, y: 10 });
  f.host.tick();
  assert.equal(f.ignores.at(-1), true);
  f.cursor({ x: 750, y: 580 });
  f.host.tick();
  assert.equal(f.ignores.at(-1), false);
});
test('drag expires and cannot start outside this pet; hiding needs a current gesture', (t) => {
  const f = fixture();
  t.after(() => f.host.close());
  f.host.request({ kind: 'view.layout', panel: 'none', width: 120, height: 130 });
  f.host.request({ kind: 'view.drag', phase: 'start' }, true);
  const initial = f.bounds();
  f.time(16000);
  f.cursor({ x: 850, y: 700 });
  f.host.tick();
  assert.deepEqual(f.bounds(), initial);
  assert.equal(f.host.request({ kind: 'view.drag', phase: 'start' }, true).code, 'permission_required');
  assert.equal(f.host.request({ kind: 'view.hide' }, false).code, 'permission_required');
  assert.equal(f.hidden(), false);
  assert.equal(f.host.request({ kind: 'view.hide' }, true).kind, 'ok');
  assert.equal(f.hidden(), true);
});

test('living companion bubble is passive and the pending panel stays interactive', (t) => {
  const f = fixture();
  t.after(() => f.host.close());
  const bubble = f.host.request({ kind: 'view.layout', panel: 'bubble', width: 240, height: 80 });
  assert.equal(bubble.kind, 'layout');
  f.cursor({ x: f.bounds().x + bubble.panel.x + 3, y: f.bounds().y + bubble.panel.y + 3 });
  f.host.tick();
  assert.equal(f.ignores.at(-1), true, 'recent speech cannot steal clicks from the foreground app');

  const decisions = f.host.request({ kind: 'view.layout', panel: 'decisions', width: 300, height: 260 });
  assert.equal(decisions.kind, 'layout');
  f.cursor({ x: f.bounds().x + decisions.panel.x + 3, y: f.bounds().y + decisions.panel.y + 3 });
  f.host.tick();
  assert.equal(f.ignores.at(-1), false, 'the pending panel remains clickable');
});

test('drag keeps the native window aligned with ambient history and reopened controls', (t) => {
  for (const panel of ['bubble', 'actions', 'chat', 'menu', 'decisions']) {
    const f = fixture();
    t.after(() => f.host.close());
    f.host.request({ kind: 'view.layout', panel: 'bubble', width: 300, height: 54 });
    f.host.request({ kind: 'view.drag', phase: 'start' }, true);
    f.cursor({ x: 610, y: 580 });
    f.host.tick();
    assert.deepEqual(f.events, [{ kind: 'view-dismiss' }]);
    // The published alpha.8 surface restores a recent-history bubble after
    // dismiss; a user may also reopen another panel before the next Host tick.
    const reply = f.host.request({ kind: 'view.layout', panel, width: 300, height: 54 });
    f.host.tick();
    f.cursor({ x: 1260, y: 780 });
    f.host.tick();
    f.host.request({ kind: 'view.drag', phase: 'end' }, true);
    if (panel !== 'bubble')
      assert.deepEqual(f.events, [{ kind: 'view-dismiss' }], `${panel}: an open control is not dismissed on release`);
    const native = f.bounds();
    assert.equal(native.width, reply.width, `${panel}: native and renderer widths agree`);
    assert.equal(native.height, reply.height, `${panel}: native and renderer heights agree`);
    assert.ok(reply.pet.x >= 0 && reply.pet.y >= 0);
    assert.ok(reply.pet.x + 120 <= native.width && reply.pet.y + 130 <= native.height, `${panel}: cat remains visible`);
    assert.ok(reply.panel.x >= 0 && reply.panel.y >= 0);
    assert.ok(
      reply.panel.x + reply.panel.width <= native.width && reply.panel.y + reply.panel.height <= native.height,
      `${panel}: panel remains visible`,
    );
    assert.ok(
      native.x >= 0 && native.y >= 0 && native.x + native.width <= 1280 && native.y + native.height <= 800,
      `${panel}: entire window fits at the right and bottom display edges`,
    );
  }
});

test('cancel and timeout leave the last renderer layout inside native bounds', (t) => {
  for (const ending of ['cancel', 'timeout']) {
    const f = fixture();
    t.after(() => f.host.close());
    f.host.request({ kind: 'view.layout', panel: 'none', width: 120, height: 130 });
    f.host.request({ kind: 'view.drag', phase: 'start' }, true);
    f.cursor({ x: 610, y: 580 });
    f.host.tick();
    const reply = f.host.request({ kind: 'view.layout', panel: 'bubble', width: 300, height: 54 });
    if (ending === 'timeout') f.time(16000);
    else f.host.request({ kind: 'view.drag', phase: 'end' }, true);
    f.host.tick();
    const native = f.bounds();
    assert.equal(native.width, reply.width);
    assert.equal(native.height, reply.height);
    f.cursor({ x: 1200, y: 750 });
    f.host.tick();
    assert.deepEqual(f.bounds(), native, `${ending}: no stale drag moves the window`);
  }
});

test('releasing an ambient bubble at the display edge docks the cat and reflows the bubble inward', (t) => {
  const f = fixture();
  t.after(() => f.host.close());
  f.host.request({ kind: 'view.layout', panel: 'bubble', width: 300, height: 54 });
  assert.equal(f.host.request({ kind: 'view.drag', phase: 'start' }, true).kind, 'ok');
  f.cursor({ x: 1260, y: 780 });
  f.host.tick();
  assert.deepEqual(f.events, [{ kind: 'view-dismiss' }]);
  f.host.request({ kind: 'view.drag', phase: 'end' }, true);
  assert.deepEqual(f.events, [{ kind: 'view-dismiss' }, { kind: 'view-dismiss' }]);
  // alpha.8 restores the ambient bubble when it receives view-dismiss.
  const reply = f.host.request({ kind: 'view.layout', panel: 'bubble', width: 300, height: 54 });
  const native = f.bounds();
  assert.equal(native.x + reply.pet.x + 143, 1280, 'right peek art, not the smaller hit target, reaches the edge');
  assert.ok(reply.panel.x >= 0 && reply.panel.x + reply.panel.width <= native.width);
  assert.ok(reply.panel.y >= 0 && reply.panel.y + reply.panel.height <= native.height);
});
