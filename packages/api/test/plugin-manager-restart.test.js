import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/index.js';
import { MemoryMeetingIntakeStore, MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';
import { completeExternalHandshake, FakePluginProcessAdapter } from './plugin-external-runtime-helpers.js';
import { catalogEntry, manifest, packageArchive } from './plugin-official-package-installer.fixture.js';

const roots = [];

after(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runtime(projectRoot, processes) {
  return createDormantPluginRuntimeComposition({
    projectRoot,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    ...(processes === undefined ? {} : { processes }),
    now: () => 12_000,
  });
}

async function waitForPluginLiveState(manager, pluginId, expected) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const plugin = (await manager.get(pluginId)).plugin;
    if (plugin.live === expected) return plugin;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`plugin ${pluginId} did not reach ${expected}`);
}

test('Plugin Manager recovers durable inventory and revision fences after Host restart', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-f202-manager-restart-'));
  roots.push(projectRoot);
  const packageManifest = manifest();
  const archive = await packageArchive({ packageManifest });
  const entry = catalogEntry(archive.integrity, {
    ownerAuth: {
      kind: 'lark-cli-device',
      runnerPath: 'dist/auth.js',
      domains: ['event'],
    },
  });
  let catalogOffline = false;
  const catalogProvider = {
    async snapshot() {
      if (catalogOffline) throw new Error('catalog offline');
      return { entries: [entry], status: 'fresh', checkedAt: 11_000 };
    },
  };

  const firstRuntime = runtime(projectRoot);
  const firstManager = createPluginManagerRuntimeComposition({
    runtime: firstRuntime,
    catalogProvider,
    catalogManifests: [packageManifest],
    fetchOfficialArchive: async () => archive.bytes,
    now: () => 12_000,
  }).manager;
  const installed = await firstManager.install({
    source: { kind: 'catalog', catalogId: entry.catalogId },
    expectedVersion: entry.version,
    expectedDigest: entry.packageDigest,
  });
  const beforeRestart = (await firstManager.get(entry.pluginId)).plugin;
  assert.equal(beforeRestart.pluginInstanceId, installed.pluginInstanceId);
  assert.equal(beforeRestart.lifecycleRevision, 2);
  assert.equal(beforeRestart.intent, 'disabled');

  const restartedRuntime = runtime(projectRoot);
  assert.deepEqual(await restartedRuntime.recoverAfterRestart(), {
    brokerSessions: 0,
    inventoryInstances: 0,
    resumeRequested: 0,
  });
  catalogOffline = true;
  const restartedManager = createPluginManagerRuntimeComposition({
    runtime: restartedRuntime,
    catalogProvider,
    catalogManifests: [packageManifest],
    now: () => 12_000,
  }).manager;
  const recovered = await restartedManager.list();

  assert.equal(recovered.catalog.status, 'unavailable');
  assert.equal(recovered.plugins.length, 1);
  assert.equal(recovered.plugins[0].pluginInstanceId, installed.pluginInstanceId);
  assert.equal(recovered.plugins[0].lifecycleRevision, 2);
  assert.equal(recovered.plugins[0].intent, 'disabled');
  assert.equal(recovered.plugins[0].auth, 'error', 'offline projection must preserve and fail closed on owner auth');
  assert.deepEqual(recovered.plugins[0].source, {
    kind: 'catalog',
    catalogId: entry.catalogId,
    packageName: entry.packageName,
    trust: 'official',
  });

  await assert.rejects(
    () => restartedManager.uninstall(entry.pluginId, { expectedRevision: 1 }),
    (error) => error?.code === 'STALE_REVISION',
  );
  await restartedManager.uninstall(entry.pluginId, { expectedRevision: 2 });
  assert.equal((await restartedRuntime.inventoryStore.snapshot()).instances[0].lifecycleState, 'retired');
});

