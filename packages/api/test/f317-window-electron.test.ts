import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { ElectronDesktopWindowExecutor } from '../src/domains/plugin/desktop-window-runtime/electron-executor.js';
import { OfficialPluginPackageInstaller } from '../src/domains/plugin/official-package-installer.js';
import { createDormantPluginRuntimeComposition } from '../src/domains/plugin/runtime-composition.js';
import { MemoryMeetingIntakeStore } from '../src/domains/signal-intake/MeetingIntakeStore.js';
import { MemorySignalRouteStore } from '../src/domains/signal-intake/SignalRouteStore.js';
import { desktopWindowFixture } from './f317-window.fixture.js';

const executable = process.env.CAT_CAFE_TEST_DESKTOP_EXECUTABLE;
test(
  'real Electron opens only the installed fixture surface and exits on canonical disable',
  { skip: !executable, timeout: 30_000 },
  async (t) => {
    const f = await desktopWindowFixture(
      '<!doctype html><html><body>Bridge fixture<script type="module" src="./worker.js"></script></body></html>',
      `
      const state = await window.clowderCompanion.request({ kind: 'state' });
      const denied = await window.clowderCompanion.request({ kind: 'prepare' });
      const media = await window.clowderCompanion.request({ kind: 'audio.connect' });
      const offer = await window.clowderCompanion.request({ kind: 'offer', sdp: 'v=0\\r\\nm=audio 9 x 1\\r\\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\\r\\n' });
      const text = await window.clowderCompanion.request({ kind: 'text', text: 'not a user click', clientMessageId: crypto.randomUUID() });
      if (state.kind !== 'state' || denied.code !== 'permission_required' || media.code !== 'permission_required' || offer.code !== 'invalid_request' || text.code !== 'permission_required') throw new Error('renderer admission mismatch');
      await window.clowderCompanion.request({ kind: 'state' });
    `,
    );
    const executor = new ElectronDesktopWindowExecutor({
      executable: executable!,
      onStage: (stage) => t.diagnostic(`desktop stage: ${stage}`),
      onFailure: (failure) => t.diagnostic(`desktop startup failure: ${JSON.stringify(failure)}`),
      entrypoint: resolve('../../desktop/plugin-window/main.cjs'),
    });
    let witnessed!: (value: unknown) => void;
    const witness = new Promise<unknown>((resolve) => {
      witnessed = resolve;
    });
    let preparations = 0;
    let states = 0;
    const runtime = createDormantPluginRuntimeComposition({
      projectRoot: f.root,
      routes: new MemorySignalRouteStore(),
      intakes: new MemoryMeetingIntakeStore(),
      messageStore: new MessageStore(),
      desktopExecutor: executor,
      createCompanionBridge: ({ assertCurrent }) => ({
        request: async (input) => {
          await assertCurrent();
          const command = input as { kind: string; text?: string };
          if (command.kind === 'prepare') preparations++;
          if (command.kind === 'state' && ++states === 2) witnessed('renderer-admission-verified');
          if (command.kind === 'text') {
            witnessed(JSON.parse(command.text!));
            return { kind: 'delivery', delivery: 'accepted' };
          }
          return {
            kind: 'state',
            phase: 'idle',
            displayName: 'Installed bridge sentinel',
            skin: 'cat',
            duty: { catId: 'deep', displayName: 'Deep' },
            carrier: { catId: 'voice', displayName: 'Voice' },
            documentsAllowed: true,
            toolsReady: false,
            nativeActivity: 'none',
          };
        },
        close: async () => {},
      }),
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
    const enabled = await runtime.lifecycle.enable(installed.pluginInstanceId, prepared.lifecycleRevision);
    assert.equal((await runtime.desktopWindows!.presence())?.state, 'visible');
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observed = await Promise.race([
      witness,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('renderer did not complete its real preload/Host exchange')), 5_000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(preparations, 0, 'page load cannot impersonate a user click to prepare voice');
    assert.equal(observed, 'renderer-admission-verified');
    await runtime.lifecycle.disable(installed.pluginInstanceId, enabled.lifecycleRevision);
    assert.equal(await runtime.desktopWindows!.presence(), null);
    assert.equal((await runtime.brokerStore.snapshot()).staticFeatures?.leases[0].state, 'revoked');
  },
);
