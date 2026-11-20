// F336 Phase C U5/U6 through the Host presentation: in living mode the 32 ms tick also drives the
// body window, travel never starts, and the panel window sits next to the body's reported rect.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createPetWindow } = require('./pet-window.cjs');

const area = { x: 0, y: 25, width: 1440, height: 850 };
const current = (generation) => ({ role: 'body', generation });
/** The body page drew him once (his anchor among the clickable rects) and the panel was told the living skin; before
 * that the panel window stays the ball. */
const drawn = (host, generation) => {
  const him = { x: 1, y: 1, width: 10, height: 10 };
  host.requestBody(current(generation), { kind: 'body.anchor', rect: him });
  host.requestBody(current(generation), { kind: 'body.hit', rects: [him] });
  host.handOver();
};

function scheduler() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => now,
    clearTimer: (id) => timers.delete(id),
    setTimer(callback, delay) {
      const id = ++nextId;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    tick(ms) {
      const until = now + ms;
      while (true) {
        const due = [...timers].sort((a, b) => a[1].at - b[1].at).find(([, timer]) => timer.at <= until);
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
      }
      now = until;
    },
  };
}

function fakeBody() {
  const body = {
    visible: true,
    destroyed: false,
    ignores: [],
    moved: 0,
    webContents: new EventEmitter(),
    getBounds: () => ({ ...area }),
    setBounds() {
      body.moved++;
    },
    isVisible: () => body.visible,
    isDestroyed: () => body.destroyed,
    setIgnoreMouseEvents: (value) => body.ignores.push(value),
    setOpacity: (value) => {
      body.opacity = value;
    },
  };
  return body;
}

function fixture() {
  const time = scheduler();
  let bounds = { x: 1200, y: 700, width: 300, height: 270 };
  let cursor = { x: 5, y: 30 };
  const moves = [];
  const panelIgnores = [];
  const lease = {
    generation: 1,
    signal: new AbortController().signal,
    moveTo(target) {
      const before = bounds;
      bounds = { ...bounds, ...target };
      moves.push(target);
      return { status: 'moved', x: bounds.x, y: bounds.y, dx: bounds.x - before.x, dy: bounds.y - before.y };
    },
  };
  const host = createPetWindow({
    win: {
      getBounds: () => ({ ...bounds }),
      setBounds: (next) => {
        bounds = { ...next };
      },
      isDestroyed: () => false,
      setIgnoreMouseEvents: (value) => panelIgnores.push(value),
      hide() {},
    },
    screen: {
      getDisplayMatching: () => ({ workArea: area }),
      getDisplayNearestPoint: () => ({ workArea: area }),
      getCursorScreenPoint: () => cursor,
    },
    publish() {},
    motionLease: () => lease,
    now: time.now,
    travelOptions: {
      idleDelayMs: 10,
      cooldownMs: 1_000,
      cooldownJitterMs: 0,
      frameMs: 10,
      stepPx: 20,
      random: () => 0,
      now: time.now,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    },
  });
  return {
    host,
    time,
    moves,
    panelIgnores,
    bounds: () => ({ ...bounds }),
    cursor: (point) => {
      cursor = point;
    },
  };
}

test('living mode never starts pet-travel; back in ball mode travel works as before', (t) => {
  const f = fixture();
  t.after(() => f.host.close());
  const body = fakeBody();
  f.host.attachBody(body, 1);
  drawn(f.host, 1);
  f.host.request({ kind: 'view.layout', panel: 'none', width: 120, height: 130 });
  f.host.request({ kind: 'view.layout', panel: 'chat', width: 340, height: 500 });
  f.host.request({ kind: 'view.layout', panel: 'none', width: 120, height: 130 });
  f.host.request({ kind: 'view.reset' }, true);
  f.host.setBallSize(96);
  f.time.tick(5_000);
  assert.deepEqual(f.moves, [], 'the cat walks inside the canvas; the Host never moves a window for him');
  assert.equal(body.moved, 0, 'the body window is never moved or resized');
  assert.deepEqual(f.host.request({ kind: 'view.drag', phase: 'start' }, true), {
    kind: 'error',
    code: 'permission_required',
  });

  f.host.detachBody();
  f.host.request({ kind: 'view.layout', panel: 'none', width: 120, height: 130 });
  f.time.tick(100);
  assert.ok(f.moves.length > 0, 'the ball travels again after the swap back');
});