test('Plugin Manager completes install, config/auth, enable, restart, disable, and uninstall on one Host runtime', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-f202-manager-lifecycle-'));
  roots.push(projectRoot);
  const packageManifest = manifest();
  const archive = await packageArchive({ packageManifest });
  const entry = catalogEntry(archive.integrity, {
    ownerAuth: {
      kind: 'lark-cli-device',
      runnerPath: 'dist/auth.js',
      domains: ['event'],
    },
  });
  const catalogProvider = {
    snapshot: async () => ({ entries: [entry], status: 'fresh', checkedAt: 11_000 }),
  };
  const auth = {
    status: async () => ({ status: 'connected' }),
    start: async () => ({ status: 'connected' }),
  };
  const firstProcesses = new FakePluginProcessAdapter();
  const firstRuntime = runtime(projectRoot, firstProcesses);
  const firstManager = createPluginManagerRuntimeComposition({
    runtime: firstRuntime,
    catalogProvider,
    catalogManifests: [packageManifest],
    fetchOfficialArchive: async () => archive.bytes,
    auth,
    now: () => 12_000,
  }).manager;

  const installed = await firstManager.install({
    source: { kind: 'catalog', catalogId: entry.catalogId },
    expectedVersion: entry.version,
    expectedDigest: entry.packageDigest,
  });
  await firstRuntime.lifecycle.prepare(installed.pluginInstanceId, 2);
  const configured = (await firstManager.get(entry.pluginId)).plugin;
  assert.equal(configured.config, 'ready');
  assert.equal(configured.auth, 'connected');
  assert.equal(configured.actions.setEnabled, true);

  const enabling = firstManager.setEnabled(entry.pluginId, { enabled: true, expectedRevision: 2 });
  const firstChild = await firstProcesses.waitForProcess(0);
  await completeExternalHandshake(firstChild, {
    pluginId: entry.pluginId,
    packageDigest: entry.packageDigest,
    contractVersion: packageManifest.contractVersion,
    wireVersion: '0.1.0',
  });
  await enabling;
  const running = (await firstManager.get(entry.pluginId)).plugin;
  assert.equal(running.intent, 'enabled');
  assert.equal(running.live, 'running');
  assert.equal(running.lifecycleRevision, 4);

  await firstRuntime.shutdown('test_restart');
  const restartedProcesses = new FakePluginProcessAdapter();
  const restartedRuntime = runtime(projectRoot, restartedProcesses);
  const recovery = await restartedRuntime.recoverAfterRestart();
  assert.equal(recovery.resumeRequested, 1);
  const restartedChild = await restartedProcesses.waitForProcess(0);
  await completeExternalHandshake(restartedChild, {
    pluginId: entry.pluginId,
    packageDigest: entry.packageDigest,
    contractVersion: packageManifest.contractVersion,
    wireVersion: '0.1.0',
  });
  await new Promise((resolve) => setImmediate(resolve));

  const restartedManager = createPluginManagerRuntimeComposition({
    runtime: restartedRuntime,
    catalogProvider,
    catalogManifests: [packageManifest],
    auth,
    now: () => 12_000,
  }).manager;
  const resumed = (await restartedManager.get(entry.pluginId)).plugin;
  assert.equal(resumed.intent, 'enabled');
  assert.equal(resumed.live, 'running');
  assert.equal(resumed.auth, 'connected');

  await restartedManager.setEnabled(entry.pluginId, {
    enabled: false,
    expectedRevision: resumed.lifecycleRevision,
  });
  const disabled = (await restartedManager.get(entry.pluginId)).plugin;
  assert.equal(disabled.intent, 'disabled');
  assert.equal(disabled.live, 'stopped');
  await restartedManager.uninstall(entry.pluginId, { expectedRevision: disabled.lifecycleRevision });
  assert.equal((await restartedRuntime.inventoryStore.snapshot()).instances[0].lifecycleState, 'retired');
});

