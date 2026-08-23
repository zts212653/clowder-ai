import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';

import {
  createDormantPluginRuntimeComposition,
  EXTERNAL_PLUGIN_PRE_ACTIVE_TIMEOUT_MS,
  resolvePluginRuntimePersistencePaths,
} from '../dist/domains/plugin/index.js';
import { MemoryMeetingIntakeStore, MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';
import {
  completeExternalHandshake,
  EXTERNAL_PACKAGE_DIGEST,
  externalCandidate,
  externalManifest,
  FakePluginProcessAdapter,
} from './plugin-external-runtime-helpers.js';

async function composition(projectRoot, processes = new FakePluginProcessAdapter(), packages) {
  return {
    processes,
    runtime: createDormantPluginRuntimeComposition({
      projectRoot,
      routes: new MemorySignalRouteStore(),
      intakes: new MemoryMeetingIntakeStore(),
      processes,
      ...(packages === undefined ? {} : { packages }),
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

test('composition recovers both durable stores and resumes enabled owner intent with fresh authority', async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), 'cat-cafe-k2d-composition-restart-'));
  await mkdir(resolve(projectRoot, 'dist'), { recursive: true });
  await writeFile(resolve(projectRoot, externalManifest().runtime.entrypoint), '');
  const packages = {
    async resolveInstalledPackage() {
      return {
        rootDir: projectRoot,
        manifest: externalManifest(),
        verifyIntegrity: async () => undefined,
        release: async () => undefined,
      };
    },
  };
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

  const restarted = await composition(projectRoot, new FakePluginProcessAdapter(), packages);
  const recovered = await restarted.runtime.recoverAfterRestart();

  assert.deepEqual(recovered, { brokerSessions: 1, inventoryInstances: 0, resumeRequested: 1 });
  const child = await restarted.processes.waitForProcess(0);
  await completeExternalHandshake(child);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(restarted.processes.specs.length, 1);
  const recoveredInstance = (await restarted.runtime.inventoryStore.snapshot()).instances[0];
  assert.equal(recoveredInstance.activationState, 'enabled');
  assert.equal(recoveredInstance.runtimeState, 'healthy');
  assert.equal(recoveredInstance.lifecycleRevision, 1);
  const broker = await restarted.runtime.brokerStore.snapshot();
  assert.equal(broker.sessions[0].phase, 'closed');
  assert.equal(broker.sessions[0].closeReason, 'host_restart');
  assert.equal(broker.sessions[1].phase, 'active');
  await restarted.runtime.shutdown();
});

test('production handshake policy covers verified external source readiness without budget drift', async () => {
  const projectRoot = await mkdtemp(resolve(tmpdir(), 'cat-cafe-k2d-composition-readiness-'));
  let now = 5_000;
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    processes: new FakePluginProcessAdapter(),
    now: () => now,
  });
  const installed = await runtime.inventory.installPackage({
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
  await runtime.inventoryStore.transaction((transaction) => {
    const instance = transaction.instances.get(installed.pluginInstanceId);
    transaction.instances.put({
      ...instance,
      configReadiness: 'ready',
      activationState: 'enabled',
      runtimeState: 'stopped',
      updatedAt: now,
    });
  });

  const connection = await runtime.broker.openExternalConnection(installed.pluginInstanceId);
  const binding = await connection.hello(externalCandidate());
  now += 20_603;

  assert.equal(await connection.ready({ bindingNonce: binding.bindingNonce }), null);
  assert.equal(EXTERNAL_PLUGIN_PRE_ACTIVE_TIMEOUT_MS, 4 * 60_000);
  assert.equal(runtime.broker.preActiveTimeoutMs, EXTERNAL_PLUGIN_PRE_ACTIVE_TIMEOUT_MS);
  assert.equal(runtime.supervisor.handshakeTimeoutMs, EXTERNAL_PLUGIN_PRE_ACTIVE_TIMEOUT_MS);
});

test('production composition constructs and recovers K-2D but exposes no startup activation', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

  const routeBootstrapIndex = source.indexOf('await ensureOfficialPluginSignalRoutes({');
  const runtimeCompositionIndex = source.indexOf('createDormantPluginRuntimeComposition({');

  assert.match(source, /createDormantPluginRuntimeComposition/);
  assert.match(source, /routes: signalRouteStore,\s*ownerId: privateUserId/);
  assert.ok(routeBootstrapIndex >= 0, 'production must provision official Host signal routes');
  assert.ok(
    routeBootstrapIndex < runtimeCompositionIndex,
    'Host signal routes must exist before the external runtime can accept owner activation',
  );
  assert.match(source, /await externalPluginRuntime\.recoverAfterRestart\(\)/);
  assert.match(source, /await externalPluginRuntime\.shutdown\('api_shutdown'\)/);
  assert.match(source, /OfficialPluginHistoryImportService/);
  assert.match(source, /createLarkCliFeishuArtifactInspector/);
  assert.match(source, /historyImport:/);
  assert.match(source, /registerOfficialPluginRoutes\(app/);
  assert.doesNotMatch(source, /externalPluginRuntime\.supervisor\.start\(/);
});
