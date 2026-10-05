const assert = require('node:assert/strict');
const test = require('node:test');
const { createPetWindow } = require('./pet-window.cjs');

function scheduler() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    clearTimer: (id) => timers.delete(id),
    now: () => now,
    setTimer(callback, delay) {
      const id = ++nextId;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    tick(ms) {
      const until = now + ms;
      while (true) {
        const due = [...timers].sort((left, right) => left[1].at - right[1].at).find(([, timer]) => timer.at <= until);
        if (!due) break;
        now = due[1].at;
        timers.delete(due[0]);
        due[1].callback();
      }
      now = until;
    },
  };
}

test('native travel keeps layout truth aligned and an open panel pauses the route', (t) => {
  const time = scheduler();
  let bounds = { x: 400, y: 400, width: 300, height: 270 };
  const area = { x: 0, y: 0, width: 1280, height: 800 };
  const controller = new AbortController();
  const lease = {
    generation: 1,
    signal: controller.signal,
    moveTo(target) {
      const before = bounds;
      bounds = { ...bounds, ...target };
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
      setIgnoreMouseEvents() {},
      hide() {},
    },
    screen: {
      getDisplayMatching: () => ({ workArea: area }),
      getDisplayNearestPoint: () => ({ workArea: area }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    },
    publish() {},
    motionLease: () => lease,
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
  t.after(() => host.close());

  host.request({ kind: 'view.layout', panel: 'none', width: 120, height: 130 });
  const beforeTravel = { ...bounds };
  time.tick(30);
  const moved = { ...bounds };
  assert.ok(moved.x > beforeTravel.x, 'the lease moves the real native bounds');

  const reply = host.request({ kind: 'view.layout', panel: 'actions', width: 220, height: 70 });
  const panelBounds = { ...bounds };
  time.tick(500);
  assert.deepEqual(bounds, panelBounds, 'opening a panel pauses autonomous travel');
  assert.ok(reply.pet.x >= 0 && reply.pet.y >= 0, 'renderer layout remains aligned after native travel');
});
