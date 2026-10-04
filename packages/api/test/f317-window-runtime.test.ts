import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import {
  hasUnexpectedDesktopLoss,
  unexpectedDesktopLossId,
} from '../src/domains/plugin/desktop-window-runtime/desktop-loss.js';
import {
  hasPublishedCompanionV2,
  PUBLISHED_COMPANION_V2,
} from '../src/domains/plugin/desktop-window-runtime/published-companion-v2.js';
import type { DesktopWindowFailure, DesktopWindowLaunch } from '../src/domains/plugin/desktop-window-runtime/types.js';
import { normalizePluginInstanceAfterRestart } from '../src/domains/plugin/host-inventory/restart-recovery.js';
import { FilePluginInventoryStore } from '../src/domains/plugin/host-inventory/stores.js';
import { OfficialPluginPackageInstaller } from '../src/domains/plugin/official-package-installer.js';
import { createDormantPluginRuntimeComposition } from '../src/domains/plugin/runtime-composition.js';
import { MemoryMeetingIntakeStore } from '../src/domains/signal-intake/MeetingIntakeStore.js';
import { MemorySignalRouteStore } from '../src/domains/signal-intake/SignalRouteStore.js';
import { desktopWindowFixture } from './f317-window.fixture.js';

test('optional public Companion fields require the exact verified alpha.13 archive', () => {
  const published = {
    pluginId: 'official.companion',
    version: PUBLISHED_COMPANION_V2.version,
    packageDigest: PUBLISHED_COMPANION_V2.packageDigest,
  };
  assert.equal(hasPublishedCompanionV2(published), true);
  assert.equal(hasPublishedCompanionV2({ ...published, pluginId: 'dev.clowder.window-fixture' }), false);
  assert.equal(hasPublishedCompanionV2({ ...published, version: '0.1.0-alpha.12' }), false);
  assert.equal(
    hasPublishedCompanionV2({
      ...published,
      packageDigest: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
    }),
    false,
  );
});

function fetchSurface(url: string) {
  const parsed = new URL(url);
  return new Promise<{ status: number; body: string; policy: string }>((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port: parsed.port, path: parsed.pathname, headers: { host: parsed.host } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (b: Buffer) => chunks.push(b));
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            body: Buffer.concat(chunks).toString(),
            policy: String(res.headers['content-security-policy']),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

test('installed companion uses the existing Broker, grant and package authority; disable fences before closing', async (t) => {
  const f = await desktopWindowFixture();
  let launch: DesktopWindowLaunch | undefined;
  let visible = true;
  let closes = 0;
  let now = 2_000;
  let bridgePublicCompanionV2: boolean | undefined;
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: f.root,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    now: () => now,
    createCompanionBridge: ({ publicCompanionV2 }) => {
      bridgePublicCompanionV2 = publicCompanionV2;
      return { request: async () => ({ kind: 'error', code: 'unavailable' }), close: async () => {} };
    },
    desktopExecutor: {
      open: async (spec) => {
        launch = spec;
        const served = await fetchSurface(spec.url);
        assert.equal(served.status, 200);
        assert.match(served.body, /Companion fixture/);
        assert.match(served.policy, /frame-ancestors 'none'/);
        assert.match(served.policy, /connect-src 'none'/);
        return {
          poll: async () => (visible ? 'visible' : 'hidden'),
          show: async () => {
            visible = true;
          },
          close: async () => {
            assert.equal((await runtime.brokerStore.snapshot()).staticFeatures?.leases.at(-1)?.state, 'revoked');
            closes++;
          },
        };
      },
    },
  });
  t.after(async () => {
    await runtime.shutdown();
    await f.cleanup();
  });
  assert.ok(runtime.desktopWindows, 'Host must expose the installed desktop consumer');
  const installer = new OfficialPluginPackageInstaller({
    inventory: runtime.inventory,
    packagesRoot: runtime.paths.packagesRoot,
    catalog: [f.entry],
    fetchArchive: async () => f.bytes,
  });
  const installed = await installer.install(f.entry.catalogId, f.entry);
  assert.equal(launch, undefined, 'install does not open a window or capture media');
  const prepared = await runtime.lifecycle.prepare(installed.pluginInstanceId, 1);
  const enabled = await runtime.lifecycle.enable(installed.pluginInstanceId, prepared.lifecycleRevision);
  assert.ok(launch);
  assert.deepEqual(Object.keys(launch).sort(), ['onClosed', 'presentation', 'request', 'signal', 'url']);
  assert.equal(launch.publicCompanionV2, undefined);
  assert.equal(bridgePublicCompanionV2, false);
  const presence = await runtime.desktopWindows.presence();
  assert.equal(presence?.pluginInstanceId, installed.pluginInstanceId);
  assert.equal(presence?.state, 'visible');
  now += runtime.broker.activeRuntimeLeaseTtlMs + 1;
  assert.equal(await runtime.desktopWindows.presence(), null, 'expired observation restores the Hub entry');
  await runtime.lifecycle.disable(installed.pluginInstanceId, enabled.lifecycleRevision);
  launch.onClosed();
  assert.equal(await runtime.desktopWindows.presence(), null, 'late child event cannot resurrect the old window');
  assert.equal(await runtime.desktopWindows.unexpectedLossId(), null, 'intentional disable is not a lost desktop');
  assert.equal((await runtime.inventoryStore.snapshot()).instances[0]?.lastRuntimeError, undefined);
  assert.equal(closes, 1);
  await assert.rejects(fetchSurface(launch.url));
});

