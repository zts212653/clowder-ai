// F317 north-star regression harness, Tier A (native window): expanding, collapsing, opening a panel
// (up to the 420x500 ceiling) or dragging the cat are views. They must not stop, reconfigure or
// re-route an open audio session. view.hide is excluded on purpose: a deliberate hide revokes media.
// Fixture derived from window.test.cjs + window-motion-integration.test.cjs; neither is edited.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');
const { createManagedWindow } = require('./window.cjs');

const input = {
  url: `http://companion-${'a'.repeat(32)}.localhost:4187/packages/fixture/body/index.html`,
  presentation: { width: 320, height: 350, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true },
  publicCompanionV2: true,
};

function fixture() {
  const handlers = new Map();
  const partition = new EventEmitter();
  partition.webRequest = { onBeforeRequest() {} };
  partition.setPermissionCheckHandler = () => {};
  partition.setPermissionRequestHandler = () => {};
  partition.setDisplayMediaRequestHandler = () => {};
  const voiceCommands = [];
  const windows = [];
  const area = { x: 0, y: 0, width: 1280, height: 720 };
  let surface;
  let reloads = 0;
  let cursor = { x: 1000, y: 500 };
  class Window extends EventEmitter {
    constructor(options) {
      super();
      windows.push(this);
      this.isVoice = options.width === 1;
      if (!this.isVoice) surface = this;
      this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width, height: options.height };
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: input.url };
      this.webContents.getURL = () => this.url;
      this.webContents.reload = () => {
        if (!this.isVoice) reloads++;
      };
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = (_channel, id, command) => {
        if (!this.isVoice) return;
        voiceCommands.push(command);
        queueMicrotask(() =>
          handlers.emitter.emit(
            'companion:voice-reply',
            { sender: this.webContents, senderFrame: this.webContents.mainFrame },
            id,
            { kind: 'ok' },
          ),
        );
      };
      this.visible = false;
      this.destroyed = false;
    }
    async loadURL(url) {
      this.url = url;
      this.webContents.mainFrame.url = url;
    }
    showInactive() {
      this.visible = true;
    }
    isVisible() {
      return this.visible;
    }
    setVisibleOnAllWorkspaces() {}
    isVisibleOnAllWorkspaces() {
      return true;
    }
    getBounds() {
      return { ...this.bounds };
    }
    setBounds(value) {
      this.bounds = { ...value };
    }
    setIgnoreMouseEvents() {}
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
  const ipcMain = Object.assign(new EventEmitter(), {
    handle: (name, handler) => handlers.set(name, handler),
    removeHandler: (name) => handlers.delete(name),
  });
  handlers.emitter = ipcMain;
  return {
    windows,
    voiceCommands,
    get surface() {
      return surface;
    },
    reloads: () => reloads,
    /** Put the pointer on the cat: the window is the small idle pet after view.layout none. */
    cursorOnCat() {
      const b = surface.bounds;
      cursor = { x: b.x + Math.floor(b.width / 2), y: b.y + Math.floor(b.height / 2) };
    },
    request(command, activated = false) {
      return handlers.get('companion:request')(
        { sender: surface.webContents, senderFrame: surface.webContents.mainFrame },
        command,
        activated,
      );
    },
    electron: {
      app: { isHidden: () => false },
      BrowserWindow: Window,
      ipcMain,
      powerMonitor: new EventEmitter(),
      systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }) },
      shell: { openExternal: async () => {} },
      session: { fromPartition: () => partition },
      screen: {
        getPrimaryDisplay: () => ({ workArea: area }),
        getDisplayNearestPoint: () => ({ workArea: area }),
        getDisplayMatching: () => ({ workArea: area }),
        getCursorScreenPoint: () => cursor,
      },
    },
  };
}

