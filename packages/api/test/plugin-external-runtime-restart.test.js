import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { ExternalPluginRuntimeSupervisor } from '../dist/domains/plugin/external-runtime/index.js';
import {
  completeExternalHandshake,
  createExternalRuntimeHarness,
  EXTERNAL_INSTANCE_ID,
  externalManifest,
  FakePluginProcessAdapter,
} from './plugin-external-runtime-helpers.js';

async function harness() {
  const rootDir = await mkdtemp(join(tmpdir(), 'cat-cafe-k2d-restart-'));
  const base = await createExternalRuntimeHarness({ rootDir });
  const processes = new FakePluginProcessAdapter();
  const options = {
    inventory: base.inventory,
    broker: base.broker,
    packages: {
      async resolveInstalledPackage() {
        return {
          rootDir,
          manifest: externalManifest(),
          verifyIntegrity: async () => undefined,
          release: async () => undefined,
        };
      },
    },
    processes,
  };
  return { ...base, options, processes };
}

test('concurrent start has one process owner', async () => {
  const base = await harness();
  const supervisor = new ExternalPluginRuntimeSupervisor(base.options);
  const first = supervisor.start(EXTERNAL_INSTANCE_ID);
  const child = await base.processes.nextProcess();
  await assert.rejects(supervisor.start(EXTERNAL_INSTANCE_ID), (error) => error.code === 'RUNTIME_ALREADY_ACTIVE');
  await completeExternalHandshake(child);
  await first;
  assert.equal(base.processes.specs.length, 1);
  await supervisor.stop(EXTERNAL_INSTANCE_ID);
});

test('handshake timeout terminates the owned process and closes durable authority', async () => {
  const base = await harness();
  const supervisor = new ExternalPluginRuntimeSupervisor({ ...base.options, handshakeTimeoutMs: 20 });
  const starting = supervisor.start(EXTERNAL_INSTANCE_ID);
  const child = await base.processes.nextProcess();
  await assert.rejects(starting, (error) => error.code === 'HANDSHAKE_TIMEOUT');
  assert.equal(child.terminateCalls, 1);
  const broker = await base.brokerStore.snapshot();
  assert.equal(broker.sessions[0].phase, 'closed');
  assert.equal(broker.sessions[0].closeReason, 'start_failed');
  const inventory = await base.inventory.snapshot();
  assert.equal(inventory.instances[0].runtimeState, 'crashed');
});

test('restart recovery closes durable sessions without attaching to persisted process identity', async () => {
  const base = await harness();
  const first = new ExternalPluginRuntimeSupervisor(base.options);
  const starting = first.start(EXTERNAL_INSTANCE_ID);
  const child = await base.processes.nextProcess();
  await completeExternalHandshake(child);
  await starting;

  const postRestartProcesses = new FakePluginProcessAdapter();
  const restarted = new ExternalPluginRuntimeSupervisor({
    ...base.options,
    processes: postRestartProcesses,
  });
  assert.equal(await restarted.recoverAfterRestart(), 1);
  assert.equal(postRestartProcesses.specs.length, 0);
  const snapshot = await base.brokerStore.snapshot();
  assert.equal(snapshot.sessions[0].phase, 'closed');
  assert.equal(snapshot.sessions[0].closeReason, 'host_restart');
  const inventory = await base.inventory.snapshot();
  assert.equal(inventory.instances[0].runtimeState, 'stopped');
});
