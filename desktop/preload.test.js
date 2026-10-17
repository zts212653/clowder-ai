// F273 — preload bridge contract tests (no Electron runtime required)

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { describe, test } = require('node:test');

function loadBridge({ readyResult = null, argv = [], rendererWindow } = {}) {
  const exposed = {};
  const sent = [];
  const invoked = [];
  const ipcRenderer = new EventEmitter();
  ipcRenderer.send = (channel, payload) => sent.push([channel, payload]);
  ipcRenderer.invoke = async (channel, payload) => {
    invoked.push([channel, payload]);
    if (channel === 'desktop-update:ready') {
      if (readyResult instanceof Error) throw readyResult;
      return readyResult;
    }
    if (channel === 'desktop-update:settings:get') return { autoCheck: true };
    if (channel === 'desktop-update:settings:set-auto-check') return { autoCheck: payload };
    throw new Error(`Unexpected invoke channel: ${channel}`);
  };
  const contextBridge = {
    exposeInMainWorld(name, api) {
      exposed[name] = api;
    },
  };
  const source = readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  vm.runInNewContext(source, {
    process: { argv },
    window: rendererWindow,
    require(id) {
      assert.equal(id, 'electron');
      return { contextBridge, ipcRenderer };
    },
  });
  return { bridge: exposed.desktopBridge, ipcRenderer, sent, invoked, source };
}

describe('desktop default shell preference', () => {
  const key = 'cat-cafe:shell-presentation';
  const argv = ['app.exe', '--cat-cafe-app-origin=http://localhost:5342'];
  function fixture(preference, origin = 'http://localhost:5342') {
    const values = new Map([['unsent-draft', 'keep this draft']]);
    if (preference !== undefined) values.set(key, preference);
    const rendererWindow = {
      location: { origin },
      localStorage: {
        getItem: (name) => values.get(name) ?? null,
        setItem: (name, value) => values.set(name, value),
      },
    };
    rendererWindow.top = rendererWindow;
    return { values, rendererWindow };
  }
  test('initializes a fresh installed renderer to v2 before page scripts run', () => {
    const f = fixture();
    loadBridge({ argv, rendererWindow: f.rendererWindow });
    assert.equal(f.values.get(key), 'v2');
    assert.equal(f.values.get('unsent-draft'), 'keep this draft');
  });
  test('retains an explicit classic or v2 selection across launches', () => {
    for (const preference of ['classic', 'v2']) {
      const f = fixture(preference);
      loadBridge({ argv, rendererWindow: f.rendererWindow });
      assert.equal(f.values.get(key), preference);
    }
  });
  test('does not switch back after the user chooses classic', () => {
    const f = fixture();
    loadBridge({ argv, rendererWindow: f.rendererWindow });
    f.rendererWindow.localStorage.setItem(key, 'classic');
    loadBridge({ argv, rendererWindow: f.rendererWindow });
    assert.equal(f.values.get(key), 'classic');
  });
  test('never seeds the splash page, another origin, or a subframe', () => {
    for (const origin of ['null', 'http://localhost:3342', 'https://example.com']) {
      const f = fixture(undefined, origin);
      loadBridge({ argv, rendererWindow: f.rendererWindow });
      assert.equal(f.values.has(key), false);
    }
    const f = fixture();
    f.rendererWindow.top = {};
    loadBridge({ argv, rendererWindow: f.rendererWindow });
    assert.equal(f.values.has(key), false);
  });
  test('does not guess an application origin and survives denied storage', () => {
    const f = fixture();
    loadBridge({ rendererWindow: f.rendererWindow });
    assert.equal(f.values.has(key), false);
    Object.defineProperty(f.rendererWindow, 'localStorage', {
      get() {
        throw new Error('Storage denied');
      },
    });
    assert.ok(loadBridge({ argv, rendererWindow: f.rendererWindow }).bridge);
  });
  test('repairs an invalid preference without touching unrelated local data', () => {
    const f = fixture('obsolete-mode');
    loadBridge({ argv, rendererWindow: f.rendererWindow });
    assert.equal(f.values.get(key), 'v2');
    assert.equal(f.values.get('unsent-draft'), 'keep this draft');
  });
});

