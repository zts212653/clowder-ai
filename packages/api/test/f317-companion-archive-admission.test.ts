import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { OfficialPluginPackageInstaller } from '../src/domains/plugin/official-package-installer.js';
import { createDormantPluginRuntimeComposition } from '../src/domains/plugin/runtime-composition.js';
import { MemoryMeetingIntakeStore } from '../src/domains/signal-intake/MeetingIntakeStore.js';
import { MemorySignalRouteStore } from '../src/domains/signal-intake/SignalRouteStore.js';
import { desktopWindowManifest, windowHtml } from './f317-window.fixture.js';
import { staticEditorFixture } from './plugin-static-editor.fixture.js';

test('an unpaired official archive with bridge 1.3 is rejected before Broker, Bridge or window admission', async (t) => {
  const f = await staticEditorFixture(
    {
      ...desktopWindowManifest(windowHtml, '1.3.0'),
      pluginId: 'official.companion',
      version: '0.1.0-alpha.14',
    },
    windowHtml,
  );
  let bridges = 0;
  let windows = 0;
  const runtime = createDormantPluginRuntimeComposition({
    projectRoot: f.root,
    routes: new MemorySignalRouteStore(),
    intakes: new MemoryMeetingIntakeStore(),
    messageStore: new MessageStore(),
    createCompanionBridge: () => {
      bridges++;
      return { request: async () => ({ kind: 'error', code: 'unavailable' }), close: async () => {} };
    },
    desktopExecutor: {
      open: async () => {
        windows++;
        return { poll: async () => 'visible', show: async () => {}, close: async () => {} };
      },
    },
  });
  t.after(async () => {
    await runtime.shutdown();
    await f.cleanup();
  });
  const entry = { ...f.entry, effectiveGrants: ['windows.create' as const] };
  const installer = new OfficialPluginPackageInstaller({
    inventory: runtime.inventory,
    packagesRoot: runtime.paths.packagesRoot,
    catalog: [entry],
    fetchArchive: async () => f.bytes,
  });
  const installed = await installer.install(entry.catalogId, entry);
  const prepared = await runtime.lifecycle.prepare(installed.pluginInstanceId, 1);
  await assert.rejects(runtime.lifecycle.enable(installed.pluginInstanceId, prepared.lifecycleRevision), {
    code: 'START_FAILED',
  });
  assert.equal(bridges, 0);
  assert.equal(windows, 0);
  const broker = await runtime.brokerStore.snapshot();
  assert.deepEqual(broker.sessions, []);
  assert.deepEqual(broker.runtimeLeases, []);
  assert.equal(await runtime.desktopWindows?.presence(), null);
});
