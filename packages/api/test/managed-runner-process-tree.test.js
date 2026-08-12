import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

const { TASKKILL_TIMEOUT_MS, buildTaskkillArgs, terminateWindowsProcessTree } = await import(
  '../dist/infrastructure/managed-runner-process-tree.js'
);

function createHarness() {
  const child = new EventEmitter();
  let killCalls = 0;
  child.kill = () => {
    killCalls += 1;
    return true;
  };

  const spawnCalls = [];
  let timeoutCallback = null;
  let timeoutDelay = null;
  let clearCalls = 0;
  let unrefCalls = 0;

  return {
    child,
    deps: {
      spawnTaskkill(command, args, options) {
        spawnCalls.push({ command, args, options });
        return child;
      },
      scheduleTimeout(callback, delayMs) {
        timeoutCallback = callback;
        timeoutDelay = delayMs;
        return {
          unref() {
            unrefCalls += 1;
          },
        };
      },
      cancelTimeout() {
        clearCalls += 1;
      },
    },
    fireTimeout() {
      assert.ok(timeoutCallback, 'timeout callback should be registered');
      timeoutCallback();
    },
    observed() {
      return { spawnCalls, timeoutDelay, clearCalls, unrefCalls, killCalls };
    },
  };
}

test('taskkill args preserve graceful and forced process-tree semantics', () => {
  assert.deepStrictEqual(buildTaskkillArgs(4321, 'SIGTERM'), ['/PID', '4321', '/T']);
  assert.deepStrictEqual(buildTaskkillArgs(4321, 'SIGKILL'), ['/PID', '4321', '/T', '/F']);
});

test('Windows tree termination is asynchronous and reports successful completion', async () => {
  const harness = createHarness();

  const resultPromise = terminateWindowsProcessTree(4321, 'SIGTERM', harness.deps);
  let settled = false;
  void resultPromise.then(() => {
    settled = true;
  });
  await Promise.resolve();

  assert.strictEqual(settled, false, 'termination must not synchronously block for taskkill');
  assert.deepStrictEqual(harness.observed().spawnCalls, [
    {
      command: 'taskkill',
      args: ['/PID', '4321', '/T'],
      options: { shell: false, stdio: 'ignore', windowsHide: true },
    },
  ]);
  assert.strictEqual(harness.observed().timeoutDelay, TASKKILL_TIMEOUT_MS);
  assert.strictEqual(harness.observed().unrefCalls, 1);

  harness.child.emit('close', 0, null);
  assert.deepStrictEqual(await resultPromise, {
    status: 'completed',
    exitCode: 0,
    signal: null,
  });
  assert.strictEqual(harness.observed().clearCalls, 1);
});

test('Windows tree termination reports taskkill spawn failure', async () => {
  const harness = createHarness();
  const resultPromise = terminateWindowsProcessTree(4321, 'SIGTERM', harness.deps);
  const error = new Error('taskkill unavailable');

  harness.child.emit('error', error);

  assert.deepStrictEqual(await resultPromise, {
    status: 'failed',
    exitCode: null,
    signal: null,
    error,
  });
  assert.strictEqual(harness.observed().clearCalls, 1);
});

test('Windows tree termination reports non-zero taskkill exit', async () => {
  const harness = createHarness();
  const resultPromise = terminateWindowsProcessTree(4321, 'SIGTERM', harness.deps);

  harness.child.emit('close', 128, null);

  assert.deepStrictEqual(await resultPromise, {
    status: 'failed',
    exitCode: 128,
    signal: null,
  });
});

test('Windows tree termination times out deterministically and stops taskkill', async () => {
  const harness = createHarness();
  const resultPromise = terminateWindowsProcessTree(4321, 'SIGKILL', harness.deps);

  harness.fireTimeout();

  assert.deepStrictEqual(await resultPromise, {
    status: 'timed_out',
    exitCode: null,
    signal: null,
  });
  assert.strictEqual(harness.observed().killCalls, 1);
});
