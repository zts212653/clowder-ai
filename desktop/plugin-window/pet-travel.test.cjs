const assert = require('node:assert/strict');
const test = require('node:test');
const { chooseTravelTarget, createPetTravel } = require('./pet-travel.cjs');

function clock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  const setTimer = (callback, delay) => {
    const id = ++nextId;
    timers.set(id, { at: now + delay, callback });
    return id;
  };
  const clearTimer = (id) => timers.delete(id);
  const tick = (ms) => {
    const until = now + ms;
    while (true) {
      const due = [...timers].sort((left, right) => left[1].at - right[1].at).find(([, timer]) => timer.at <= until);
      if (!due) break;
      now = due[1].at;
      timers.delete(due[0]);
      due[1].callback();
    }
    now = until;
  };
  return { clearTimer, now: () => now, setTimer, tick, timers };
}

function nativeLease(bounds, moves, generation = 1) {
  const controller = new AbortController();
  return {
    controller,
    lease: Object.freeze({
      generation,
      signal: controller.signal,
      moveTo(target) {
        const before = { ...bounds };
        bounds.x = target.x;
        bounds.y = target.y;
        const result = {
          status: 'moved',
          x: bounds.x,
          y: bounds.y,
          dx: bounds.x - before.x,
          dy: bounds.y - before.y,
        };
        moves.push(result);
        return result;
      },
    }),
  };
}

test('travel targets stay on the current display and preserve the native window size', () => {
  assert.deepEqual(
    chooseTravelTarget({
      area: { x: -1280, y: 0, width: 1280, height: 800 },
      bounds: { x: -900, y: 620, width: 175, height: 148 },
      random: () => 0,
    }),
    { x: -780, y: 620 },
  );
  assert.equal(
    chooseTravelTarget({
      area: { x: 0, y: 0, width: 160, height: 140 },
      bounds: { x: 0, y: 0, width: 175, height: 148 },
    }),
    null,
  );
});

test('idle travel advances only through a live native lease and cools down after arrival', () => {
  const time = clock();
  const bounds = { x: 400, y: 620, width: 175, height: 148 };
  const moves = [];
  const native = nativeLease(bounds, moves);
  const travel = createPetTravel({
    acquireLease: () => native.lease,
    readBounds: () => ({ ...bounds }),
    readWorkArea: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    random: () => 0,
    idleDelayMs: 100,
    cooldownMs: 1_000,
    cooldownJitterMs: 0,
    frameMs: 10,
    stepPx: 20,
  });

  travel.resume();
  time.tick(99);
  assert.equal(moves.length, 0);
  time.tick(1);
  assert.equal(moves.length, 1);
  time.tick(100);
  assert.deepEqual(bounds, { x: 520, y: 620, width: 175, height: 148 });
  assert.ok(moves.every((move) => Math.abs(move.dx) <= 20 && move.dy === 0));
  assert.equal(time.timers.size, 1, 'arrival schedules one bounded cooldown instead of continuous wandering');
  travel.close();
});

test('abort and local pause stop in-flight travel without applying a stale target', () => {
  const time = clock();
  const bounds = { x: 400, y: 620, width: 175, height: 148 };
  const moves = [];
  const first = nativeLease(bounds, moves, 1);
  let current = first.lease;
  const travel = createPetTravel({
    acquireLease: () => current,
    readBounds: () => ({ ...bounds }),
    readWorkArea: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    random: () => 0,
    idleDelayMs: 10,
    cooldownMs: 1_000,
    cooldownJitterMs: 0,
    frameMs: 10,
    stepPx: 20,
  });

  travel.resume();
  time.tick(10);
  assert.equal(bounds.x, 420);
  first.controller.abort('manual_drag');
  time.tick(100);
  assert.equal(bounds.x, 420, 'an aborted generation cannot finish its old route');

  const second = nativeLease(bounds, moves, 2);
  current = second.lease;
  time.tick(10);
  assert.equal(bounds.x, 440);
  travel.pause();
  time.tick(1_000);
  assert.equal(bounds.x, 440, 'a panel or drag pause cancels local scheduled steps immediately');
  travel.close();
});

test('a rejected native step ends the episode without pretending that the window moved', () => {
  const time = clock();
  let calls = 0;
  const controller = new AbortController();
  const travel = createPetTravel({
    acquireLease: () => ({
      generation: 1,
      signal: controller.signal,
      moveTo() {
        calls++;
        return { status: 'reduced_motion' };
      },
    }),
    readBounds: () => ({ x: 400, y: 620, width: 175, height: 148 }),
    readWorkArea: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    random: () => 0,
    idleDelayMs: 100,
  });
  travel.resume();
  time.tick(100);
  assert.equal(calls, 1);
  time.tick(99);
  assert.equal(calls, 1, 'a failed step waits for the next bounded eligibility check');
  travel.close();
});