describe('desktop preload update bridge', () => {
  test('exposes only the startup API origin from the actual Electron process argv', () => {
    const { bridge } = loadBridge({ argv: ['app.exe', '--cat-cafe-api-origin=http://localhost:3158'] });
    assert.equal(bridge.apiOrigin, 'http://localhost:3158');
    assert.equal(loadBridge().bridge.apiOrigin, undefined);
  });
  test('returns the pending prompt from the trusted readiness invoke', async () => {
    const pending = { kind: 'up-to-date', version: '0.12.0' };
    const { bridge, invoked, source } = loadBridge({ readyResult: pending });

    assert.deepEqual(await bridge.updatePromptReady(), pending);
    assert.deepEqual(invoked, [['desktop-update:ready', undefined]]);
    assert.doesNotMatch(source, /document-capability|documentCapability|capability/i);
  });

  test('subscribes to prompts with cleanup', () => {
    const { bridge, ipcRenderer } = loadBridge();
    const prompts = [];
    const unsubscribe = bridge.onUpdatePrompt((prompt) => prompts.push(prompt));

    ipcRenderer.emit('desktop-update:prompt', {}, { kind: 'up-to-date', version: '0.12.0' });
    assert.equal(prompts.length, 1);

    unsubscribe();
    ipcRenderer.emit('desktop-update:prompt', {}, { kind: 'up-to-date', version: '0.13.0' });
    assert.equal(prompts.length, 1);
  });

  test('subscribes to main-owned update progress without exposing transfer controls', () => {
    const { bridge, ipcRenderer } = loadBridge();
    const snapshots = [];
    const unsubscribe = bridge.onUpdateProgress((snapshot) => snapshots.push(snapshot));
    const progress = {
      phase: 'downloading',
      version: '0.12.0',
      assetName: 'ClowderAI-Setup-0.12.0.exe',
      progress: 0.42,
    };

    ipcRenderer.emit('desktop-update:progress', {}, progress);
    ipcRenderer.emit('desktop-update:progress', {}, null);

    assert.deepEqual(JSON.parse(JSON.stringify(snapshots)), [progress, null]);
    assert.equal('cancelUpdateDownload' in bridge, false);
    assert.equal('pauseUpdateDownload' in bridge, false);

    unsubscribe();
    ipcRenderer.emit('desktop-update:progress', {}, progress);
    assert.equal(snapshots.length, 2);
  });

  test('admits only enumerated actions and never accepts a renderer URL', () => {
    const { bridge, sent } = loadBridge();

    bridge.sendUpdatePromptAction('download', '0.12.0');
    bridge.sendUpdatePromptAction('open-release', '0.12.0');
    bridge.sendUpdatePromptAction('dismiss', '0.12.0');
    bridge.sendUpdatePromptAction('install', '0.12.0');

    assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
      ['desktop-update:action', { action: 'download', version: '0.12.0' }],
      ['desktop-update:action', { action: 'open-release', version: '0.12.0' }],
      ['desktop-update:action', { action: 'dismiss', version: '0.12.0' }],
      ['desktop-update:action', { action: 'install', version: '0.12.0' }],
    ]);
    assert.throws(() => bridge.sendUpdatePromptAction('open-url', 'https://evil.example'), /invalid/i);
    assert.equal('openExternal' in bridge, false);
    assert.equal('openUrl' in bridge, false);
  });

  test('exposes only typed automatic-update preference calls', async () => {
    const { bridge, invoked } = loadBridge();

    assert.deepEqual(await bridge.getUpdateSettings(), { autoCheck: true });
    assert.deepEqual(await bridge.setUpdateAutoCheck(false), { autoCheck: false });
    assert.deepEqual(invoked, [
      ['desktop-update:settings:get', undefined],
      ['desktop-update:settings:set-auto-check', false],
    ]);
    assert.throws(() => bridge.setUpdateAutoCheck('false'), /invalid/i);
  });
});
