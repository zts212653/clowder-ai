import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { validateHostCompanionReply } from '../src/domains/plugin/desktop-window-runtime/companion-private-wire.js';
import { ElectronDesktopWindowExecutor } from '../src/domains/plugin/desktop-window-runtime/electron-executor.js';
import { OfficialPluginPackageInstaller } from '../src/domains/plugin/official-package-installer.js';
import { createDormantPluginRuntimeComposition } from '../src/domains/plugin/runtime-composition.js';
import { MemoryMeetingIntakeStore } from '../src/domains/signal-intake/MeetingIntakeStore.js';
import { MemorySignalRouteStore } from '../src/domains/signal-intake/SignalRouteStore.js';
import { nativeVoicePeerFixture } from './f317-voice-peer.fixture.js';
import { desktopWindowFixture } from './f317-window.fixture.js';

const executable = process.env.CAT_CAFE_TEST_DESKTOP_EXECUTABLE;
const readyState = {
  kind: 'state',
  phase: 'ready',
  displayName: 'Egress fixture',
  skin: 'cat',
  duty: { catId: 'deep', displayName: 'Deep' },
  carrier: { catId: 'voice', displayName: 'Voice' },
  documentsAllowed: true,
  toolsReady: false,
  nativeActivity: 'none',
} as const;