const open = (f) =>
  createManagedWindow(f.electron, input, {
    voiceResources: { voiceUrl: 'file:///fixture/host-voice.html', voicePreload: '/fixture/host-preload.cjs' },
    validate: () => true,
    request: async (command) =>
      command.kind === 'prepare' || command.kind === 'state' ? { kind: 'state', phase: 'ready' } : { kind: 'ok' },
  });

test('expanding, collapsing, opening panels and dragging leave an open listen-only session exactly as it was', async (t) => {
  const f = fixture();
  const managed = await open(f);
  t.after(() => managed.close());
  assert.equal((await f.request({ kind: 'prepare' }, true)).phase, 'ready');
  assert.equal((await f.request({ kind: 'audio.connect', mode: 'receive_only' }, true)).kind, 'ok');
  const commandsAfterConnect = f.voiceCommands.length;
  assert.equal(commandsAfterConnect, 1, 'exactly one private media command exists before any view operation');
  assert.equal((await f.request({ kind: 'state' })).audio.activeMode, 'receive_only');
  const voiceWindows = f.windows.filter((w) => w.isVoice);
  assert.equal(voiceWindows.length, 1);

  // A deliberate drag of the idle cat: pointer on the small pet window, then release.
  assert.equal((await f.request({ kind: 'view.layout', panel: 'none', width: 120, height: 130 })).kind, 'layout');
  f.cursorOnCat();
  assert.equal((await f.request({ kind: 'view.drag', phase: 'start' }, true)).kind, 'ok');
  assert.equal((await f.request({ kind: 'view.drag', phase: 'end' }, true)).kind, 'ok');

  for (const panel of ['bubble', 'actions', 'menu', 'chat', 'decisions']) {
    assert.equal((await f.request({ kind: 'view.layout', panel, width: 420, height: 500 })).kind, 'layout');
    assert.equal((await f.request({ kind: 'view.resize', expanded: true })).kind, 'ok');
    assert.equal((await f.request({ kind: 'view.layout', panel: 'none', width: 120, height: 130 })).kind, 'layout');
    assert.equal((await f.request({ kind: 'view.resize', expanded: false })).kind, 'ok');
  }
  const state = await f.request({ kind: 'state' });
  assert.equal(state.phase, 'ready', 'the call did not fall out of ready');
  assert.equal(state.audio.activeMode, 'receive_only', 'the audio mode did not change');
  assert.equal(
    f.voiceCommands.length,
    commandsAfterConnect,
    'no stop, close, mute or reconfigure reached the media document',
  );
  assert.equal(voiceWindows[0].destroyed, false, 'the media document survived every view operation');
  assert.equal(f.reloads(), 0, 'the surface was never reloaded, so any capture state was not torn down');
});

test('a panel larger than the 420 x 500 ceiling is refused rather than resizing the window past it', async (t) => {
  const f = fixture();
  const managed = await open(f);
  t.after(() => managed.close());
  await f.request({ kind: 'prepare' }, true);
  for (const size of [
    { width: 421, height: 500 },
    { width: 420, height: 501 },
    { width: 119, height: 130 },
    { width: 420, height: 31 },
  ]) {
    const reply = await f.request({ kind: 'view.layout', panel: 'chat', ...size });
    assert.deepEqual(reply, { kind: 'error', code: 'invalid_request' }, JSON.stringify(size));
  }
  assert.equal((await f.request({ kind: 'view.layout', panel: 'chat', width: 420, height: 500 })).kind, 'layout');
});

test('a deliberate hide is the one view operation that does revoke media (documenting the boundary)', async (t) => {
  const f = fixture();
  const managed = await open(f);
  t.after(() => managed.close());
  await f.request({ kind: 'prepare' }, true);
  await f.request({ kind: 'audio.connect', mode: 'receive_only' }, true);
  assert.equal((await f.request({ kind: 'state' })).audio.activeMode, 'receive_only', 'precondition: media is open');
  await f.request({ kind: 'view.hide' }, true);
  assert.equal((await f.request({ kind: 'state' })).audio.activeMode, null);
});
