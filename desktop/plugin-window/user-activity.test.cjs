const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createUserActivity } = require('./user-activity.cjs');

function fixture({ idle = 0, state = 'active' } = {}) {
  const clock = { now: 1_000_000 };
  const power = new EventEmitter();
  power.idle = idle;
  power.state = state;
  power.getSystemIdleTime = () => power.idle;
  power.getSystemIdleState = (threshold) =>
    power.state === 'active' && power.idle >= threshold ? 'idle' : power.state;
  const changes = [];
  const activity = createUserActivity({
    powerMonitor: power,
    now: () => clock.now,
    setTimer: () => null,
    clearTimer: () => {},
    onChange: (change) => changes.push(change),
  });
  const after = (seconds, idle) => {
    clock.now += seconds * 1000;
    if (idle !== undefined) power.idle = idle;
    activity.check();
  };
  return { clock, power, changes, activity, after };
}

test('at start somebody at the desk is present, but has not just come back', () => {
  const f = fixture({ idle: 2 });
  f.activity.start();
  assert.equal(f.activity.presence(), 'present');
  assert.deepEqual(f.changes, [{ presence: 'present', returned: false }]);
  f.activity.stop();
});

test('idle long enough is away; the next input after that is a return, once', () => {
  const f = fixture({ idle: 2 });
  f.activity.start();
  f.after(300, 300);
  assert.equal(f.activity.presence(), 'away');
  f.after(600, 900);
  f.after(2, 1);
  assert.equal(f.activity.presence(), 'present');
  f.after(2, 0);
  assert.deepEqual(
    f.changes.map((c) => [c.presence, c.returned]),
    [
      ['present', false],
      ['away', false],
      ['present', true],
    ],
  );
});

test('locking is away; unlocking alone is not a return, input after it is', () => {
  const f = fixture({ idle: 1 });
  f.activity.start();
  f.power.emit('lock-screen');
  f.power.state = 'locked';
  f.after(60, 60);
  assert.equal(f.activity.presence(), 'away');
  f.power.state = 'active';
  f.power.idle = 61;
  f.power.emit('unlock-screen');
  assert.equal(f.activity.presence(), 'away', 'the unlock screen is up, nobody typed yet');
  f.after(3, 0);
  assert.equal(f.activity.presence(), 'present');
  assert.equal(f.changes.at(-1).returned, true);
});

test('a wake (resume / DarkWake) is not a return; an idle reading of 0 right after it is ignored', () => {
  const f = fixture({ idle: 1 });
  f.activity.start();
  f.power.emit('suspend');
  assert.equal(f.activity.presence(), 'away');
  f.clock.now += 3_600_000;
  f.power.idle = 0; // some systems read 0 right at wake
  f.power.emit('resume');
  f.activity.check();
  assert.equal(f.activity.presence(), 'away');
  f.after(2, 2);
  assert.equal(f.activity.presence(), 'away', 'still inside the grace after the wake');
  f.after(30, 32);
  assert.equal(f.activity.presence(), 'away', 'a DarkWake with no input stays away');
  f.after(2, 0);
  assert.equal(f.activity.presence(), 'present');
  assert.equal(f.changes.at(-1).returned, true);
});

test('an unreadable signal counts as away; only a clear reading with fresh input returns', () => {
  const f = fixture({ idle: 1 });
  f.activity.start();
  f.power.state = 'unknown';
  f.after(2);
  assert.equal(f.activity.presence(), 'away');
  f.power.state = 'active';
  f.after(2, 0);
  assert.equal(f.activity.presence(), 'present');
  assert.equal(f.changes.at(-1).returned, true);
});

test('without a power monitor nothing is ever present', () => {
  const changes = [];
  const activity = createUserActivity({
    powerMonitor: undefined,
    setTimer: () => null,
    onChange: (c) => changes.push(c),
  });
  activity.start();
  activity.check();
  assert.equal(activity.presence(), 'unknown');
  assert.deepEqual(changes, []);
});

test('stop removes the lifecycle listeners', () => {
  const f = fixture({ idle: 1 });
  f.activity.start();
  assert.equal(f.power.listenerCount('lock-screen'), 1);
  f.activity.stop();
  assert.equal(f.power.listenerCount('lock-screen'), 0);
  assert.equal(f.power.listenerCount('resume'), 0);
});