test('the shared tick: the body takes clicks only on its region, the open panel wins, the panel never holds a pet', (t) => {
  const f = fixture();
  t.after(() => f.host.close());
  const body = fakeBody();
  f.host.attachBody(body, 1);
  drawn(f.host, 1);
  const anchor = { x: 600, y: 700, width: 140, height: 120 };
  assert.deepEqual(f.host.requestBody(current(1), { kind: 'body.anchor', rect: anchor }), { kind: 'ok' });
  const reply = f.host.request({ kind: 'view.layout', panel: 'chat', width: 340, height: 500 });
  const native = f.bounds();
  const panel = { x: native.x + reply.panel.x, y: native.y + reply.panel.y, width: 340, height: 500 };
  // The paper ball's rect overlaps the chat panel: the panel must still win there.
  const hit = { x: panel.x - area.x, y: panel.y - area.y + 400, width: 60, height: 60 };
  assert.deepEqual(f.host.requestBody(current(1), { kind: 'body.hit', rects: [anchor, hit] }), { kind: 'ok' });

  f.cursor({ x: area.x + 650, y: area.y + 750 });
  f.host.tick();
  assert.equal(body.ignores.at(-1), false, 'over the cat the body takes the click');
  assert.notEqual(f.panelIgnores.at(-1), false, 'the panel window has no pet to hold');

  f.cursor({ x: panel.x + 20, y: panel.y + 420 });
  f.host.tick();
  assert.equal(body.ignores.at(-1), true, 'over the open panel the body passes through');
  assert.equal(f.panelIgnores.at(-1), false, 'and the panel takes the click');

  f.cursor({ x: 5, y: 30 });
  f.host.tick();
  assert.deepEqual([body.ignores.at(-1), f.panelIgnores.at(-1)], [true, true], 'blank desktop stays clickable');

  f.cursor({ x: area.x + 650, y: area.y + 750 });
  f.time.tick(1_600); // the page stopped renewing
  f.host.tick();
  assert.equal(body.ignores.at(-1), true, 'an expired lease passes through');
});

test('the panel opens next to the reported body rect and stays there while open; closed, the anchor box follows him', (t) => {
  const f = fixture();
  t.after(() => f.host.close());
  f.host.attachBody(fakeBody(), 1);
  drawn(f.host, 1);
  const lying = { x: 560, y: 790 - area.y, width: 300, height: 70 };
  f.host.requestBody(current(1), { kind: 'body.anchor', rect: lying });
  const reply = f.host.request({ kind: 'view.layout', panel: 'actions', width: 220, height: 70 });
  const native = f.bounds();
  const panel = { x: native.x + reply.panel.x, y: native.y + reply.panel.y, width: 220, height: 70 };
  const screenCat = { x: lying.x + area.x, y: lying.y + area.y, width: 300, height: 70 };
  assert.equal(panel.y + panel.height, screenCat.y - 12, 'actions sit right above the lying cat');
  assert.equal(reply.pet.x, screenCat.x - native.x, 'the reply reports the cat in panel-window coordinates');
  assert.ok(native.x >= area.x && native.y >= area.y && native.x + native.width <= area.x + area.width);

  // U9: his rect is what is drawn, so a tail flick reads as a move; a panel that followed it jittered under the pointer.
  f.host.requestBody(current(1), { kind: 'body.anchor', rect: { ...lying, x: lying.x - 200 } });
  assert.deepEqual(f.bounds(), native, 'an open panel stays where it opened');
  f.host.request({ kind: 'view.layout', panel: 'none', width: 120, height: 130 });
  const resting = f.bounds();
  f.host.requestBody(current(1), { kind: 'body.anchor', rect: { ...lying, x: lying.x - 260 } });
  assert.deepEqual(f.bounds(), { ...resting, x: resting.x - 60 }, 'with no panel the anchor box goes with him');
});

test('an anchor or hit from an old generation is refused and changes nothing', (t) => {
  const f = fixture();
  t.after(() => f.host.close());
  const old = fakeBody();
  f.host.attachBody(old, 1);
  const fresh = fakeBody();
  f.host.attachBody(fresh, 2);
  assert.equal(old.webContents.listenerCount('input-event'), 0, 'the replaced body was released');
  const denied = { kind: 'error', code: 'permission_required' };
  const rect = { x: 600, y: 700, width: 140, height: 120 };
  assert.deepEqual(f.host.requestBody(current(1), { kind: 'body.anchor', rect }), denied);
  assert.deepEqual(f.host.requestBody(current(1), { kind: 'body.hit', rects: [rect] }), denied);
  assert.deepEqual(f.host.requestBody({ role: 'panel', generation: 0 }, { kind: 'body.hit', rects: [rect] }), denied);
  f.cursor({ x: area.x + 650, y: area.y + 750 });
  f.host.tick();
  assert.deepEqual(fresh.ignores, [], 'the current body never got the stale region');
  assert.deepEqual(f.host.requestBody(current(2), { kind: 'body.anchor', rect: { ...rect, x: Number.NaN } }), {
    kind: 'error',
    code: 'invalid_request',
  });
  f.host.detachBody();
  assert.deepEqual(f.host.requestBody(current(2), { kind: 'body.hit', rects: [rect] }), denied, 'ball mode');
});
