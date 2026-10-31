import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { packageDirectoryName } from '../src/domains/plugin/external-runtime/filesystem-package-locator.js';
import { normalizePluginInstanceAfterRestart } from '../src/domains/plugin/host-inventory/restart-recovery.js';
import { OfficialPluginPackageInstaller } from '../src/domains/plugin/official-package-installer.js';
import {
  createDormantPluginRuntimeComposition,
  createPluginManagerRuntimeComposition,
} from '../src/domains/plugin/runtime-composition.js';
import { sessionAuthPlugin, sessionRoute } from '../src/infrastructure/session-auth.js';
import { registerConciergeDesktopRoutes } from '../src/routes/concierge-desktop.js';
import { desktopWindowManifest, windowHtml } from './f317-window.fixture.js';
import { staticEditorFixture } from './plugin-static-editor.fixture.js';

test('sleep beyond TTL stays fenced until an owner restore creates fresh desktop authority without media', async (t) => {
  const f = await staticEditorFixture({ ...desktopWindowManifest(), pluginId: 'official.companion' }, windowHtml);
  let now = 2_000;
  let opens = 0;
  let bridgeCloses = 0;
  let bridgeRequests = 0;
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: f.root,
    messageStore: new MessageStore(),
    now: () => now,
    // This isolated archive is paired by its computed immutable digest, exactly
    // as production pairs the published archive. It is not an alpha.13 claim.
    companionArchives: [{ ...f.entry, contract: '0.1.0-beta.21' }],
    createCompanionBridge: () => ({
      request: async () => {
        bridgeRequests++;
        return { kind: 'error', code: 'unavailable' };
      },
      close: async () => {
        bridgeCloses++;
      },
    }),
    desktopExecutor: {
      open: async (spec) => {
        opens++;
        spec.signal.addEventListener('abort', () => spec.onClosed(), { once: true });
        return { poll: async () => 'visible', show: async () => {}, close: async () => {} };
      },
    },
  });
  const app = Fastify();
  t.after(async () => {
    await app.close();
    await runtime.shutdown();
    await f.cleanup();
  });
  const entry = { ...f.entry };
  const installed = await new OfficialPluginPackageInstaller({
    inventory: runtime.inventory,
    packagesRoot: runtime.paths.packagesRoot,
    catalog: [entry],
    fetchArchive: async () => f.bytes,
  }).install(entry.catalogId, entry);
  const prepared = await runtime.lifecycle.prepare(installed.pluginInstanceId, 1);
  await runtime.lifecycle.enable(installed.pluginInstanceId, prepared.lifecycleRevision);
  const before = await runtime.brokerStore.snapshot();
  const oldFeature = before.staticFeatures!.leases.at(-1)!;
  now += 122_000;
  assert.equal(await runtime.desktopWindows!.presence(), null);
  for (let attempt = 0; attempt < 80; attempt++) {
    if ((await runtime.inventoryStore.snapshot()).instances[0]?.runtimeState === 'crashed') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal((await runtime.inventoryStore.snapshot()).instances[0]?.runtimeState, 'crashed');
  assert.equal(opens, 1, 'a timer or read does not restore the old window or media');
  assert.equal(bridgeCloses, 1, 'old bridge is closed before restoration');
  await assert.rejects(
    runtime.desktopWindows!.features.run(oldFeature.executionLease, async () => assert.fail('old effect')),
  );
  // A real Host restart normalizes crashed -> enabled/stopped but retains the loss.
  await runtime.inventoryStore.transaction((tx) => {
    const instance = tx.instances.get(installed.pluginInstanceId)!;
    const normalized = normalizePluginInstanceAfterRestart(instance, now);
    assert.ok(normalized);
    tx.instances.put(normalized);
  });
  const manager = createPluginManagerRuntimeComposition({
    runtime,
    catalogProvider: { snapshot: async () => ({ entries: [], status: 'fresh', checkedAt: now }) },
    catalogManifests: [],
  }).manager;
  const retained = (await manager.getLocal('official.companion')).plugin;
  assert.equal(retained.live, 'stopped');
  assert.equal(retained.actions.repair, true, 'the same retained desktop loss must stay repairable after restart');
  await manager.repair('official.companion', { expectedRevision: retained.lifecycleRevision! });
  assert.equal(opens, 2);
  await app.register(cookie);
  await app.register(sessionAuthPlugin);
  await app.register(sessionRoute, { ownerUserId: 'default-user' });
  registerConciergeDesktopRoutes(app, {
    ownerUserId: 'default-user',
    desktop: runtime.ownerDesktop ?? runtime.desktopWindows,
    now: () => now,
  });
  const login = await app.inject({ method: 'GET', url: '/api/session' });
  const headers = { cookie: String(login.headers['set-cookie']).split(';')[0]!, origin: 'http://localhost:5102' };
  const restored = await app.inject({ method: 'POST', url: '/api/concierge/desktop/show', headers, payload: {} });
  assert.equal(restored.statusCode, 200, restored.body);
  assert.equal(restored.json().presence.state, 'visible');
  assert.equal(opens, 2);
  assert.equal(bridgeRequests, 0, 'window restoration never starts a native call, action or media');
  const after = await runtime.brokerStore.snapshot();
  const next = after.staticFeatures!.leases.at(-1)!;
  assert.equal(after.sessions[0]!.phase, 'closed');
  assert.equal(after.runtimeLeases[0]!.state, 'closed');
  assert.equal(after.staticFeatures!.leases[0]!.state, 'revoked');
  assert.notEqual(next.executionLease, oldFeature.executionLease);
  assert.notEqual(next.runtimeLeaseId, oldFeature.runtimeLeaseId);
  assert.ok(next.activationRevision > oldFeature.activationRevision);
  assert.equal(await runtime.desktopWindows!.unexpectedLossId(), null);
  await runtime.lifecycle.disable(
    installed.pluginInstanceId,
    (await runtime.inventoryStore.snapshot()).instances[0]!.lifecycleRevision,
  );
  const disabledRow = (await manager.getLocal('official.companion')).plugin;
  assert.notEqual(disabledRow.actions.repair, true);
  await assert.rejects(manager.repair('official.companion', { expectedRevision: disabledRow.lifecycleRevision! }), {
    code: 'ACTION_NOT_ALLOWED',
  });
  const disabled = await app.inject({ method: 'POST', url: '/api/concierge/desktop/show', headers, payload: {} });
  assert.equal(disabled.statusCode, 409, 'owner disable cannot be re-enabled by restore');
  assert.equal(opens, 2);
  await runtime.inventoryStore.transaction((tx) => {
    const instance = tx.instances.get(installed.pluginInstanceId)!;
    tx.instances.put({ ...instance, activationState: 'enabled', runtimeState: 'crashed' });
  });
  await writeFile(
    join(runtime.paths.packagesRoot, packageDirectoryName(entry.packageDigest), 'package.tgz'),
    'damaged fixture',
  );
  const damaged = await app.inject({ method: 'POST', url: '/api/concierge/desktop/show', headers, payload: {} });
  assert.equal(damaged.statusCode, 409, 'restore re-verifies the archive instead of trusting the old generation');
  assert.equal(opens, 2);
});