test('missing grant blocks opening, and a window closed during startup cannot appear healthy', async (t) => {
  const f = await desktopWindowFixture();
  let opens = 0;
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: f.root,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    desktopExecutor: {
      open: async (spec) => {
        opens++;
        spec.onClosed();
        return { poll: async () => 'visible', show: async () => {}, close: async () => {} };
      },
    },
  });
  t.after(async () => {
    await runtime.shutdown();
    await f.cleanup();
  });
  assert.ok(runtime.desktopWindows);
  const noGrant = { ...f.entry, effectiveGrants: [] };
  const installer = new OfficialPluginPackageInstaller({
    inventory: runtime.inventory,
    packagesRoot: runtime.paths.packagesRoot,
    catalog: [noGrant],
    fetchArchive: async () => f.bytes,
  });
  const installed = await installer.install(noGrant.catalogId, noGrant);
  const prepared = await runtime.lifecycle.prepare(installed.pluginInstanceId, 1);
  await assert.rejects(runtime.lifecycle.enable(installed.pluginInstanceId, prepared.lifecycleRevision));
  assert.equal(opens, 0);
  assert.equal(await runtime.desktopWindows.presence(), null);
  // Isolated fixture simulates an explicit owner grant; production uses inventory grant revisions.
  await runtime.inventoryStore.transaction((tx) => {
    const grant = tx.grants.get(installed.pluginInstanceId)!;
    tx.grants.put({ ...grant, grantRevision: grant.grantRevision + 1, effectiveGrants: ['windows.create'] });
    const instance = tx.instances.get(installed.pluginInstanceId)!;
    tx.instances.put({ ...instance, activationState: 'enabled', runtimeState: 'stopped' });
  });
  await assert.rejects(runtime.supervisor.start(installed.pluginInstanceId));
  assert.equal(opens, 1);
  assert.equal(await runtime.desktopWindows.presence(), null);
});

