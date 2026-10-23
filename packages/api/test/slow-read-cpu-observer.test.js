import assert from 'node:assert/strict';
import inspector, { Session } from 'node:inspector';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

const { createSlowReadCpuObserver } = await import('../dist/infrastructure/slow-read-cpu-observer.js');
const profile = { nodes: [], samples: [], startTime: 0, endTime: 2000 };

function harness(t) {
  let clock = 0;
  let connectFailure = false;
  let stopFailure = false;
  const commands = [];
  const entries = [];
  let disconnected = 0;
  t.mock.method(performance, 'now', () => clock);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.mock.method(Session.prototype, 'connect', () => {
    if (connectFailure) throw new Error('private-connect-canary');
  });
  t.mock.method(Session.prototype, 'post', (method, params, callback) => {
    commands.push(method);
    const cb = typeof params === 'function' ? params : callback;
    cb(method === 'Profiler.stop' && stopFailure ? new Error('private-stop-canary') : null, { profile });
  });
  t.mock.method(Session.prototype, 'disconnect', () => {
    disconnected++;
  });
  const arm = createSlowReadCpuObserver();
  return {
    arm,
    entries,
    commands,
    logger: { info: (entry) => entries.push(entry) },
    async advance(ms) {
      clock += ms;
      t.mock.timers.tick(ms);
      await setImmediate();
    },
    failConnect(value) {
      connectFailure = value;
    },
    failStop(value) {
      stopFailure = value;
    },
    get disconnected() {
      return disconnected;
    },
  };
}

test('fast completion cancels its arm; concurrent readers cannot start two profiles', async (t) => {
  const h = harness(t);
  const fast = h.arm(h.logger);
  fast();
  await h.advance(3000);
  assert.deepEqual(h.commands, []);
  const first = h.arm(h.logger);
  const sibling = h.arm(h.logger);
  await h.advance(2000);
  assert.equal(h.commands.filter((x) => x === 'Profiler.start').length, 1);
  first();
  first();
  sibling();
  await setImmediate();
  assert.equal(h.commands.filter((x) => x === 'Profiler.stop').length, 1);
  assert.equal(h.disconnected, 1);
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].requestPendingAtStop, false);
  await h.advance(10000);
  assert.equal(h.entries.length, 1, 'no timer or late completion can create a second report');
});

test('one capture per fifteen minutes and at most four admitted attempts per observer', async (t) => {
  const h = harness(t);
  async function attempt() {
    const done = h.arm(h.logger);
    await h.advance(2000);
    done();
    await setImmediate();
  }
  await attempt();
  await attempt();
  assert.equal(h.entries.length, 1, 'cooldown applies after the active profile has closed');
  for (let i = 0; i < 4; i++) {
    await h.advance(15 * 60 * 1000);
    await attempt();
  }
  assert.equal(h.entries.length, 4);
  assert.equal(h.commands.filter((x) => x === 'Profiler.start').length, 4);
  assert.equal(h.disconnected, 4);
});

test('profiler preparation/stop failures release their slots and never publish private errors', async (t) => {
  const h = harness(t);
  h.failConnect(true);
  const first = h.arm(h.logger);
  await h.advance(2000);
  first();
  assert.equal(h.entries[0].status, 'unavailable');
  assert.equal(h.disconnected, 1);
  h.failConnect(false);
  h.failStop(true);
  await h.advance(15 * 60 * 1000);
  const second = h.arm(h.logger);
  await h.advance(2000);
  second();
  await setImmediate();
  assert.equal(h.entries[1].status, 'unavailable');
  assert.equal(h.disconnected, 2);
  h.failStop(false);
  await h.advance(15 * 60 * 1000);
  const third = h.arm(h.logger);
  await h.advance(2000);
  third();
  await setImmediate();
  assert.equal(h.entries[2].status, 'sampled');
  assert.equal(h.disconnected, 3);
  assert.doesNotMatch(JSON.stringify(h.entries), /canary|Error|stack/);
});

test('a throwing diagnostic sink cannot reject cleanup or keep the process-level slot occupied', async (t) => {
  const h = harness(t);
  const first = h.arm({
    info() {
      throw new Error('private-logger-canary');
    },
  });
  await h.advance(2000);
  assert.doesNotThrow(first);
  await setImmediate();
  assert.equal(h.disconnected, 1);
  await h.advance(15 * 60 * 1000);
  const second = h.arm(h.logger);
  await h.advance(2000);
  second();
  await setImmediate();
  assert.equal(h.entries.length, 1);
  assert.equal(h.disconnected, 2);
});

test('an existing debugger listener prevents a new session without copying its URL', async (t) => {
  const h = harness(t);
  const replacement = t.mock.method(inspector, 'url', () => 'ws://private-debugger-canary');
  syncBuiltinESMExports();
  try {
    const done = h.arm(h.logger);
    await h.advance(2000);
    done();
    assert.deepEqual(h.commands, []);
    assert.equal(h.disconnected, 0);
    assert.equal(h.entries[0].reason, 'debugger_active');
    assert.doesNotMatch(JSON.stringify(h.entries), /canary|ws:\/\//);
  } finally {
    replacement.mock.restore();
    syncBuiltinESMExports();
  }
});
