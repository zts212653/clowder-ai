import assert from 'node:assert/strict';
import test from 'node:test';
import { startGateResourceHealthMonitor } from './lib/gate-resource-health-monitor.mjs';

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test('stopping the monitor joins a health check that started before normal release', async () => {
  const healthCheckStarted = deferred();
  const finishHealthCheck = deferred();
  let bridgePresent = true;
  let bridgeLostCount = 0;
  const monitor = startGateResourceHealthMonitor({
    checkHealthy: async () => {
      healthCheckStarted.resolve();
      await finishHealthCheck.promise;
      return bridgePresent;
    },
    onBridgeLost: () => {
      bridgeLostCount += 1;
    },
    pollMs: 1,
  });

  await healthCheckStarted.promise;
  let releaseCompleted = false;
  const normalRelease = monitor.stop().then(() => {
    bridgePresent = false;
    releaseCompleted = true;
  });
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));

  try {
    assert.equal(bridgePresent, true, 'normal release must not delete the bridge during an in-flight health read');
    assert.equal(releaseCompleted, false);
  } finally {
    finishHealthCheck.resolve();
    await normalRelease;
  }
  assert.equal(bridgePresent, false);
  assert.equal(releaseCompleted, true);
  assert.equal(bridgeLostCount, 0);
  assert.equal(monitor.bridgeLost, false);
});

test('an in-flight health check error remains fail-closed while the monitor stops', async () => {
  const healthCheckStarted = deferred();
  const finishHealthCheck = deferred();
  const expectedError = new Error('lease read failed');
  let reportedError;
  const monitor = startGateResourceHealthMonitor({
    checkHealthy: async () => {
      healthCheckStarted.resolve();
      await finishHealthCheck.promise;
      throw expectedError;
    },
    onBridgeLost: (error) => {
      reportedError = error;
    },
    pollMs: 1,
  });

  await healthCheckStarted.promise;
  const stop = monitor.stop();
  finishHealthCheck.resolve();
  await stop;

  assert.equal(monitor.bridgeLost, true);
  assert.equal(reportedError, expectedError);
});
