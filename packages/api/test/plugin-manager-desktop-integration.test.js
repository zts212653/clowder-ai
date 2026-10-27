import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../dist/domains/plugin/runtime-composition.js';
import { catalogEntry, packageArchive } from './plugin-official-package-installer.fixture.js';

async function desktopManager(t, { preparationFails = false, projectRoot: restartedRoot } = {}) {
  const projectRoot = restartedRoot ?? (await mkdtemp(join(tmpdir(), 'f202-desktop-integration-')));
  const html = '<!doctype html><html><body>Installed companion</body></html>';
  const manifest = {
    pluginId: 'dev.clowder.window-fixture',
    version: '1.0.0',
    contractVersion: '0.1.0',
    name: 'Window',
    runtime: { transport: 'builtin' },
    features: [
      {
        id: 'body',
        name: 'Body',
        resources: [],
        contributions: [{ type: 'desktop-window', id: 'body' }],
      },
    ],
    contributions: [
      {
        type: 'desktop-window',
        id: 'body',
        role: 'companion',
        bridgeVersion: '1.0.0',
        surface: {
          entrypoint: 'renderer/index.html',
          integrity: `sha256-${createHash('sha256').update(html).digest('base64')}`,
        },
        presentation: {
          width: 320,
          height: 350,
          frame: false,
          transparent: true,
          alwaysOnTop: true,
          skipTaskbar: true,
        },
      },
    ],
  };
  const archive = await packageArchive({ packageManifest: manifest, extraFiles: { 'renderer/index.html': html } });
  const entry = catalogEntry(archive.integrity, {
    pluginId: manifest.pluginId,
    version: manifest.version,
  });
  const observed = { prepared: 0, opens: 0, closes: 0 };
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    messageStore: new MessageStore(),
    processes: {
      spawn: async () => {
        assert.fail('desktop packages must not spawn a stdio runtime');
      },
    },
    desktopExecutor: {
      prepare: async () => {
        assert.equal(
          (await runtime.brokerStore.snapshot()).sessions.filter((session) => session.state === 'active').length,
          0,
          'component preparation must finish before a runtime lease is opened',
        );
        observed.prepared++;
        if (preparationFails) throw new Error('desktop component unavailable');
      },
      open: async () => {
        observed.opens++;
        return {
          poll: async () => 'visible',
          show: async () => {},
          close: async () => {
            assert.equal((await runtime.brokerStore.snapshot()).staticFeatures.leases.at(-1).state, 'revoked');
            observed.closes++;
          },
        };
      },
    },
  });
  t.after(async () => {
    await runtime.shutdown();
    // A restarted harness shares the first harness's root; only the creator removes it.
    if (!restartedRoot) await rm(projectRoot, { recursive: true, force: true });
  });
  const composition = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: Date.now() }) },
    officialRouteCatalogProvider: {
      snapshot: async () => ({ entries: [entry], status: 'fresh', checkedAt: Date.now() }),
    },
    catalogManifests: [],
    fetchOfficialArchive: async () => archive.bytes,
    prepareDesktopComponent: async () => {
      observed.prepared++;
      if (preparationFails) throw new Error('desktop component unavailable');
    },
  });
  return { entry, observed, runtime, composition, projectRoot };
}

