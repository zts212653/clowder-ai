import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BundledPluginRuntimeCarrier } from '../dist/domains/plugin/builtin-runtime/carriers/bundled-runtime-carrier.js';
import { snapshotInventoryFixture } from './helpers/snapshot-inventory-fixture.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(runtime, observe = () => {}) {
  const instance = {
    pluginInstanceId: 'pi_lifecycle',
    pluginId: 'fixture.lifecycle',
    packageDigest: 'sha256:fixture',
    lifecycleState: 'installed',
    activationState: 'enabled',
    configReadiness: 'ready',
    lifecycleRevision: 1,
  };
  const state = {
    instances: [instance],
    packages: [
      { pluginId: instance.pluginId, packageDigest: instance.packageDigest, manifest: { pluginId: instance.pluginId } },
    ],
  };
  observe(instance);
  return new BundledPluginRuntimeCarrier({
    inventory: snapshotInventoryFixture({
      snapshot: async () => structuredClone(state),
      transaction: async (work) =>
        work({ instances: { get: () => instance, put: (next) => Object.assign(instance, next) } }),
    }),
    runtimes: [{ claims: () => true, start: async () => {}, invoke: async () => 'ok', ...runtime }],
  });
}

test('stop refuses new calls while closed still waits for cleanup', async () => {
  const cleanup = deferred();
  const carrier = fixture({ stop: () => cleanup.promise });
  const started = await carrier.start('pi_lifecycle');
  assert.equal(await carrier.invoke('pi_lifecycle', 'fixture.call', {}), 'ok');
  let closed = false;
  started.closed.then(() => {
    closed = true;
  });
  const stopping = carrier.stop('pi_lifecycle');
  await assert.rejects(carrier.invoke('pi_lifecycle', 'fixture.call', {}), /stopped or stopping/);
  assert.equal(closed, false);
  cleanup.resolve();
  await stopping;
  await started.closed;
  assert.equal(closed, true);
});

test('unexpected runtime completion revokes publication before waiting for cleanup', async () => {
  const exit = deferred();
  const cleanup = deferred();
  const cleanupEntered = deferred();
  const carrier = fixture({
    completion: () => exit.promise,
    stop: () => {
      cleanupEntered.resolve();
      return cleanup.promise;
    },
  });
  let revoked = false;
  const started = await carrier.start('pi_lifecycle', undefined, () => {
    revoked = true;
  });
  exit.resolve(new Error('private plugin failure must not enter owner diagnostics'));
  await cleanupEntered.promise;
  try {
    assert.equal(revoked, true, 'cleanup must not hold failed optional capabilities current');
    await assert.rejects(carrier.invoke('pi_lifecycle', 'fixture.call', {}));
  } finally {
    cleanup.resolve();
    await started.closed;
  }
});

test('a rejected publication cleanup still stops the crashed runtime and permits repair', async () => {
  const exit = deferred();
  let stops = 0;
  const carrier = fixture({
    completion: () => (stops === 0 ? exit.promise : undefined),
    stop: async () => {
      stops++;
    },
  });
  const started = await carrier.start('pi_lifecycle', undefined, async () => {
    throw new Error('provider release failed');
  });
  exit.resolve(new Error('execution failed'));
  await new Promise(setImmediate);
  try {
    assert.equal(stops, 1, 'notification failure must not skip runtime cleanup');
    await started.closed;
    const repaired = await carrier.start('pi_lifecycle');
    await carrier.stop('pi_lifecycle');
    await repaired.closed;
  } finally {
    await carrier.stop('pi_lifecycle');
  }
});

test('execution exit during contribution admission records failure without a later healthy state', async () => {
  const exit = deferred(),
    admission = deferred(),
    entered = deferred();
  let instance;
  const carrier = fixture({ completion: () => exit.promise, stop: async () => {} }, (record) => {
    instance = record;
  });
  const starting = carrier.start('pi_lifecycle', async () => {
    entered.resolve();
    await admission.promise;
  });
  const rejected = assert.rejects(starting, /cancelled/);
  await entered.promise;
  exit.resolve(new Error('execution failed during admission'));
  await new Promise(setImmediate);
  admission.resolve();
  await rejected;
  assert.equal(instance.runtimeState, 'crashed');
  assert.equal(instance.lastRuntimeError.code, 'UNEXPECTED_RUNTIME_FAILURE');
  await carrier.stop('pi_lifecycle');
});

test('cleanup failure retains closed handle until successful stop retry', async () => {
  let fail = true;
  const carrier = fixture({
    stop: async () => {
      if (fail) throw Error('cleanup');
    },
  });
  const started = await carrier.start('pi_lifecycle');
  let closed = false;
  started.closed.then(() => {
    closed = true;
  });
  await assert.rejects(carrier.stop('pi_lifecycle'), /cleanup/);
  await assert.rejects(carrier.invoke('pi_lifecycle', 'fixture.call', {}), /stopped or stopping/);
  assert.equal(closed, false);
  fail = false;
  await carrier.stop('pi_lifecycle');
  await started.closed;
  assert.equal(closed, true);
});

test('failed start and failed cleanup retain ownership until stop retry', async () => {
  let cleanupFails = true;
  const carrier = fixture({
    start: async () => {
      throw Error('start');
    },
    stop: async () => {
      if (cleanupFails) throw Error('cleanup');
    },
  });
  await assert.rejects(carrier.start('pi_lifecycle'), AggregateError);
  await assert.rejects(carrier.invoke('pi_lifecycle', 'fixture.call', {}), /stopped or stopping/);
  await assert.rejects(carrier.start('pi_lifecycle'), /runtime owner/);
  cleanupFails = false;
  await carrier.stop('pi_lifecycle');
});

test('stop joins startup and cleans resources allocated after the initial stop', async () => {
  const starting = deferred(),
    entered = deferred();
  let resourceLive = false;
  const carrier = fixture({
    start: async () => {
      entered.resolve();
      await starting.promise;
      resourceLive = true;
    },
    stop: async () => {
      resourceLive = false;
    },
  });
  const start = carrier.start('pi_lifecycle');
  const rejected = assert.rejects(start, /cancelled/);
  await entered.promise;
  let done = false;
  const stop = carrier.stop('pi_lifecycle').then(() => {
    done = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const premature = done;
  starting.resolve();
  await Promise.all([stop, rejected]);
  assert.equal(premature, false);
  assert.equal(resourceLive, false);
});
