const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { resolve } = require('node:path');
const test = require('node:test');
const { createManagedWindow, validateLaunch } = require('./window.cjs');

const input = {
  url: `http://companion-${'a'.repeat(32)}.localhost:4187/packages/fixture/assets/body/index.html`,
  presentation: { width: 320, height: 350, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true },
};

test('Host media revocation cuts capture without closing the cat window or admitting a new offer', async () => {
  const f = electronFixture();
  const commands = [];
  const managed = await createManagedWindow(f.electron, input, {
    validate: () => true,
    request: async (command) => {
      commands.push(command);
      return command.kind === 'prepare' ? { kind: 'state', phase: 'ready' } : { kind: 'ok' };
    },
  });
  try {
    const request = f.handlers.get('companion:request');
    const event = { sender: f.window.webContents, senderFrame: f.window.webContents.mainFrame };
    assert.equal((await request(event, { kind: 'prepare' }, true)).phase, 'ready');
    assert.equal((await request(event, { kind: 'screen.pick' }, true)).kind, 'selection');
    let settled = false;
    const revoked = managed.revokeMedia().then(() => {
      settled = true;
    });
    await Promise.resolve();
    assert.equal(settled, false, 'reload admission alone does not prove capture document destruction');
    f.window.webContents.emit('dom-ready');
    await revoked;
    assert.equal(managed.poll(), 'visible');
    assert.equal(f.window.isDestroyed(), false);
    assert.equal((await request(event, { kind: 'screen.pick' }, true)).code, 'permission_required');
    assert.ok(f.sent.some((row) => row.value.kind === 'media-stopped' && row.value.reason === 'revoked'));
    assert.ok(commands.some((command) => command.kind === 'stop'));
  } finally {
    managed.close();
  }
});

test('a new voice-only prepare can revoke after a previous capture reload timed out', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = electronFixture();
  let reloads = 0;
  const managed = await createManagedWindow(f.electron, input, {
    validate: () => true,
    request: async (command) => (command.kind === 'prepare' ? { kind: 'state', phase: 'ready' } : { kind: 'ok' }),
  });
  f.window.webContents.reload = () => reloads++;
  const request = f.handlers.get('companion:request');
  const event = { sender: f.window.webContents, senderFrame: f.window.webContents.mainFrame };
  try {
    await request(event, { kind: 'prepare' }, true);
    await request(event, { kind: 'screen.pick' }, true);
    await request(event, { kind: 'stop' }, true);
    assert.equal(reloads, 1);
    t.mock.timers.tick(2000);
    await Promise.resolve();
    f.window.webContents.emit('dom-ready');
    await request(event, { kind: 'prepare' }, true); // No new screen grant.
    const revoked = managed.revokeMedia();
    void revoked.catch(() => {});
    assert.equal(reloads, 2, 'this revocation must not reuse the previous timeout');
    f.window.webContents.emit('dom-ready');
    await revoked;
    assert.equal(managed.poll(), 'visible');
    assert.equal((await request(event, { kind: 'screen.pick' }, true)).code, 'permission_required');
  } finally {
    managed.close();
  }
});
function electronFixture() {
  const partition = new EventEmitter();
  const handlers = new Map();
  const sent = [];
  let appHidden = false;
  partition.webRequest = {
    onBeforeRequest: (_filter, listener) => {
      partition.beforeRequest = listener;
    },
  };
  partition.setPermissionCheckHandler = (fn) => {
    partition.check = fn;
  };
  partition.setPermissionRequestHandler = (fn) => {
    partition.request = fn;
  };
  partition.setDisplayMediaRequestHandler = (fn) => {
    partition.display = fn;
  };
  let window;
  class Window extends EventEmitter {
    constructor(options) {
      super();
      window = this;
      this.options = options;
      this.visible = false;
      this.allWorkspaces = false;
      this.destroyed = false;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: input.url };
      this.webContents.getURL = () => this.url;
      this.webContents.send = (channel, value) => sent.push({ channel, value });
      this.webContents.reload = () => {};
      this.webContents.setWindowOpenHandler = (fn) => {
        this.popup = fn;
      };
    }
    async loadURL(url) {
      this.url = url;
    }
    showInactive() {
      this.visible = true;
    }
    isVisible() {
      return this.visible;
    }
    setVisibleOnAllWorkspaces(enabled, options) {
      this.allWorkspaces = enabled;
      this.workspaceOptions = options;
    }
    isVisibleOnAllWorkspaces() {
      return this.allWorkspaces;
    }
    hide() {
      this.visible = false;
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
  }
  return {
    partition,
    handlers,
    sent,
    setAppHidden(value) {
      appHidden = value;
    },
    get window() {
      return window;
    },
    electron: {
      app: { isHidden: () => appHidden },
      BrowserWindow: Window,
      ipcMain: Object.assign(new EventEmitter(), {
        handle: (name, handler) => handlers.set(name, handler),
        removeHandler: (name) => handlers.delete(name),
      }),
      powerMonitor: new EventEmitter(),
      shell: { openExternal: async () => {} },
      session: {
        fromPartition: (id) => {
          assert.ok(!id.startsWith('persist:'));
          return partition;
        },
      },
      screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1280, height: 720 } }) },
    },
  };
}

