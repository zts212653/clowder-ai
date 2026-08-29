import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  ExternalPluginLifecycleService,
  HostInventoryControlPlane,
  MemoryPluginInventoryStore,
  PluginLifecycleError,
} from '../dist/domains/plugin/index.js';

const DIGEST = `sha512-${createHash('sha512').update('official-lifecycle').digest('base64')}`;

function manifest() {
  return {
    pluginId: 'official.feishu-meeting-intake',
    version: '0.1.0-alpha.1',
    contractVersion: '0.1.0',
    name: 'Feishu Meeting Intake',
    features: [{ id: 'source', name: 'Source', resources: [], capabilities: ['events.publish'] }],
    runtime: { transport: 'stdio', entrypoint: 'dist/entrypoint.js' },
  };
}

function lifecycleError(code) {
  return (error) => error instanceof PluginLifecycleError && error.code === code;
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function harness(overrides = {}) {
  let now = 1_000;
  const store = new MemoryPluginInventoryStore();
  const inventory = new HostInventoryControlPlane(store, {
    createInstanceId: () => 'pi_official',
    now: () => now++,
  });
  await inventory.installPackage({
    manifest: manifest(),
    computedPackageDigest: DIGEST,
    expectedPackageDigest: DIGEST,
    packagePluginId: 'official.feishu-meeting-intake',
    effectiveGrants: ['events.publish'],
  });
  const calls = [];
  const supervisor = {
    start: overrides.start ?? (async (instanceId) => calls.push(`start:${instanceId}`)),
    stop:
      overrides.stop ??
      (async (instanceId) => {
        const current = (await store.snapshot()).instances[0];
        calls.push(`stop:${instanceId}:${current.activationState}`);
      }),
  };
  const lifecycle = new ExternalPluginLifecycleService({ store, supervisor, now: () => now++ });
  return { store, lifecycle, calls };
}

test('prepares then explicitly enables one official runtime with revision fencing', async () => {
  const { store, lifecycle, calls } = await harness();

  const prepared = await lifecycle.prepare('pi_official', 1);
  assert.equal(prepared.configReadiness, 'ready');
  assert.equal(prepared.activationState, 'disabled');
  assert.equal(prepared.lifecycleRevision, 2);

  const enabled = await lifecycle.enable('pi_official', 2);
  assert.equal(enabled.activationState, 'enabled');
  assert.equal(enabled.lifecycleRevision, 4);
  assert.deepEqual(calls, ['start:pi_official']);
  assert.equal((await store.snapshot()).instances[0].activationState, 'enabled');
});

test('stale lifecycle revisions fail without process or inventory mutation', async () => {
  const { store, lifecycle, calls } = await harness();
  await lifecycle.prepare('pi_official', 1);
  const before = await store.snapshot();

  await assert.rejects(lifecycle.enable('pi_official', 1), lifecycleError('STALE_REVISION'));

  assert.deepEqual(await store.snapshot(), before);
  assert.deepEqual(calls, []);
});

test('concurrent enable calls serialize and cannot create a second process owner', async () => {
  const started = deferred();
  const release = deferred();
  let starts = 0;
  const { lifecycle } = await harness({
    start: async () => {
      starts += 1;
      started.resolve();
      await release.promise;
    },
  });
  await lifecycle.prepare('pi_official', 1);

  const first = lifecycle.enable('pi_official', 2);
  await started.promise;
  const second = lifecycle.enable('pi_official', 2);
  release.resolve();

  await first;
  await assert.rejects(second, lifecycleError('STALE_REVISION'));
  assert.equal(starts, 1);
});

test('start failure projects error and stopped instead of false enabled', async () => {
  const { store, lifecycle } = await harness({
    start: async () => {
      throw new Error('secret-bearing child failure');
    },
  });
  await lifecycle.prepare('pi_official', 1);

  await assert.rejects(lifecycle.enable('pi_official', 2), lifecycleError('START_FAILED'));

  const failed = (await store.snapshot()).instances[0];
  assert.equal(failed.activationState, 'error');
  assert.equal(failed.runtimeState, 'stopped');
  assert.equal(failed.lifecycleRevision, 5);
});

test('a new activation attempt clears a stale runtime diagnostic before startup can fail', async () => {
  const { store, lifecycle } = await harness({
    start: async () => {
      throw new Error('package authority failed before runtime projection');
    },
  });
  await lifecycle.prepare('pi_official', 1);
  await store.transaction((transaction) => {
    const current = transaction.instances.get('pi_official');
    transaction.instances.put({
      ...current,
      activationState: 'error',
      runtimeState: 'stopped',
      lastRuntimeError: {
        code: 'EVENT_BUS_CONFLICT',
        exitCode: 17,
        signal: null,
        occurredAt: 1_500,
      },
    });
  });

  await assert.rejects(lifecycle.enable('pi_official', 2), lifecycleError('START_FAILED'));

  const failed = (await store.snapshot()).instances[0];
  assert.equal(failed.activationState, 'error');
  assert.equal(failed.runtimeState, 'stopped');
  assert.equal(failed.lastRuntimeError, undefined);
});

test('disable and uninstall stop process authority before their durable terminal state', async () => {
  const { store, lifecycle, calls } = await harness();
  await lifecycle.prepare('pi_official', 1);
  const enabled = await lifecycle.enable('pi_official', 2);

  const disabled = await lifecycle.disable('pi_official', enabled.lifecycleRevision);
  assert.equal(disabled.activationState, 'disabled');
  assert.equal(calls.at(-1), 'stop:pi_official:disabling');

  const retired = await lifecycle.uninstall('pi_official', disabled.lifecycleRevision);
  assert.equal(retired.lifecycleState, 'retired');
  assert.equal(retired.activationState, 'disabled');
  assert.equal(calls.at(-1), 'stop:pi_official:disabling');
  assert.equal((await store.snapshot()).instances[0].lifecycleState, 'retired');
});

test('repair is dormant and restart recovery turns interrupted transitions into error', async () => {
  const { store, lifecycle, calls } = await harness();
  await lifecycle.prepare('pi_official', 1);
  await store.transaction((transaction) => {
    const current = transaction.instances.get('pi_official');
    transaction.instances.put({
      ...current,
      activationState: 'enabling',
      runtimeState: 'starting',
      lifecycleRevision: 3,
    });
  });

  await lifecycle.recoverAfterRestart();
  const recovered = (await store.snapshot()).instances[0];
  assert.equal(recovered.activationState, 'error');
  assert.equal(recovered.runtimeState, 'stopped');

  const repaired = await lifecycle.repair('pi_official', recovered.lifecycleRevision);
  assert.equal(repaired.activationState, 'disabled');
  assert.equal(repaired.configReadiness, 'ready');
  assert.equal(repaired.runtimeState, 'stopped');
  assert.deepEqual(calls, ['stop:pi_official:error']);
});

test('restart recovery preserves enabled owner intent and resumes a fresh runtime', async () => {
  const { store, lifecycle, calls } = await harness();
  await lifecycle.prepare('pi_official', 1);
  await lifecycle.enable('pi_official', 2);
  await store.transaction((transaction) => {
    const current = transaction.instances.get('pi_official');
    transaction.instances.put({ ...current, runtimeState: 'healthy' });
  });

  assert.deepEqual(await lifecycle.recoverAfterRestart(), { recoveredInstances: 1, resumeRequested: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = (await store.snapshot()).instances[0];
  assert.equal(recovered.activationState, 'enabled');
  assert.equal(recovered.runtimeState, 'stopped');
  assert.equal(recovered.lifecycleRevision, 4);
  assert.deepEqual(calls, ['start:pi_official', 'start:pi_official']);
});

test('restart recovery does not create activation intent for a dormant configured instance', async () => {
  const { store, lifecycle, calls } = await harness();
  await lifecycle.prepare('pi_official', 1);

  assert.deepEqual(await lifecycle.recoverAfterRestart(), { recoveredInstances: 0, resumeRequested: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = (await store.snapshot()).instances[0];
  assert.equal(recovered.activationState, 'disabled');
  assert.equal(recovered.runtimeState, 'stopped');
  assert.deepEqual(calls, []);
});

test('repair accepts the legacy enabled plus crashed projection and returns dormant', async () => {
  const { store, lifecycle } = await harness();
  await lifecycle.prepare('pi_official', 1);
  await lifecycle.enable('pi_official', 2);
  await store.transaction((transaction) => {
    const current = transaction.instances.get('pi_official');
    transaction.instances.put({ ...current, runtimeState: 'crashed' });
  });

  const repaired = await lifecycle.repair('pi_official', 4);
  assert.equal(repaired.activationState, 'disabled');
  assert.equal(repaired.runtimeState, 'stopped');
});

test('maintenance preserves enabled intent while serializing stop, mutation, and resume', async () => {
  const { store, lifecycle, calls } = await harness();
  await lifecycle.prepare('pi_official', 1);
  await lifecycle.enable('pi_official', 2);
  await store.transaction((transaction) => {
    const current = transaction.instances.get('pi_official');
    transaction.instances.put({ ...current, runtimeState: 'healthy' });
  });

  const result = await lifecycle.runWithRuntimeSuspended({
    instanceId: 'pi_official',
    expectedRevision: 4,
    stopReason: 'package_update',
    resumeFailureCode: 'UPDATE_RESUME_FAILED',
    operation: async (stopped) => {
      assert.equal(stopped.activationState, 'enabled');
      assert.equal(stopped.runtimeState, 'stopped');
      return 'swapped';
    },
  });

  assert.equal(result.result, 'swapped');
  assert.equal(result.instance.activationState, 'enabled');
  assert.deepEqual(calls, ['start:pi_official', 'stop:pi_official:enabled', 'start:pi_official']);
});

test('maintenance leaves disabled intent dormant and reports a failed enabled restore as actionable error', async () => {
  let starts = 0;
  const { store, lifecycle, calls } = await harness({
    start: async (instanceId) => {
      starts += 1;
      calls.push(`start:${instanceId}`);
      if (starts === 2) throw new Error('new package failed');
    },
  });
  await lifecycle.prepare('pi_official', 1);
  const dormant = await lifecycle.runWithRuntimeSuspended({
    instanceId: 'pi_official',
    expectedRevision: 2,
    stopReason: 'package_update',
    resumeFailureCode: 'UPDATE_RESUME_FAILED',
    operation: async () => 'updated dormant',
  });
  assert.equal(dormant.instance.activationState, 'disabled');
  assert.deepEqual(calls, []);

  await lifecycle.enable('pi_official', dormant.instance.lifecycleRevision);
  await store.transaction((transaction) => {
    const current = transaction.instances.get('pi_official');
    transaction.instances.put({ ...current, runtimeState: 'healthy' });
  });
  await assert.rejects(
    lifecycle.runWithRuntimeSuspended({
      instanceId: 'pi_official',
      expectedRevision: dormant.instance.lifecycleRevision + 2,
      stopReason: 'package_update',
      resumeFailureCode: 'UPDATE_RESUME_FAILED',
      operation: async () => 'updated enabled',
    }),
    lifecycleError('UPDATE_RESUME_FAILED'),
  );
  const failed = (await store.snapshot()).instances[0];
  assert.equal(failed.activationState, 'error');
  assert.equal(failed.runtimeState, 'stopped');
  assert.equal(failed.lastRuntimeError.code, 'UPDATE_RESUME_FAILED');
});

test('maintenance never mutates the package when the runtime cannot stop', async () => {
  let mutated = false;
  const { store, lifecycle } = await harness({
    stop: async () => {
      throw new Error('process refused to stop');
    },
  });
  await lifecycle.prepare('pi_official', 1);
  await lifecycle.enable('pi_official', 2);
  await store.transaction((transaction) => {
    const current = transaction.instances.get('pi_official');
    transaction.instances.put({ ...current, runtimeState: 'healthy' });
  });

  await assert.rejects(
    lifecycle.runWithRuntimeSuspended({
      instanceId: 'pi_official',
      expectedRevision: 4,
      stopReason: 'package_update',
      resumeFailureCode: 'UPDATE_RESUME_FAILED',
      operation: async () => {
        mutated = true;
      },
    }),
    lifecycleError('STOP_FAILED'),
  );
  assert.equal(mutated, false);
  assert.equal((await store.snapshot()).instances[0].activationState, 'error');
});

test('failed package mutation restores the previous enabled runtime before returning the failure', async () => {
  const { store, lifecycle, calls } = await harness();
  await lifecycle.prepare('pi_official', 1);
  await lifecycle.enable('pi_official', 2);
  await store.transaction((transaction) => {
    const current = transaction.instances.get('pi_official');
    transaction.instances.put({ ...current, runtimeState: 'healthy' });
  });

  await assert.rejects(
    lifecycle.runWithRuntimeSuspended({
      instanceId: 'pi_official',
      expectedRevision: 4,
      stopReason: 'package_update',
      resumeFailureCode: 'UPDATE_RESUME_FAILED',
      operation: async () => {
        throw new Error('verified swap rejected');
      },
    }),
    /verified swap rejected/,
  );
  assert.equal((await store.snapshot()).instances[0].activationState, 'enabled');
  assert.deepEqual(calls, ['start:pi_official', 'stop:pi_official:enabled', 'start:pi_official']);
});

test('failed catch-up maintenance projects its own resume error instead of an update error', async () => {
  let starts = 0;
  const { store, lifecycle } = await harness({
    start: async () => {
      starts += 1;
      if (starts === 2) throw new Error('catch-up runtime could not resume');
    },
  });
  await lifecycle.prepare('pi_official', 1);
  await lifecycle.enable('pi_official', 2);
  await store.transaction((transaction) => {
    const current = transaction.instances.get('pi_official');
    transaction.instances.put({ ...current, runtimeState: 'healthy' });
  });

  await assert.rejects(
    lifecycle.runWithRuntimeSuspended({
      instanceId: 'pi_official',
      expectedRevision: 4,
      stopReason: 'meeting_catch_up',
      resumeFailureCode: 'CATCH_UP_RESUME_FAILED',
      operation: async () => {
        throw new Error('catch-up scan failed');
      },
    }),
    lifecycleError('CATCH_UP_RESUME_FAILED'),
  );
  const failed = (await store.snapshot()).instances[0];
  assert.equal(failed.activationState, 'error');
  assert.equal(failed.lastRuntimeError.code, 'CATCH_UP_RESUME_FAILED');
});

test('maintenance shares the lifecycle queue so a concurrent owner action loses its stale fence', async () => {
  const entered = deferred();
  const release = deferred();
  const { store, lifecycle } = await harness();
  await lifecycle.prepare('pi_official', 1);
  await lifecycle.enable('pi_official', 2);
  await store.transaction((transaction) => {
    const current = transaction.instances.get('pi_official');
    transaction.instances.put({ ...current, runtimeState: 'healthy' });
  });

  const maintenance = lifecycle.runWithRuntimeSuspended({
    instanceId: 'pi_official',
    expectedRevision: 4,
    stopReason: 'package_update',
    resumeFailureCode: 'UPDATE_RESUME_FAILED',
    operation: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  await entered.promise;
  const disable = lifecycle.disable('pi_official', 4);
  release.resolve();

  await maintenance;
  await assert.rejects(disable, lifecycleError('STALE_REVISION'));
  assert.equal((await store.snapshot()).instances[0].activationState, 'enabled');
});
