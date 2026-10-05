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
import { MemoryMeetingIntakeStore, MemorySignalRouteStore } from '../dist/domains/signal-intake/index.js';
import { catalogEntry, packageArchive } from './plugin-official-package-installer.fixture.js';

async function desktopManager(
  t,
  { preparationFails = false, mixedDesktopCapabilities = false, projectRoot: restartedRoot } = {},
) {
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
        capabilities: ['windows.create'],
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
  if (mixedDesktopCapabilities) manifest.features[0].capabilities.push('events.publish');
  const archive = await packageArchive({ packageManifest: manifest, extraFiles: { 'renderer/index.html': html } });
  const entry = catalogEntry(archive.integrity, {
    pluginId: manifest.pluginId,
    version: manifest.version,
    effectiveGrants: ['windows.create'],
  });
  const observed = { prepared: 0, opens: 0, closes: 0 };
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    desktopExecutor: {
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
    builtinContributions: {
      materializer: {
        resolve: async () => {
          throw new Error('desktop packages must keep their dedicated runtime');
        },
      },
      configuration: { readConfig: async () => undefined, readSecret: async () => undefined },
    },
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

  await after.runtime.recoverAfterRestart({ desktopWindowsAfter: new Promise(() => {}) });
  await after.runtime.shutdown('api_shutdown');

  assert.equal(after.observed.opens, 0);
  const current = await instance();
  assert.equal(current.activationState, 'enabled');
  assert.equal(current.runtimeState, 'stopped');
  assert.equal(current.lastRuntimeError, undefined);
});

test('Manager preserves official desktop preparation and routes enable/disable to the existing desktop authority', async (t) => {
  const { entry, observed, runtime, composition } = await desktopManager(t);
  const installed = await composition.officialRouteInstaller.install(entry.catalogId, entry);
  assert.equal(observed.prepared, 1, 'the legacy official route must retain Host component preparation');
  assert.equal(observed.opens, 0, 'install never opens a desktop window');
  const prepared = await runtime.lifecycle.prepare(installed.pluginInstanceId, 1);
  await composition.manager.setEnabled(entry.pluginId, { enabled: true, expectedRevision: prepared.lifecycleRevision });
  assert.equal(observed.opens, 1, 'Manager must delegate this builtin to DesktopWindowPluginRuntime');
  assert.equal((await runtime.desktopWindows.presence()).pluginInstanceId, installed.pluginInstanceId);
  const current = (await composition.manager.get(entry.pluginId)).plugin;
  assert.equal(current.contributions[0].kind, 'desktop-window');
  assert.equal(current.live, 'running');
  assert.equal(current.capabilities.find((capability) => capability.id === 'windows.create').active, true);
  await composition.manager.setEnabled(entry.pluginId, { enabled: false, expectedRevision: current.lifecycleRevision });
  assert.equal(observed.closes, 1);
  assert.equal(await runtime.desktopWindows.presence(), null);
  assert.equal((await composition.manager.get(entry.pluginId)).plugin.capabilities[0].active, false);
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

test('Manager installer retains the closed desktop admission shape instead of accepting a generic builtin', async (t) => {
  const { entry, observed, runtime, composition } = await desktopManager(t, { mixedDesktopCapabilities: true });
  await assert.rejects(composition.officialRouteInstaller.install(entry.catalogId, entry), {
    code: 'UNSUPPORTED_TRANSPORT',
  });
  assert.equal(observed.prepared, 0);
  assert.equal((await runtime.inventoryStore.snapshot()).instances.length, 0);
});
