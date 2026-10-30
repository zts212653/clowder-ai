import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { OfficialPluginPackageInstaller } from '../src/domains/plugin/official-package-installer.js';
import { createDormantPluginRuntimeComposition } from '../src/domains/plugin/runtime-composition.js';
import { desktopWindowManifest, windowHtml } from './f317-window.fixture.js';
import { staticEditorFixture } from './plugin-static-editor.fixture.js';

for (const outcome of ['refreshed', 'expired', 'stopped'] as const) {
  test(`five slow presence reads use the current ${outcome} observation after complete validation`, async (t) => {
    const f = await staticEditorFixture({ ...desktopWindowManifest(), pluginId: 'official.companion' }, windowHtml);
    let now = 2_000;
    let polls = 0;
    let opens = 0;
    let repairs = 0;
    let held = false;
    let heldPresenceScans = 0;
    let entered!: () => void;
    let release!: () => void;
    const allEntered = new Promise<void>((resolve) => {
      entered = resolve;
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
      onDesktopFailure: (_id, failure) => failures.push(failure),
      desktopExecutor: {
        open: async (spec) => {
          opens++;
          spec.signal.addEventListener('abort', () => spec.onClosed(), { once: true });
          return {
            poll: async () => {
              polls++;
              return 'visible';
            },
            show: async () => {},
            close: async () => {},
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
          if (held && diagnostics?.caller === 'presence' && heldPresenceScans < 5) {
            if (++heldPresenceScans === 5) entered();
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
    const enabled = await runtime.lifecycle.enable(installed.pluginInstanceId, prepared.lifecycleRevision);
    const desktop = runtime.desktopWindows;
    const owner = runtime.ownerDesktop;
    assert.ok(desktop && owner);
    assert.equal(polls, 1);
    now = 16_000; // The first genuine observation still has one second left.
    held = true;
    const reads = Array.from({ length: 5 }, () => owner.presence());
    pending.push(...reads);
    await allEntered;
    now = 18_000; // The captured observation expires during package IO.
    assert.equal(await owner.presence(), null, 'an unrefreshed projection stays expired');
    if (outcome !== 'expired') {
      await desktop.show(); // Publish genuine native replies through the existing observer.
      assert.ok(polls > 1);
    }
    if (outcome === 'stopped') await runtime.lifecycle.disable(installed.pluginInstanceId, enabled.lifecycleRevision);
    release();
    const results = await Promise.all(reads);
    if (outcome === 'refreshed') {
      for (const presence of results) {
        assert.equal(presence?.state, 'visible', 'new evidence published during IO must not be discarded');
        assert.equal(presence?.observedAt, 18_000, 'use the actual native sample without redating it');
        assert.equal(presence?.expiresAt, 33_000, 'the original 15s freshness boundary is unchanged');
      }
    } else {
      assert.deepEqual(results, Array(5).fill(null), 'expired or stopped evidence never becomes current');
      if (outcome === 'expired') assert.equal(polls, 1, 'reads do not poll, renew or restore authority');
    }
    assert.equal(heldPresenceScans, 5, 'each reader still completes its own full package verification');
    assert.equal(opens, 1);
    assert.equal(repairs, 0);
    assert.deepEqual(failures, []);
  });
}