function f221Preview() {
  const proposalId = '11111111-1111-4111-8111-111111111111';
  return {
    kind: 'f221-preview',
    snapshot: {
      proposalId,
      ownerUserId: 'owner',
      digest: 'a'.repeat(64),
      nonce: 'b'.repeat(48),
      expiresAt: Date.now() + 120_000,
      fields: {
        id: proposalId,
        userId: 'owner',
        scene: '一起看设计稿',
        quote: '保留一点呼吸感',
        takeaway: '重要的是留白',
        dimension: 'visual-quality',
        tags: '["留白"]',
        privacy: 'sensitive',
        publication: JSON.stringify({ state: 'anchored' }),
      },
    },
  };
}

test('package content stays sandboxed; opening grants no media, navigation, downloads or Node', async () => {
  const f = electronFixture();
  const failures = [];
  const window = await createManagedWindow(f.electron, input, { onFailure: (reason) => failures.push(reason) });
  assert.equal(f.window.url, input.url);
  assert.equal(f.window.allWorkspaces, true);
  assert.deepEqual(f.window.workspaceOptions, { visibleOnFullScreen: true });
  assert.deepEqual(f.window.options.webPreferences, {
    preload: resolve(__dirname, 'preload.cjs'),
    session: f.partition,
    sandbox: true,
    contextIsolation: true,
    nodeIntegration: false,
    webSecurity: true,
    webviewTag: false,
    allowRunningInsecureContent: false,
    spellcheck: false,
  });
  assert.equal(f.partition.check(), false);
  f.partition.request(null, 'media', (allowed) => assert.equal(allowed, false));
  f.partition.display(null, (selection) => assert.deepEqual(selection, {}));
  assert.deepEqual(f.window.popup(), { action: 'deny' });
  let denied = 0;
  f.window.webContents.emit('will-navigate', { preventDefault: () => denied++ }, 'https://example.com');
  f.window.webContents.emit('will-redirect', { preventDefault: () => denied++ }, input.url);
  f.window.webContents.emit('will-attach-webview', { preventDefault: () => denied++ });
  f.partition.emit('will-download', { preventDefault: () => denied++ });
  assert.equal(denied, 4);
  assert.equal(window.poll(), 'visible');
  f.window.visible = false;
  assert.equal(window.poll(), 'hidden');
  window.show();
  assert.equal(window.poll(), 'visible');
  f.window.webContents.emit('render-process-gone');
  assert.deepEqual(failures, ['renderer-gone'], 'closed after renderer loss cannot replace the first cause');
  assert.throws(() => window.poll(), /closed/);
  window.close();
});

