import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate as turn } from 'node:timers/promises';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { OfficialPluginPackageInstaller } from '../src/domains/plugin/official-package-installer.js';
import { createDormantPluginRuntimeComposition } from '../src/domains/plugin/runtime-composition.js';
import { desktopWindowManifest, windowHtml } from './f317-window.fixture.js';
import { staticEditorFixture } from './plugin-static-editor.fixture.js';

test('an owner show joins the healthy in-flight observation instead of requiring repair during its expired projection', async (t) => {
  const f = await staticEditorFixture({ ...desktopWindowManifest(), pluginId: 'official.companion' }, windowHtml);
  let now = 2_000;
  let closes = 0;
  let opens = 0;
  let repairs = 0;
  let inject = false;
  let held = false;
  let peerEntered = 0;
  let reportPeers!: () => void;
  const peersEntered = new Promise<void>((resolve) => {
    reportPeers = resolve;
  });
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const failures: unknown[] = [];
  const pending: Promise<unknown>[] = [];
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: f.root,
    messageStore: new MessageStore(),
    now: () => now,
    companionArchives: [{ ...f.entry, contract: '0.1.0-beta.21' }],
    onDesktopFailure: (_id, failure) => {
      failures.push(failure);
    },
    desktopExecutor: {
      open: async (spec) => {
        opens++;
        spec.signal.addEventListener('abort', () => spec.onClosed(), { once: true });
        return {
          poll: async () => 'visible',
          show: async () => {},
          close: async () => {
            closes++;
          },
        };
      },
    },
  });
  t.after(async () => {
    release();
    await Promise.allSettled(pending);
    await runtime.shutdown();
    await f.cleanup();
  });
  const locate = runtime.packages.resolveInstalledPackage.bind(runtime.packages);
  runtime.packages.resolveInstalledPackage = async (digest) => {
    const pkg = await locate(digest);
    return {
      ...pkg,
      verifyStaticIntegrity: async (diagnostics) => {
        await (pkg.verifyStaticIntegrity?.(diagnostics) ?? pkg.verifyIntegrity());
        if (inject && !held && diagnostics?.caller === 'observer') {
          held = true;
          enter();
          await gate;
        }
        if (held && diagnostics?.caller === 'presence') {
          if (++peerEntered === 5) reportPeers();
          await gate;
        }
      },
    };
  };
  const repair = runtime.lifecycle.repair.bind(runtime.lifecycle);
  runtime.lifecycle.repair = (...args) => {
    repairs++;
    return repair(...args);
  };
  const installed = await new OfficialPluginPackageInstaller({
    inventory: runtime.inventory,
    packagesRoot: runtime.paths.packagesRoot,
    catalog: [f.entry],
    fetchArchive: async () => f.bytes,
  }).install(f.entry.catalogId, f.entry);
  const prepared = await runtime.lifecycle.prepare(installed.pluginInstanceId, 1);
  await runtime.lifecycle.enable(installed.pluginInstanceId, prepared.lifecycleRevision);
  const desktop = runtime.desktopWindows;
  const owner = runtime.ownerDesktop;
  assert.ok(desktop && owner);
  inject = true;
  // The first explicit show reaches the same observer path as its periodic loop.
  const first = desktop.show();
  pending.push(first);
  await entered;
  const peerReads = Array.from({ length: 5 }, () => owner.presence());
  pending.push(...peerReads);
  await peersEntered;
  now += 22_000;
  assert.equal(await owner.presence(), null, 'the old projection really expired while the body remains healthy');
  assert.equal((await runtime.inventoryStore.snapshot()).instances[0]?.runtimeState, 'healthy');
  let settled = false;
  const showing = owner
    .show()
    .then(
      () => 'shown',
      (error: unknown) => ({ error }),
    )
    .finally(() => {
      settled = true;
    });
  pending.push(showing);
  await turn();
  const beforeRelease = settled;
  release();
  await first;
  assert.equal(await showing, 'shown', 'a healthy body must not enter the repair-only branch');
  await Promise.all(peerReads);
  assert.equal(beforeRelease, false, 'show waits for the current genuine observation');
  assert.equal((await owner.presence())?.state, 'visible');
  assert.equal(repairs, 0);
  assert.equal(opens, 1);
  assert.equal(closes, 0);
  assert.deepEqual(failures, []);
});

test('a rejected fresh observation requested by show closes the expired body before another heartbeat can replace it', async (t) => {
  const f = await staticEditorFixture({ ...desktopWindowManifest(), pluginId: 'official.companion' }, windowHtml);
  let now = 2_000;
  let failPoll = false;
  let closes = 0;
  let shows = 0;
  let polls = 0;
  let reportClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    reportClosed = resolve;
  });
  const failures: unknown[] = [];
  const fault = new Error('native poll rejected');
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: f.root,
    messageStore: new MessageStore(),
    now: () => now,
    companionArchives: [{ ...f.entry, contract: '0.1.0-beta.21' }],
    onDesktopFailure: (_id, failure) => {
      failures.push(failure);
    },
    desktopExecutor: {
      open: async (spec) => {
        spec.signal.addEventListener('abort', () => spec.onClosed(), { once: true });
        return {
          poll: async () => {
            polls++;
            if (failPoll) throw fault;
            return 'visible';
          },
          show: async () => {
            shows++;
          },
          close: async () => {
            closes++;
            reportClosed();
          },
        };
      },
    },
  });
  t.after(async () => {
    await runtime.shutdown();
    await f.cleanup();
  });
  const installed = await new OfficialPluginPackageInstaller({
    inventory: runtime.inventory,
    packagesRoot: runtime.paths.packagesRoot,
    catalog: [f.entry],
    fetchArchive: async () => f.bytes,
  }).install(f.entry.catalogId, f.entry);
  const prepared = await runtime.lifecycle.prepare(installed.pluginInstanceId, 1);
  await runtime.lifecycle.enable(installed.pluginInstanceId, prepared.lifecycleRevision);
  const desktop = runtime.desktopWindows;
  assert.ok(desktop);
  assert.ok(await desktop.presence());
  assert.equal(polls, 1);
  // Only the Host clock advances: the real periodic timer has not fired and
  // show must create its own pre-show attempt, rather than join a failed loop.
  now += 20_000;
  failPoll = true;
  await assert.rejects(desktop.show(), (error) => error === fault);
  assert.equal(failures.length, 1, 'the pre-show rejection is a terminal Host loss');
  await closed;
  assert.equal(closes, 1, 'the physical body closes before another heartbeat can overwrite the failure');
  assert.equal(shows, 0, 'the rejected pre-show observation cannot send a native show effect');
  failPoll = false;
  await assert.rejects(desktop.show(), /desktop body unavailable/);
  assert.equal(polls, 2, 'the closed run cannot obtain a successful replacement heartbeat');
});