test('a live desktop loss records the bounded first cause without changing the installed instance', async (t) => {
  const f = await desktopWindowFixture();
  let launch: DesktopWindowLaunch | undefined;
  const reported: DesktopWindowFailure[] = [];
  const now = 4_000;
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: f.root,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    now: () => now,
    onDesktopFailure: (_id, failure) => reported.push(failure),
    desktopExecutor: {
      open: async (spec) => {
        launch = spec;
        // The real executor calls onClosed(undefined) synchronously when the
        // Host aborts its launch signal during loss cleanup.
        spec.signal.addEventListener('abort', () => spec.onClosed(), { once: true });
        return {
          poll: async () => 'visible',
          show: async () => {},
          close: async () => {
            throw new Error('simulated desktop cleanup failure');
          },
        };
      },
    },
  });
  t.after(async () => {
    await runtime.shutdown();
    await f.cleanup();
  });
  const installer = new OfficialPluginPackageInstaller({
    inventory: runtime.inventory,
    packagesRoot: runtime.paths.packagesRoot,
    catalog: [f.entry],
    fetchArchive: async () => f.bytes,
  });
  const installed = await installer.install(f.entry.catalogId, f.entry);
  const prepared = await runtime.lifecycle.prepare(installed.pluginInstanceId, 1);
  await runtime.lifecycle.enable(installed.pluginInstanceId, prepared.lifecycleRevision);
  assert.ok(launch);
  (launch.onClosed as (failure: unknown) => void)({ reason: 'renderer-gone', exitCode: 17, signal: null });
  const snapshot = async () => {
    const instance = (await runtime.inventoryStore.snapshot()).instances[0];
    assert.ok(instance);
    return instance;
  };
  let failed = await snapshot();
  for (let attempt = 0; failed.runtimeState !== 'crashed' && attempt < 100; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    failed = await snapshot();
  }
  assert.equal(failed.pluginInstanceId, installed.pluginInstanceId);
  assert.equal(failed.runtimeState, 'crashed');
  assert.equal(
    await runtime.desktopWindows?.unexpectedLossId(),
    null,
    'another desktop plugin must not be labeled Companion',
  );
  assert.equal(hasUnexpectedDesktopLoss(await runtime.inventoryStore.snapshot(), f.entry.pluginId), true);
  const lossId = unexpectedDesktopLossId(await runtime.inventoryStore.snapshot(), f.entry.pluginId);
  assert.ok(lossId, 'the failure has a durable identity for one dismissible notice');
  assert.deepEqual(failed.lastRuntimeError, {
    code: 'UNEXPECTED_RUNTIME_FAILURE',
    desktopReason: 'renderer-gone',
    exitCode: 17,
    signal: null,
    occurredAt: now,
  });
  assert.deepEqual(
    reported.map((failure) => failure.reason),
    ['renderer-gone'],
  );
  assert.equal(reported[0]?.initiator, 'executor');
  assert.ok(failed.lastRuntimeError);
  const reloaded = await new FilePluginInventoryStore(runtime.paths.inventorySnapshotPath).snapshot();
  assert.deepEqual(reloaded.instances[0]?.lastRuntimeError, failed.lastRuntimeError);
  const afterRestart = normalizePluginInstanceAfterRestart(failed, now + 1);
  assert.ok(afterRestart);
  assert.equal(
    unexpectedDesktopLossId({ ...reloaded, instances: [afterRestart] }, f.entry.pluginId),
    lossId,
    'a restart must not turn the same failure into a new notice',
  );
  assert.notEqual(
    unexpectedDesktopLossId(
      {
        ...reloaded,
        instances: [{ ...afterRestart, lastRuntimeError: { ...failed.lastRuntimeError, occurredAt: now + 1 } }],
      },
      f.entry.pluginId,
    ),
    lossId,
    'a new observed failure must be distinguishable even for the same installed body',
  );
  assert.equal(
    hasUnexpectedDesktopLoss({ ...reloaded, instances: [afterRestart] }, f.entry.pluginId),
    true,
    'restart normalization retains the owner-visible failure until a new runtime starts',
  );
  assert.equal(
    hasUnexpectedDesktopLoss(
      { ...reloaded, instances: [{ ...afterRestart, activationState: 'disabled' }] },
      f.entry.pluginId,
    ),
    false,
    'an intentionally disabled body is not an active desktop loss',
  );
  (launch.onClosed as (failure: unknown) => void)({ reason: 'process-exit', exitCode: 0, signal: null });
  assert.deepEqual((await snapshot()).lastRuntimeError, failed.lastRuntimeError);
});