test('Plugin Manager resumes Host-supervised builtin contribution invocation after restart', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'cat-cafe-f202-manager-builtin-restart-'));
  roots.push(projectRoot);
  const materializedRoot = join(projectRoot, 'materialized');
  await mkdir(join(materializedRoot, 'dist'), { recursive: true });
  await writeFile(join(materializedRoot, 'dist/entrypoint.js'), '// builtin fixture\n', 'utf8');
  const packageManifest = manifest({
    runtime: { transport: 'builtin' },
    description: 'Runs a restart-safe Host-supervised contribution.',
    icon: 'github',
    contributions: [
      {
        type: 'mcp',
        id: 'fixture-tools',
        runtime: { transport: 'stdio', entrypoint: 'dist/entrypoint.js' },
      },
    ],
    features: [
      {
        id: 'source',
        name: 'Source',
        resources: [],
        contributions: [{ type: 'mcp', id: 'fixture-tools' }],
        capabilities: ['events.publish'],
      },
    ],
  });
  const archive = await packageArchive({ packageManifest });
  const entry = catalogEntry(archive.integrity, {
    pluginId: packageManifest.pluginId,
    version: packageManifest.version,
    presentation: {
      displayName: packageManifest.name,
      description: packageManifest.description,
      icon: packageManifest.icon,
      publisher: 'Clowder AI',
    },
  });
  const catalogProvider = {
    snapshot: async () => ({ entries: [entry], status: 'fresh', checkedAt: 11_000 }),
  };
  const builtinContributions = (onStart) => ({
    materializer: {
      resolve: async () => ({
        rootDir: materializedRoot,
        verifyIntegrity: async () => {},
        release: async () => {},
      }),
    },
    configuration: {
      readConfig: async () => undefined,
      readSecret: async () => undefined,
    },
    runtime: {
      start: async (spec) => {
        onStart(spec);
        return {
          tools: [
            {
              name: 'fixture_tool',
              inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
            },
          ],
          callTool: async (name, args) => ({ name, args }),
          close: async () => {},
        };
      },
    },
  });

  const firstStarts = [];
  const firstRuntime = runtime(projectRoot);
  const firstComposition = createPluginManagerRuntimeComposition({
    runtime: firstRuntime,
    catalogProvider,
    catalogManifests: [],
    fetchOfficialArchive: async () => archive.bytes,
    builtinContributions: builtinContributions((spec) => firstStarts.push(structuredClone(spec))),
    now: () => 12_000,
  });
  await firstComposition.manager.install({
    source: { kind: 'catalog', catalogId: entry.catalogId },
    expectedVersion: entry.version,
    expectedDigest: entry.packageDigest,
  });
  await firstComposition.manager.setEnabled(entry.pluginId, { enabled: true, expectedRevision: 2 });
  assert.equal(firstStarts.length, 1);
  await firstRuntime.shutdown('test_restart');

  let resumeStarted;
  const resumedStart = new Promise((resolve) => {
    resumeStarted = resolve;
  });
  const restartedRuntime = runtime(projectRoot);
  const restartedComposition = createPluginManagerRuntimeComposition({
    runtime: restartedRuntime,
    catalogProvider,
    catalogManifests: [],
    builtinContributions: builtinContributions((spec) => resumeStarted(spec)),
    now: () => 12_000,
  });
  const recovery = await restartedRuntime.recoverAfterRestart();
  assert.equal(recovery.resumeRequested, 1);
  await resumedStart;

  const resumed = await waitForPluginLiveState(restartedComposition.manager, entry.pluginId, 'running');
  assert.equal(resumed.intent, 'enabled');
  assert.equal(resumed.live, 'running');
  assert.deepEqual(
    await restartedComposition.builtinSupervisor.callPluginTool(entry.pluginId, 'fixture-tools', 'fixture_tool', {
      value: 'after-restart',
    }),
    { name: 'fixture_tool', args: { value: 'after-restart' } },
  );

  await restartedRuntime.shutdown('test_complete');
});
