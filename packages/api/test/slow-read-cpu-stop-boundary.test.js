import assert from 'node:assert/strict';
import { Session } from 'node:inspector';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';

const { createSlowReadCpuObserver } = await import('../dist/infrastructure/telemetry/cpu/slow-read-cpu-observer.js');
const profile = { nodes: [], samples: [], startTime: 0, endTime: 2000 };

for (const trigger of ['timer', 'settlement']) {
  test(`${trigger} stop captures pending state before the delayed Inspector callback`, async (t) => {
    let clock = 0;
    let settled = false;
    let pendingWhenStopPosted;
    let releaseStop;
    let disconnected = 0;
    const commands = [];
    const entries = [];
    t.mock.method(performance, 'now', () => clock);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(Session.prototype, 'connect', () => {});
    t.mock.method(Session.prototype, 'post', (method, params, callback) => {
      commands.push(method);
      const cb = typeof params === 'function' ? params : callback;
      if (method === 'Profiler.stop') {
        pendingWhenStopPosted = !settled;
        releaseStop = () => cb(null, { profile });
      } else {
        cb(null);
      }
    });
    t.mock.method(Session.prototype, 'disconnect', () => {
      disconnected++;
    });
    async function advance(ms) {
      clock += ms;
      t.mock.timers.tick(ms);
      await setImmediate();
    }

    const finish = createSlowReadCpuObserver()({ info: (entry) => entries.push(entry) });
    function settle() {
      settled = true;
      finish();
    }
    try {
      await advance(2000);
      assert.equal(commands.filter((method) => method === 'Profiler.start').length, 1);
      if (trigger === 'timer') await advance(2000);
      else settle();

      assert.equal(typeof releaseStop, 'function', 'the stop response is still held');
      assert.equal(pendingWhenStopPosted, trigger === 'timer');
      assert.equal(entries.length, 0, 'no report before the stop callback');
      assert.equal(disconnected, 0, 'the active session waits for its stop callback');
      settle();
      settle();
      await advance(2000);
      assert.equal(commands.filter((method) => method === 'Profiler.stop').length, 1);
      releaseStop();
      releaseStop = undefined;
      await setImmediate();

      assert.equal(entries.length, 1);
      assert.equal(entries[0].status, 'sampled');
      assert.equal(entries[0].requestPendingAtStop, pendingWhenStopPosted);
      assert.equal(disconnected, 1);
      await advance(10000);
      assert.equal(entries.length, 1, 'late timers cannot replace the first stop boundary');
    } finally {
      settle();
      releaseStop?.();
      await setImmediate();
    }
  });
}
