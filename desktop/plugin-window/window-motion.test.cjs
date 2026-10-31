const assert = require('node:assert/strict');
const test = require('node:test');
const { createWindowMotion } = require('./window-motion.cjs');

function fixture() {
  let bounds = { x: 400, y: 300, width: 300, height: 270 };
  let authorized = true;
  let reducedMotion = false;
  let destroyed = false;
  const moves = [];
  const motion = createWindowMotion({
    win: {
      getBounds: () => ({ ...bounds }),
      setBounds: (next) => {
        bounds = next;
        moves.push(next);
      },
      isDestroyed: () => destroyed,
    },
    screen: {
      getDisplayNearestPoint: ({ x }) => ({
        workArea: x < 0 ? { x: -1280, y: 0, width: 1280, height: 800 } : { x: 0, y: 0, width: 1280, height: 800 },
      }),
    },
    systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: reducedMotion }) },
    isAuthorized: () => authorized,
  });
  return {
    motion,
    moves,
    bounds: () => bounds,
    authorize: (value) => {
      authorized = value;
    },
    reduceMotion: (value) => {
      reducedMotion = value;
    },
    destroy: () => {
      destroyed = true;
    },
  };
}

test('only the current native generation can move, and revocation aborts old work', () => {
  const f = fixture();
  assert.equal(f.motion.current(), null);
  const first = f.motion.arm();
  assert.ok(first);
  assert.equal(f.motion.current(), first);
  assert.equal(first.signal.aborted, false);
  assert.deepEqual(first.moveTo({ x: 800, y: 650 }), { status: 'moved', x: 800, y: 530, dx: 400, dy: 230 });
  assert.deepEqual(f.bounds(), { x: 800, y: 530, width: 300, height: 270 });
  f.motion.revoke('manual_drag');
  assert.equal(first.signal.aborted, true);
  assert.equal(first.moveTo({ x: 200, y: 200 }).status, 'cancelled');
  assert.equal(f.moves.length, 1);
  const second = f.motion.arm();
  assert.ok(second.generation > first.generation);
  assert.deepEqual(second.moveTo({ x: 200, y: 200 }), { status: 'moved', x: 200, y: 200, dx: -600, dy: -330 });
  f.motion.close();
  assert.equal(second.signal.aborted, true);
  assert.equal(f.motion.arm(), null);
  assert.equal(f.moves.length, 2);
});

test('native target stays on the selected display and cannot resize or accept invalid coordinates', () => {
  const f = fixture();
  const lease = f.motion.arm();
  assert.equal(lease.moveTo({ x: Number.POSITIVE_INFINITY, y: 2 }).status, 'invalid_target');
  assert.equal(lease.moveTo({ x: 5.5, y: 2 }).status, 'invalid_target');
  assert.equal(f.moves.length, 0);
  assert.deepEqual(lease.moveTo({ x: -1200, y: 760 }), {
    status: 'moved',
    x: -1200,
    y: 530,
    dx: -1600,
    dy: 230,
  });
  assert.deepEqual(f.bounds(), { x: -1200, y: 530, width: 300, height: 270 });
});

test('system reduced motion, lost authority and destroyed windows revoke in-flight movement', () => {
  for (const ending of ['reduced_motion', 'lost_authority', 'destroyed']) {
    const f = fixture();
    const lease = f.motion.arm();
    if (ending === 'reduced_motion') f.reduceMotion(true);
    if (ending === 'lost_authority') f.authorize(false);
    if (ending === 'destroyed') f.destroy();
    assert.equal(lease.moveTo({ x: 500, y: 400 }).status, ending);
    assert.equal(lease.signal.aborted, true);
    assert.equal(f.motion.current(), null);
    assert.equal(f.moves.length, 0);
  }
});
