import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { OfficialPluginPackageInstaller } from '../src/domains/plugin/official-package-installer.js';
import { createDormantPluginRuntimeComposition } from '../src/domains/plugin/runtime-composition.js';
import { desktopWindowFixture } from './f317-window.fixture.js';

for (const scenario of ['competing-read', 'presence-reads', 'necessary-write']) {
  test(`ordinary desktop observation preserves freshness with ${scenario} persistence latency`, async (t) => {
    const f = await desktopWindowFixture();
    let now = 2_000;
    let polls = 0;
    let inject = false;
    let writes = 0;
    let closes = 0;
    const failures = [];
    let runtime;
    const originalWrite = fs.writeFile;
    t.after(async () => {
      t.diagnostic(
        JSON.stringify({
          scenario,
          writes,
          polls,
          closes,
          failureReasons: failures.map((failure) => failure.observation?.error?.reason),
        }),
      );
      inject = false;
      await runtime?.shutdown();
      fs.writeFile = originalWrite;
      syncBuiltinESMExports();
      await f.cleanup();
    });
    fs.writeFile = async (...args) => {
      if (inject && String(args[0]).startsWith(`${runtime.brokerStore.path}.tmp-`)) {
        writes++;
        now += scenario === 'necessary-write' ? 16_000 : 8_000;
      }
      return originalWrite(...args);
    };
    syncBuiltinESMExports();
    runtime = createDormantPluginRuntimeComposition({
      projectRoot: f.root,
      messageStore: new MessageStore(),
      now: () => now,
      onDesktopFailure: (_id, failure) => {
        inject = false;
        failures.push(failure);
      },
      desktopExecutor: {
        open: async (spec) => {
          spec.signal.addEventListener('abort', () => spec.onClosed(), { once: true });
          return {
            poll: async () => {
              if (++polls === 2) inject = true;
              return 'visible';
            },
            show: async () => {},
            close: async () => {
              closes++;
            },
          };
        },
      },
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
    const before = await runtime.brokerStore.snapshot();
    if (scenario === 'presence-reads') {
      inject = true;
      const answers = [];
      for (let i = 0; i < 3; i++) answers.push(await runtime.ownerDesktop.presence());
      assert.equal(failures.length, 0);
      assert.equal(closes, 0);
      assert.equal((await runtime.brokerStore.snapshot()).sessions[0].phase, 'active');
      t.diagnostic(JSON.stringify({ presenceStates: answers.map((answer) => answer?.state ?? null) }));
      assert.ok(
        answers.every((answer) => answer?.state === 'visible'),
        'read-only owner requests cannot age away a fresh desktop observation',
      );
      assert.equal(writes, 0);
      return;
    }
    const renew = runtime.broker.renewRuntimeLease.bind(runtime.broker);
    runtime.broker.renewRuntimeLease = async (connectionId) => {
      // A real owner presence consumer enters the same store queues after the
      // native reply. Its authority read must not become a competing disk write.
      if (scenario === 'competing-read' && polls === 2) {
        assert.equal((await runtime.ownerDesktop.presence())?.state, 'visible');
      }
      return renew(connectionId);
    };
    if (scenario === 'competing-read') {
      await runtime.desktopWindows.show();
      const presence = await runtime.ownerDesktop.presence();
      assert.equal(presence?.state, 'visible');
      assert.equal(now - presence.observedAt, 0, 'a new native reply follows the slow renewal');
      assert.equal(polls, 3);
      assert.equal(writes, 1, 'only the necessary lease renewal commits');
      assert.equal(failures.length, 0);
      assert.equal(closes, 0);
      const after = await runtime.brokerStore.snapshot();
      assert.deepEqual(after.calls, before.calls);
      assert.equal(after.sessions[0].brokerSessionId, before.sessions[0].brokerSessionId);
      assert.equal(after.sessions[0].phase, 'active');
      assert.equal(after.staticFeatures.leases.at(-1).state, 'active');
    } else {
      // Repeated real lifecycle/show/authority/presence rounds with an expensive
      // necessary write. This is virtual service time, not native OS stability.
      for (let cycle = 0; cycle < 3; cycle++) {
        await runtime.desktopWindows.show();
        const presence = await runtime.desktopWindows.presence();
        assert.equal(presence?.state, 'visible');
        assert.equal(presence.observedAt, now, 'never redate the pre-write native reply');
        assert.equal(presence.expiresAt - presence.observedAt, 15_000);
      }
      assert.equal(polls, 7, 'initial plus two genuine polls per slow show');
      assert.equal(writes, 3, 'only necessary renewals commit; refresh reads do not renew again');
      assert.equal(failures.length, 0);
      assert.equal(closes, 0);
      const after = await runtime.brokerStore.snapshot();
      assert.equal(after.sessions[0].phase, 'active');
      assert.equal(after.staticFeatures.leases.at(-1).state, 'active');
    }
  });
}