async function eventually(check, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function enabledDesktopThenRestart(t) {
  const before = await desktopManager(t);
  const installed = await before.composition.officialRouteInstaller.install(before.entry.catalogId, before.entry);
  const prepared = await before.runtime.lifecycle.prepare(installed.pluginInstanceId, 1);
  await before.composition.manager.setEnabled(before.entry.pluginId, {
    enabled: true,
    expectedRevision: prepared.lifecycleRevision,
  });
  assert.equal(before.observed.opens, 1);
  await before.runtime.shutdown('api_shutdown');
  const after = await desktopManager(t, { projectRoot: before.projectRoot });
  const instance = async () =>
    (await after.runtime.inventoryStore.snapshot()).instances.find(
      (candidate) => candidate.pluginInstanceId === installed.pluginInstanceId,
    );
  return { after, instance };
}

// The companion Host bridge calls app.inject. A desktop window resumed while main()
// is still registering routes boots Fastify early, and the next app.register throws
// AVV_ERR_ROOT_PLG_BOOTED (runtime startup outage, 2026-09-23).
test('restart recovery holds an enabled desktop window, and its leases, until the Host is listening', async (t) => {
  const { after, instance } = await enabledDesktopThenRestart(t);
  let releaseHost;
  const hostListening = new Promise((resolve) => {
    releaseHost = resolve;
  });

  const recovery = await after.runtime.recoverAfterRestart({ desktopWindowsAfter: hostListening });
  assert.equal(recovery.resumeRequested, 1);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(after.observed.opens, 0, 'the desktop window must not open before the Host listens');
  assert.equal((await instance()).runtimeState, 'stopped', 'no runtime start (and no broker lease) while held');

  releaseHost();
  await eventually(() => after.observed.opens === 1, 'the held desktop window opens once the Host listens');
  await eventually(async () => (await instance()).runtimeState === 'healthy', 'the resumed window becomes healthy');
  await after.runtime.shutdown('api_shutdown');
});

test('shutdown while a desktop window is held keeps enabled intent for the next boot', async (t) => {
  const { after, instance } = await enabledDesktopThenRestart(t);
  const hostListening = deferred();

  await after.runtime.recoverAfterRestart({ desktopWindowsAfter: hostListening.promise });
  await after.runtime.shutdown('api_shutdown');

  assert.equal(after.observed.opens, 0);
  const current = await instance();
  assert.equal(current.activationState, 'enabled');
  assert.equal(current.runtimeState, 'stopped');
  assert.equal(current.lastRuntimeError, undefined);

  try {
    hostListening.resolve();
    // The gate's reaction queues first; prepare joins that same instance queue
    // without changing an already-ready configuration.
    await Promise.resolve();
    const resumed = await after.runtime.lifecycle.prepare(current.pluginInstanceId, current.lifecycleRevision);
    assert.equal(after.observed.opens, 0, 'shutdown cancels the old Host gate');
    assert.equal(resumed.activationState, 'enabled');
    assert.equal(resumed.runtimeState, 'stopped');
    assert.equal(resumed.lastRuntimeError, undefined);
  } finally {
    await after.runtime.shutdown('test_complete');
  }
});

test('shutdown drains an admitted restart failure without overwriting enabled intent', async (t) => {
  const { after, instance } = await enabledDesktopThenRestart(t);
  const startEntered = deferred();
  const releaseStart = deferred();
  const supervisorStopped = deferred();
  const stopped = await instance();
  const originalStopAll = after.runtime.supervisor.stopAll.bind(after.runtime.supervisor);
  after.runtime.supervisor.stopAll = async (reason) => {
    await originalStopAll(reason);
    supervisorStopped.resolve();
  };
  after.runtime.supervisor.start = async () => {
    startEntered.resolve();
    await releaseStart.promise;
    throw new Error('restart was cancelled during Host shutdown');
  };
  await after.runtime.recoverAfterRestart();
  await startEntered.promise;
  const completion = after.runtime.shutdown('api_shutdown');

  try {
    await supervisorStopped.promise;
    const settled = await Promise.race([
      completion.then(() => 'shutdown-completed'),
      new Promise((resolve) => setImmediate(() => resolve('restart-still-pending'))),
    ]);
    assert.equal(settled, 'restart-still-pending', 'shutdown must join the admitted restart operation');
    // Cancellation must precede the deferred failure; completing shutdown must
    // also join its inventory projection before a fixture can remove the root.
    releaseStart.resolve();
    await completion;
    const current = await after.runtime.lifecycle.prepare(stopped.pluginInstanceId, stopped.lifecycleRevision);
    assert.equal(current.activationState, 'enabled');
    assert.equal(current.runtimeState, 'stopped');
    assert.equal(current.lastRuntimeError, undefined);
  } finally {
    releaseStart.resolve();
    await completion;
  }
});

test('shutdown closes a recovered desktop that acquires ownership during the restart drain', async (t) => {
  const { after, instance } = await enabledDesktopThenRestart(t);
  const startEntered = deferred();
  const releaseStart = deferred();
  const supervisorStopped = deferred();
  const originalStart = after.runtime.supervisor.start.bind(after.runtime.supervisor);
  const originalStopAll = after.runtime.supervisor.stopAll.bind(after.runtime.supervisor);
  after.runtime.supervisor.start = async (id) => {
    startEntered.resolve();
    await releaseStart.promise;
    return originalStart(id);
  };
  after.runtime.supervisor.stopAll = async (reason) => {
    await originalStopAll(reason);
    supervisorStopped.resolve();
  };
  await after.runtime.recoverAfterRestart();
  await startEntered.promise;
  const completion = after.runtime.shutdown('api_shutdown');

  try {
    await supervisorStopped.promise;
    releaseStart.resolve();
    await completion;
    assert.equal(after.observed.opens, 1, 'the admitted start completes through the real desktop runtime');
    assert.equal(after.observed.closes, 1, 'shutdown must stop ownership acquired after its first snapshot');
    assert.equal(await after.runtime.desktopWindows.presence(), null);
    const current = await instance();
    assert.equal(current.activationState, 'enabled');
    assert.equal(current.runtimeState, 'stopped');
    assert.equal(current.lastRuntimeError, undefined);
  } finally {
    releaseStart.resolve();
    await completion;
    await after.runtime.shutdown('test_complete');
  }
});

test('Manager preserves official desktop preparation and routes enable/disable to the existing desktop authority', async (t) => {
  const { entry, observed, runtime, composition } = await desktopManager(t);
  const installed = await composition.officialRouteInstaller.install(entry.catalogId, entry);
  assert.equal(observed.prepared, 1, 'the legacy official route must retain Host component preparation');
  assert.equal(observed.opens, 0, 'install never opens a desktop window');
  const prepared = await runtime.lifecycle.prepare(installed.pluginInstanceId, 1);
  await composition.manager.setEnabled(entry.pluginId, { enabled: true, expectedRevision: prepared.lifecycleRevision });
  assert.equal(observed.prepared, 2, 'enable must prepare the current Host component, including after a Host update');
  assert.equal(observed.opens, 1, 'Manager must delegate this builtin to DesktopWindowPluginRuntime');
  assert.equal((await runtime.desktopWindows.presence()).pluginInstanceId, installed.pluginInstanceId);
  const current = (await composition.manager.get(entry.pluginId)).plugin;
  assert.equal(current.contributions[0].kind, 'desktop-window');
  assert.equal(current.live, 'running');
  await composition.manager.setEnabled(entry.pluginId, { enabled: false, expectedRevision: current.lifecycleRevision });
  assert.equal(observed.closes, 1);
  assert.equal(await runtime.desktopWindows.presence(), null);
  const disabled = (await composition.manager.get(entry.pluginId)).plugin;
  assert.equal(disabled.intent, 'disabled');
  assert.equal(disabled.live, 'stopped');
});

test('Manager official installation fails before inventory admission if desktop preparation fails', async (t) => {
  const { entry, observed, runtime, composition } = await desktopManager(t, { preparationFails: true });
  await assert.rejects(composition.officialRouteInstaller.install(entry.catalogId, entry), {
    code: 'HOST_COMPONENT_UNAVAILABLE',
  });
  assert.equal(observed.prepared, 1);
  assert.equal(observed.opens, 0);
  assert.equal((await runtime.inventoryStore.snapshot()).instances.length, 0);
});

test('Manager repairs a current failed desktop activation without changing its package or instance', async (t) => {
  const { entry, observed, runtime, composition } = await desktopManager(t);
  const installed = await composition.officialRouteInstaller.install(entry.catalogId, entry);
  await runtime.lifecycle.prepare(installed.pluginInstanceId, 1);
  await runtime.inventoryStore.transaction((tx) => {
    const instance = tx.instances.get(installed.pluginInstanceId);
    tx.instances.put({ ...instance, activationState: 'error', runtimeState: 'stopped' });
  });
  const before = await runtime.inventoryStore.snapshot();
  const failed = (await composition.manager.getLocal(entry.pluginId)).plugin;
  assert.equal(failed.actions.repair, true);
  await assert.rejects(composition.manager.repair(entry.pluginId, { expectedRevision: failed.lifecycleRevision - 1 }), {
    code: 'STALE_REVISION',
  });
  assert.equal(observed.opens, 0);
  await composition.manager.repair(entry.pluginId, { expectedRevision: failed.lifecycleRevision });
  const repaired = (await composition.manager.getLocal(entry.pluginId)).plugin;
  assert.equal(repaired.live, 'running');
  assert.notEqual(repaired.actions.repair, true);
  assert.equal(repaired.pluginInstanceId, installed.pluginInstanceId);
  assert.deepEqual((await runtime.inventoryStore.snapshot()).packages, before.packages);
  await assert.rejects(composition.manager.repair(entry.pluginId, { expectedRevision: repaired.lifecycleRevision }), {
    code: 'ACTION_NOT_ALLOWED',
  });
  assert.equal(observed.opens, 1);
});
