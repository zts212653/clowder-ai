import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import type { DesktopWindowFailure, DesktopWindowLaunch } from '../src/domains/plugin/desktop-window-runtime/types.js';
import { OfficialPluginPackageInstaller } from '../src/domains/plugin/official-package-installer.js';
import { createDormantPluginRuntimeComposition } from '../src/domains/plugin/runtime-composition.js';
import { MemoryMeetingIntakeStore } from '../src/domains/signal-intake/MeetingIntakeStore.js';
import { MemorySignalRouteStore } from '../src/domains/signal-intake/SignalRouteStore.js';
import { desktopWindowFixture } from './f317-window.fixture.js';

test('a stalled steady-state poll reports its deadline, pending request and first terminal initiator', async (t) => {
  const f = await desktopWindowFixture();
  let polls = 0;
  let launch: DesktopWindowLaunch | undefined;
  let reportPollStarted!: () => void;
  const pollStarted = new Promise<void>((resolve) => {
    reportPollStarted = resolve;
  });
  const reported: DesktopWindowFailure[] = [];
  let report!: (failure: DesktopWindowFailure) => void;
  const lost = new Promise<DesktopWindowFailure>((resolve) => {
    report = resolve;
  });
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: f.root,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    onDesktopFailure: (_id, failure) => {
      reported.push(failure);
      report(failure);
    },
    desktopExecutor: {
      open: async (spec) => {
        launch = spec;
        spec.signal.addEventListener('abort', () => spec.onClosed(), { once: true });
        return {
          poll: () => {
            if (++polls === 1) return Promise.resolve('visible' as const);
            if (polls === 2) {
              reportPollStarted();
              return new Promise<never>(() => {});
            }
            return Promise.resolve('visible' as const);
          },
          show: async () => {},
          close: async () => {},
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
  await Promise.race([
    pollStarted,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('periodic poll did not start')), 7_000)),
  ]);
  const windows = runtime.desktopWindows;
  assert.ok(windows);
  const shown = windows.show().then(
    () => 'shown',
    () => 'failed',
  );
  const failure = await Promise.race([
    lost,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('desktop poll did not settle')), 13_000)),
  ]);
  assert.equal(failure.reason, 'heartbeat-expired');
  assert.equal(failure.initiator, 'host-observer');
  const observation = failure.observation;
  assert.ok(observation);
  assert.equal(observation.phase, 'poll');
  assert.equal(observation.pending, true);
  assert.equal(observation.deadlineAtMs - observation.startedAtMs, 5_000);
  assert.ok(observation.elapsedMs >= 4_500);
  assert.ok(observation.lastPollAnswerAgeMs !== null && observation.lastPollAnswerAgeMs >= 5_000);
  assert.equal(await shown, 'failed', 'show must not reuse a fresh reply while the earlier poll is hung');
  assert.equal(polls, 2, 'a second poll cannot leapfrog the pending control request');
  assert.equal(reported.length, 1, 'abort reentry cannot replace or duplicate the timeout');
  assert.ok(launch);
  launch.onClosed({ reason: 'process-exit', exitCode: 0, signal: null });
  assert.equal(reported.length, 1, 'a late executor close cannot revive the failed show attempt');
});