test('only an activated renderer request opens the Host F221 dialog; the package receives no preview or writer handle', async () => {
  const f = electronFixture();
  const preview = f221Preview();
  const requests = [];
  let shown;
  f.electron.dialog = {
    showMessageBox: async (_win, options) => {
      shown = options;
      return { response: 1 };
    },
  };
  const managed = await createManagedWindow(f.electron, input, {
    validate: (command) => command?.kind === 'f221.inspect',
    request: async (command) => {
      requests.push(command);
      if (command.kind === 'f221.inspect') return preview;
      if (command.kind === 'f221.confirm-trial')
        return {
          kind: 'f221-trial-receipt',
          origin: 'host-native-dialog',
          nonce: command.nonce,
          action: command.action,
          proposalId: preview.snapshot.proposalId,
          digest: preview.snapshot.digest,
          confirmedAt: Date.now(),
        };
      return { kind: 'ok' };
    },
  });
  try {
    const event = { sender: f.window.webContents, senderFrame: f.window.webContents.mainFrame };
    const request = f.handlers.get('companion:request');
    const inspect = { kind: 'f221.inspect', proposalId: preview.snapshot.proposalId };
    assert.equal((await request(event, inspect, false)).code, 'permission_required');
    assert.equal(requests.length, 0);
    assert.equal((await request(event, preview, true)).code, 'invalid_request');
    assert.equal(
      (await request(event, { kind: 'f221.confirm-trial', nonce: preview.snapshot.nonce, action: 'approve' }, true))
        .code,
      'invalid_request',
    );
    assert.deepEqual(await request(event, inspect, true), { kind: 'decision-trial', status: 'trial_confirmed' });
    assert.deepEqual(
      requests.map((entry) => entry.kind),
      ['f221.inspect', 'f221.confirm-trial'],
    );
    assert.match(shown.detail, /重要的是留白/);
    assert.match(shown.buttons[1], /不提交/);
  } finally {
    managed.close();
  }
});