test('Electron egress Host state obeys the published beta.20 wire', () => {
  assert.equal(validateHostCompanionReply(readyState), false, 'work and transport must be present');
  const stateWithWork = {
    ...readyState,
    liveTransport: { kind: 'gpt_live_v3', verifiedModel: null },
    nativeWork: { scopeId: null, revision: 0, active: [], recent: [] },
  };
  assert.equal(validateHostCompanionReply(stateWithWork), true);
  assert.equal(
    validateHostCompanionReply({
      ...stateWithWork,
      nativeWork: { scopeId: null, revision: -1, active: [], recent: [] },
    }),
    false,
  );
  assert.equal(
    validateHostCompanionReply({
      ...stateWithWork,
      liveTransport: { kind: 'gpt_live_v3', verifiedModel: 'gpt-5.6-sol' },
    }),
    false,
    'a configured carrier model is not proof of the Realtime model served upstream',
  );
});
test(
  'real armed Electron package cannot capture audio or send cross-origin fetch or WebSocket traffic',
  { skip: !executable, timeout: 30_000 },
  async (t) => {
    let requests = 0;
    let upgrades = 0;
    const sentinel = createServer((_request, response) => {
      requests++;
      response.setHeader('Access-Control-Allow-Origin', '*');
      response.end('reachable');
    });
    sentinel.on('upgrade', (_request, socket) => {
      upgrades++;
      socket.destroy();
    });
    await new Promise<void>((resolve) => sentinel.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => sentinel.close(() => resolve())));
    const address = sentinel.address();
    assert.ok(address && typeof address !== 'string');
    const target = `http://127.0.0.1:${address.port}`;
    assert.equal(await (await fetch(target)).text(), 'reachable');
    requests = 0;
    const native = await nativeVoicePeerFixture();
    t.after(() => native.close());

    const f = await desktopWindowFixture(
      '<!doctype html><html><body><button>Begin fixture</button><script type="module" src="./worker.js"></script></body></html>',
      `
      document.querySelector('button').onclick = async () => {
        let transcript;
        const transcriptReceived = new Promise(resolve => {
          window.clowderCompanion.subscribe(event => {
            if (event.kind === 'audio' && event.type === 'transcript') {
              transcript = event; resolve();
            }
          });
        });
        const ready = await window.clowderCompanion.request({ kind: 'prepare' });
        const microphone = await navigator.mediaDevices.getUserMedia({ audio: true })
          .then(stream => { stream.getTracks().forEach(track => track.stop()); return 'captured'; }, () => 'blocked');
        await window.clowderCompanion.request({ kind: 'audio.speaker', muted: true });
        while (navigator.userActivation.isActive) await new Promise(resolve => setTimeout(resolve, 50));
        const inactive = await window.clowderCompanion.request({ kind: 'audio.connect' });
        const voice = await new Promise(resolve => {
          document.querySelector('button').onclick = () => resolve(window.clowderCompanion.request({ kind: 'audio.connect' }));
          document.body.dataset.stage = 'fresh-connect';
        });
        await Promise.race([transcriptReceived, new Promise(resolve => setTimeout(resolve, 3000))]);
        const http = await fetch(${JSON.stringify(target)}, { method: 'POST', body: 'synthetic' })
          .then(() => 'sent', () => 'blocked');
        const ws = await new Promise(resolve => {
          let socket;
          const timer = setTimeout(() => { socket?.close(); resolve('timeout'); }, 1500);
          try {
            socket = new WebSocket(${JSON.stringify(target.replace('http:', 'ws:'))});
            socket.onopen = () => { clearTimeout(timer); socket.close(); resolve('sent'); };
            socket.onerror = () => { clearTimeout(timer); resolve('blocked'); };
          } catch { clearTimeout(timer); resolve('blocked'); }
        });
        await window.clowderCompanion.request({ kind: 'text',
          text: JSON.stringify({ ready: ready.phase, microphone, inactive: inactive.code, voice: voice.kind, transcript, http, ws }), clientMessageId: crypto.randomUUID() });
      };
      `,
    );
    // Test driver supplies Chromium user activation; the package cannot do this.
    // Chromium supplies a synthetic audio device; no actual microphone or screen.
    const driver = join(f.root, 'click-driver.cjs');
    await writeFile(
      driver,
      `const {app} = require('electron');
      app.commandLine.appendSwitch('use-fake-device-for-media-stream');
      app.on('browser-window-created', (_event, window) => {
        window.webContents.once('did-finish-load', async () => {
          if (!window.webContents.getURL().startsWith('http:')) return;
          await window.webContents.executeJavaScript("document.querySelector('button').click()", true);
          await window.webContents.executeJavaScript("new Promise(resolve => { const poll = setInterval(() => { if (document.body.dataset.stage === 'fresh-connect') { clearInterval(poll); resolve(); } }, 50); })");
          await window.webContents.executeJavaScript("document.querySelector('button').click()", true);
        });
      });
      require(${JSON.stringify(resolve('../../desktop/plugin-window/main.cjs'))});
      ${native.driver}`,
    );
    let witnessed!: (value: unknown) => void;
    const witness = new Promise<unknown>((resolve) => {
      witnessed = resolve;
    });
    let preparations = 0;
    let offers = 0;
    const runtime = createDormantPluginRuntimeComposition({
      projectRoot: f.root,
      routes: new MemorySignalRouteStore(),
      intakes: new MemoryMeetingIntakeStore(),
      messageStore: new MessageStore(),
      desktopExecutor: new ElectronDesktopWindowExecutor({ executable: executable!, entrypoint: driver }),
      createCompanionBridge: ({ assertCurrent }) => ({
        request: async (input) => {
          await assertCurrent();
          const command = input as { kind: string; text?: string; sdp?: string };
          if (command.kind === 'prepare') preparations++;
          if (command.kind === 'offer') {
            offers++;
            return { kind: 'answer', sdp: await native.answer(command.sdp!), callId: randomUUID() };
          }
          if (command.kind === 'text') {
            witnessed(JSON.parse(command.text!));
            return { kind: 'delivery', delivery: 'accepted' };
          }
          return {
            kind: 'state',
            phase: 'ready',
            displayName: 'Egress fixture',
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observed = await Promise.race([
      witness,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('armed renderer egress probe did not finish')), 12_000);
      }),
    ]).finally(() => clearTimeout(timer));
    assert.equal(preparations, 1, 'a real user-activated prepare reached the Host');
    assert.equal(offers, 1, 'only the Host voice document can capture the synthetic device and offer audio');
    assert.deepEqual(observed, {
      ready: 'ready',
      microphone: 'blocked',
      inactive: 'permission_required',
      voice: 'ok',
      transcript: {
        kind: 'audio',
        type: 'transcript',
        role: 'assistant',
        text: 'synthetic remote voice',
        itemId: 'test-item',
        turnId: 'test-turn',
      },
      http: 'blocked',
      ws: 'blocked',
    });
    assert.equal(requests, 0);
    assert.equal(upgrades, 0);
    await runtime.lifecycle.disable(installed.pluginInstanceId, enabled.lifecycleRevision);
    assert.equal(await runtime.desktopWindows!.presence(), null);
  },
);
