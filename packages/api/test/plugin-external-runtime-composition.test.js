import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  createDormantPluginRuntimeComposition,
  resolvePluginRuntimePersistencePaths,
} from '../dist/domains/plugin/index.js';
import { MemoryMeetingIntakeStore, MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';
import {
  EXTERNAL_PACKAGE_DIGEST,
  externalCandidate,
  externalManifest,
  FakePluginProcessAdapter,
} from './plugin-external-runtime-helpers.js';

async function composition(projectRoot, processes = new FakePluginProcessAdapter()) {
  return {
    processes,
    runtime: createDormantPluginRuntimeComposition({
      projectRoot,
      routes: new MemorySignalRouteStore(),
      intakes: new MemoryMeetingIntakeStore(),
      processes,
      now: () => 5_000,
    }),
  };
}

test('current-main compatibility paths are explicit, project-scoped, and replaceable at one seam', async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), 'cat-cafe-k2d-composition-paths-'));

  assert.deepEqual(resolvePluginRuntimePersistencePaths(projectRoot), {
    inventorySnapshotPath: resolve(projectRoot, '.cat-cafe/plugin-host/inventory.json'),
    brokerSnapshotPath: resolve(projectRoot, '.cat-cafe/plugin-host/broker.json'),
    packagesRoot: resolve(projectRoot, '.cat-cafe/plugin-host/packages'),
  });

  const injected = {
    inventorySnapshotPath: resolve(projectRoot, 'future/inventory.json'),
    brokerSnapshotPath: resolve(projectRoot, 'future/broker.json'),
    packagesRoot: resolve(projectRoot, 'future/packages'),
  };
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    paths: injected,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
  });
  assert.deepEqual(runtime.paths, injected);
  assert.equal(runtime.inventoryStore.path, injected.inventorySnapshotPath);
  assert.equal(runtime.brokerStore.path, injected.brokerSnapshotPath);
});

test('dormant composition recovers both durable stores without spawning a process', async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), 'cat-cafe-k2d-composition-restart-'));
  const first = await composition(projectRoot);
  const installed = await first.runtime.inventory.installPackage({
    manifest: externalManifest(),
    computedPackageDigest: EXTERNAL_PACKAGE_DIGEST,
    expectedPackageDigest: EXTERNAL_PACKAGE_DIGEST,
    packagePluginId: externalCandidate().pluginId,
    effectiveGrants: ['events.publish'],
    signalSchemas: {
      'schemas/external.signal.v1.schema.json': {
        type: 'object',
        properties: { payload: { type: 'object' }, source: { type: 'object' } },
        required: ['payload', 'source'],
      },
    },
  });
  await first.runtime.inventoryStore.transaction((transaction) => {
    const instance = transaction.instances.get(installed.pluginInstanceId);
    transaction.instances.put({
      ...instance,
      configReadiness: 'ready',
      activationState: 'enabled',
      runtimeState: 'stopped',
      updatedAt: 5_001,
    });
  });
  const connection = await first.runtime.broker.openExternalConnection(installed.pluginInstanceId);
  const binding = await connection.hello(externalCandidate());
  await connection.ready({ bindingNonce: binding.bindingNonce });
  assert.equal((await first.runtime.inventoryStore.snapshot()).instances[0].runtimeState, 'healthy');

  const restarted = await composition(projectRoot);
  const recovered = await restarted.runtime.recoverAfterRestart();

  assert.deepEqual(recovered, { brokerSessions: 1, inventoryInstances: 1 });
  assert.equal(restarted.processes.specs.length, 0);
  const recoveredInstance = (await restarted.runtime.inventoryStore.snapshot()).instances[0];
  assert.equal(recoveredInstance.activationState, 'disabled');
  assert.equal(recoveredInstance.runtimeState, 'stopped');
  assert.equal(recoveredInstance.lifecycleRevision, 2);
  const broker = await restarted.runtime.brokerStore.snapshot();
  assert.equal(broker.sessions[0].phase, 'closed');
  assert.equal(broker.sessions[0].closeReason, 'host_restart');
});

test('production composition constructs and recovers K-2D but exposes no startup activation', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

  assert.match(source, /createDormantPluginRuntimeComposition/);
  assert.match(source, /await externalPluginRuntime\.recoverAfterRestart\(\)/);
  assert.match(source, /await externalPluginRuntime\.shutdown\('api_shutdown'\)/);
  assert.match(source, /registerOfficialPluginRoutes\(app/);
  assert.doesNotMatch(source, /externalPluginRuntime\.supervisor\.start\(/);
});