test('a stopped Host revokes an open F221 dialog before its confirmation can be consumed', async () => {
  const f = electronFixture();
  const preview = f221Preview();
  let release;
  let confirmations = 0;
  f.electron.dialog = {
    showMessageBox: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  };
  const managed = await createManagedWindow(f.electron, input, {
    validate: (command) => ['f221.inspect', 'stop'].includes(command?.kind),
    request: async (command) => {
      if (command.kind === 'f221.inspect') return preview;
      if (command.kind === 'f221.confirm-trial') {
        confirmations++;
        return {
          kind: 'f221-trial-receipt',
          origin: 'host-native-dialog',
          nonce: command.nonce,
          action: command.action,
          proposalId: preview.snapshot.proposalId,
          digest: preview.snapshot.digest,
        };
      }
      return { kind: 'ok' };
    },
  });
  try {
    const event = { sender: f.window.webContents, senderFrame: f.window.webContents.mainFrame };
    const request = f.handlers.get('companion:request');
    const inspect = { kind: 'f221.inspect', proposalId: preview.snapshot.proposalId };
    const pending = request(event, inspect, true);
    for (let attempt = 0; attempt < 100 && !release; attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.ok(release, 'native dialog must open');
    assert.equal((await request(event, inspect, true)).code, 'busy');
    await request(event, { kind: 'stop' }, true);
    release({ response: 1 });
    assert.deepEqual(await pending, { kind: 'decision-trial', status: 'stale' });
    assert.equal(confirmations, 0);
  } finally {
    managed.close();
  }
});

test('fullscreen Space handoff preserves media while app hide and lock still revoke it', async () => {
  const f = electronFixture();
  const requests = [];
  const managed = await createManagedWindow(f.electron, input, {
    validate: () => true,
    request: async (command) => {
      requests.push(command.kind);
      return command.kind === 'prepare' ? { kind: 'state', phase: 'ready' } : { kind: 'ok' };
    },
  });
  try {
    f.window.allWorkspaces = true; // isolate the OS hide handling from setup
    const event = { sender: f.window.webContents, senderFrame: f.window.webContents.mainFrame };
    await f.handlers.get('companion:request')(event, { kind: 'prepare' }, true);
    f.window.emit('blur');
    f.window.emit('hide'); // macOS Space transition: still visible, app not hidden
    assert.equal(
      f.sent.some((row) => row.value.kind === 'media-stopped'),
      false,
    );
    assert.equal(requests.includes('stop'), false);
    f.setAppHidden(true); // Command-H is an actual app hide
    f.window.emit('blur'); // real Electron may send blur without window hide
    assert.equal(f.sent.at(-1).value.reason, 'hidden');
    await f.handlers.get('companion:request')(event, { kind: 'prepare' }, true);
    f.window.emit('hide');
    assert.equal(f.sent.at(-1).value.reason, 'hidden');
    f.setAppHidden(false);
    await f.handlers.get('companion:request')(event, { kind: 'prepare' }, true);
    f.window.allWorkspaces = false; // a truly invisible Space must not retain media
    f.window.emit('hide');
    assert.equal(f.sent.at(-1).value.reason, 'hidden');
    f.window.allWorkspaces = true;
    await f.handlers.get('companion:request')(event, { kind: 'prepare' }, true);
    f.window.visible = false; // a persistent native window hide
    f.window.emit('hide');
    assert.equal(f.sent.at(-1).value.reason, 'hidden');
    f.window.visible = true;
    await f.handlers.get('companion:request')(event, { kind: 'prepare' }, true);
    f.electron.powerMonitor.emit('lock-screen');
    assert.equal(f.sent.at(-1).value.reason, 'locked');
    await f.handlers.get('companion:request')(event, { kind: 'prepare' }, true);
    f.electron.powerMonitor.emit('suspend');
    assert.equal(f.sent.at(-1).value.reason, 'suspended');
  } finally {
    managed.close();
  }
});

test('a Space hide without a matching show stops media within the bounded handoff period', async () => {
  const f = electronFixture();
  const managed = await createManagedWindow(f.electron, input, {
    validate: () => true,
    request: async (command) => (command.kind === 'prepare' ? { kind: 'state', phase: 'ready' } : { kind: 'ok' }),
  });
  try {
    const event = { sender: f.window.webContents, senderFrame: f.window.webContents.mainFrame };
    await f.handlers.get('companion:request')(event, { kind: 'prepare' }, true);
    f.window.emit('hide'); // Electron may still report isVisible() while the Space no longer shows the cat.
    assert.equal(
      f.sent.some((row) => row.value.kind === 'media-stopped'),
      false,
    );
    await new Promise((resolve) => setTimeout(resolve, 1150));
    assert.equal(f.sent.at(-1).value.reason, 'hidden');
  } finally {
    managed.close();
  }
});

test('a Space hide followed by a timely show preserves media beyond the handoff period', async () => {
  const f = electronFixture();
  const managed = await createManagedWindow(f.electron, input, {
    validate: () => true,
    request: async (command) => (command.kind === 'prepare' ? { kind: 'state', phase: 'ready' } : { kind: 'ok' }),
  });
  try {
    const event = { sender: f.window.webContents, senderFrame: f.window.webContents.mainFrame };
    await f.handlers.get('companion:request')(event, { kind: 'prepare' }, true);
    f.window.emit('hide');
    await new Promise((resolve) => setTimeout(resolve, 50));
    f.window.emit('show');
    await new Promise((resolve) => setTimeout(resolve, 1150));
    assert.equal(
      f.sent.some((row) => row.value.kind === 'media-stopped'),
      false,
    );
  } finally {
    managed.close();
  }
});

test('an admitted hide gesture stops media even when Electron emits no hide event', async () => {
  const f = electronFixture();
  const managed = await createManagedWindow(f.electron, input, {
    validate: () => true,
    request: async (command) => (command.kind === 'prepare' ? { kind: 'state', phase: 'ready' } : { kind: 'ok' }),
  });
  try {
    const event = { sender: f.window.webContents, senderFrame: f.window.webContents.mainFrame };
    const request = f.handlers.get('companion:request');
    await request(event, { kind: 'prepare' }, true);
    assert.equal((await request(event, { kind: 'view.hide' }, false)).code, 'permission_required');
    assert.equal(
      f.sent.some((row) => row.value.kind === 'media-stopped'),
      false,
    );
    assert.equal((await request(event, { kind: 'view.hide' }, true)).kind, 'ok');
    assert.equal(f.window.isVisible(), false);
    assert.equal(
      f.sent.some((row) => row.value.kind === 'media-stopped' && row.value.reason === 'hidden'),
      true,
    );
  } finally {
    managed.close();
  }
});

test('window input cannot choose an executable, preload, remote origin or security override', () => {
  for (const patch of [
    { url: 'https://example.com' },
    { executable: '/bin/sh' },
    { ownerUserId: 'other' },
    { publicCompanionV2: false },
    { presentation: { ...input.presentation, webPreferences: { nodeIntegration: true } } },
    { presentation: { ...input.presentation, width: 100000 } },
  ]) {
    assert.throws(() => validateLaunch({ ...input, ...patch }));
  }
});
test('an armed surface can load only its snapshot origin and cannot send HTTP or WebSocket requests outside it', async () => {
  const f = electronFixture();
  const window = await createManagedWindow(f.electron, input, {
    validate: () => true,
    request: async () => ({ kind: 'state', phase: 'ready' }),
  });
  try {
    const event = { sender: f.window.webContents, senderFrame: f.window.webContents.mainFrame };
    await f.handlers.get('companion:request')(event, { kind: 'prepare' }, true);
    assert.equal(
      (await f.handlers.get('companion:request')(event, { kind: 'audio.connect' }, false)).code,
      'permission_required',
      'main must preserve the isolated preload activation on audio admission',
    );
    f.partition.request(f.window.webContents, 'media', (allowed) => assert.equal(allowed, false), {
      mediaTypes: ['audio'],
    });
    await f.handlers.get('companion:request')(event, { kind: 'screen.pick' }, true);
    assert.equal(
      f.partition.check(f.window.webContents, 'media', new URL(input.url).origin),
      false,
      'an untyped permission query must not advertise microphone access while the picker is pending',
    );
    assert.equal(f.partition.check(f.window.webContents, 'display-capture', new URL(input.url).origin), true);
    f.partition.request(f.window.webContents, 'media', (allowed) => assert.equal(allowed, true), {
      mediaTypes: [],
    });
    assert.equal(typeof f.partition.beforeRequest, 'function');
    const check = (url, method = 'GET') =>
      new Promise((resolve) => f.partition.beforeRequest({ url, method }, resolve));
    for (const url of [
      'https://example.com/audio',
      'wss://example.com/audio',
      'ws://127.0.0.1:4187/audio',
      'http://127.0.0.1:4187/',
      'file:///private/data',
    ]) {
      assert.equal((await check(url)).cancel, true, url);
    }
    assert.equal((await check(input.url)).cancel, false);
    assert.equal((await check(input.url, 'POST')).cancel, true);
  } finally {
    window.close();
  }
});

test('ending before Host readiness cancels the admitted connection without a late media continuation', async () => {
  const f = electronFixture();
  let ready;
  const preparation = new Promise((resolve) => {
    ready = resolve;
  });
  const window = await createManagedWindow(f.electron, input, {
    validate: () => true,
    request: (command) => (command.kind === 'prepare' ? preparation : Promise.resolve({ kind: 'ok' })),
  });
  try {
    const event = { sender: f.window.webContents, senderFrame: f.window.webContents.mainFrame };
    const request = f.handlers.get('companion:request');
    const preparing = request(event, { kind: 'prepare' }, true);
    const connecting = request(event, { kind: 'audio.connect' }, true);
    await request(event, { kind: 'stop' }, false);
    assert.equal((await connecting).code, 'cancelled');
    ready({ kind: 'state', phase: 'ready' });
    assert.equal((await preparing).code, 'cancelled');
    assert.equal((await request(event, { kind: 'audio.connect' }, true)).code, 'permission_required');
  } finally {
    window.close();
  }
});

test('old installed package hides receive-only capability and rejects its command even with a newer Host validator', async () => {
  const f = electronFixture();
  const managed = await createManagedWindow(f.electron, input, {
    voiceResources: { voiceUrl: 'file:///fixture/host-voice.html', voicePreload: '/fixture/host-preload.cjs' },
    validate: () => true,
    request: async () => ({ kind: 'state', phase: 'ready' }),
  });
  try {
    const event = { sender: f.window.webContents, senderFrame: f.window.webContents.mainFrame };
    const request = f.handlers.get('companion:request');
    assert.equal(Object.hasOwn(await request(event, { kind: 'state' }, false), 'audio'), false);
    await request(event, { kind: 'prepare' }, true);
    assert.equal((await request(event, { kind: 'audio.connect', mode: 'receive_only' }, true)).code, 'invalid_request');
    assert.equal(Object.hasOwn(await request(event, { kind: 'state' }, false), 'audio'), false);
  } finally {
    managed.close();
  }
});

test('a compatible public validator cannot advertise receive-only without the fixed Host media document', async () => {
  const f = electronFixture();
  const managed = await createManagedWindow(
    f.electron,
    { ...input, publicCompanionV2: true },
    {
      validate: () => true,
      request: async () => ({ kind: 'state', phase: 'ready' }),
    },
  );
  try {
    const event = { sender: f.window.webContents, senderFrame: f.window.webContents.mainFrame };
    assert.equal(
      Object.hasOwn(await f.handlers.get('companion:request')(event, { kind: 'state' }, false), 'audio'),
      false,
    );
  } finally {
    managed.close();
  }
});

test('new public validator exposes only installed native audio modes and tracks the acknowledged mode', async () => {
  const f = electronFixture();
  const BaseWindow = f.electron.BrowserWindow;
  let privateCommand;
  f.electron.BrowserWindow = class extends BaseWindow {
    constructor(options) {
      super(options);
      if (options.width === 1) {
        this.webContents.send = (_channel, id, command) => {
          privateCommand = command;
          queueMicrotask(() =>
            f.electron.ipcMain.emit(
              'companion:voice-reply',
              { sender: this.webContents, senderFrame: this.webContents.mainFrame },
              id,
              { kind: 'ok' },
            ),
          );
        };
      }
    }
    async loadURL(url) {
      await super.loadURL(url);
      this.webContents.mainFrame.url = url;
    }
  };
  const managed = await createManagedWindow(
    f.electron,
    { ...input, publicCompanionV2: true },
    {
      voiceResources: { voiceUrl: 'file:///fixture/host-voice.html', voicePreload: '/fixture/host-preload.cjs' },
      validate: (command) =>
        ['state', 'prepare', 'audio.close'].includes(command?.kind) ||
        (command?.kind === 'audio.connect' && command.mode === 'receive_only'),
      request: async () => ({ kind: 'state', phase: 'ready' }),
    },
  );
  try {
    const surface = f.window;
    const event = { sender: surface.webContents, senderFrame: surface.webContents.mainFrame };
    const request = f.handlers.get('companion:request');
    assert.deepEqual((await request(event, { kind: 'state' }, false)).audio, {
      supportedModes: ['duplex', 'receive_only'],
      activeMode: null,
    });
    assert.deepEqual((await request(event, { kind: 'prepare' }, true)).audio, {
      supportedModes: ['duplex', 'receive_only'],
      activeMode: null,
    });
    assert.equal((await request(event, { kind: 'audio.connect', mode: 'receive_only' }, true)).kind, 'ok');
    assert.equal(privateCommand.mode, 'receive_only');
    assert.equal((await request(event, { kind: 'state' }, false)).audio.activeMode, 'receive_only');
    await request(event, { kind: 'audio.close' }, false);
    assert.equal((await request(event, { kind: 'state' }, false)).audio.activeMode, null);
  } finally {
    managed.close();
  }
});
