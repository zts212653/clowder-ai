import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BundledPluginRuntimeCarrier } from '../dist/domains/plugin/builtin-runtime/carriers/bundled-runtime-carrier.js';

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture(runtime) {
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
    grants: [{ pluginInstanceId: instance.pluginInstanceId, grantRevision: 1, effectiveGrants: [] }],
  };
  return new BundledPluginRuntimeCarrier({
    inventory: {
      snapshot: async () => structuredClone(state),
      transaction: async (work) =>
        work({ instances: { get: () => instance, put: (next) => Object.assign(instance, next) } }),
    },
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
