// Shared fake Electron for the F336 window-group tests: a panel, an optional living body,
// the Host voice document and one process-wide companion:request handler.
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createManagedWindow } = require('./window.cjs');

const origin = `http://companion-${'a'.repeat(32)}.localhost:4187/packages/fixture/body`;
const bodyUrl = `${origin}/body.html`;
// A livingBody line with its verified body page: the only launch that may open a body.
const input = {
  url: `${origin}/index.html`,
  presentation: { width: 320, height: 350, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true },
  publicCompanionV2: true,
  companionContract: '0.3.3-candidate.3',
  bodyUrl,
};

function fixture({
  realBody = false,
  api,
  replies,
  launch = input,
  failBody = false,
  bodyGate,
  dialogResponse = 1,
} = {}) {
  const handlers = new Map();
  const partitionNames = [];
  const counts = { handle: 0, removeHandler: 0 };
  const partition = new EventEmitter();
  partition.webRequest = { onBeforeRequest() {} };
  partition.setPermissionCheckHandler = () => {};
  partition.setPermissionRequestHandler = () => {};
  partition.setDisplayMediaRequestHandler = () => {};
  const windows = [];
  const sent = [];
  const voiceCommands = [];
  const area = { x: 0, y: 0, width: 1280, height: 720 };
  const cursor = { x: 1000, y: 500 };
  let panel;
  const ipcMain = Object.assign(new EventEmitter(), {
    handle(name, handler) {
      if (name === 'companion:request') counts.handle++;
      handlers.set(name, handler);
    },
    removeHandler(name) {
      if (name === 'companion:request') counts.removeHandler++;
      handlers.delete(name);
    },
  });
  class Window extends EventEmitter {
    constructor(options = {}) {
      super();
      windows.push(this);
      this.options = options;
      this.isVoice = options.width === 1;
      if (!this.isVoice && !options.body) panel ??= this;
      this.bounds = { x: options.x ?? 0, y: options.y ?? 0, width: options.width ?? 0, height: options.height ?? 0 };
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: options.url };
      this.webContents.getURL = () => this.url;
      this.webContents.reload = () => {};
      this.webContents.setWindowOpenHandler = () => {};
      this.sent = [];
      this.webContents.send = (channel, id, command) => {
        if (!this.isVoice) {
          this.sent.push({ channel, value: id });
          return sent.push({ channel, value: id });
        }
        voiceCommands.push(command);
        queueMicrotask(() =>
          ipcMain.emit(
            'companion:voice-reply',
            { sender: this.webContents, senderFrame: this.webContents.mainFrame },
            id,
            {
              kind: 'ok',
            },
          ),
        );
      };
      this.visible = false;
      this.destroyed = false;
      this.ignores = [];
    }
    async loadURL(url) {
      this.url = url;
      this.webContents.mainFrame.url = url;
    }
    showInactive() {
      this.visible = true;
    }
    focus() {
      this.focused = (this.focused ?? 0) + 1;
    }
    setOpacity(value) {
      this.opacity = value;
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
    setIgnoreMouseEvents(...args) {
      this.ignores.push(args);
    }
    hide() {
      const wasVisible = this.visible;
      this.visible = false;
      if (wasVisible) this.emit('hide'); // Electron reports a native hide for every programmatic hide.
    }
    isDestroyed() {
      return this.destroyed;
    }
    destroy() {
      this.destroyed = true;
      this.emit('closed');
    }
  }
  const apiCommands = [];
  const failures = [];
  const sceneLogs = [];
  const bodyLogs = [];
  const bodies = [];
  const options = {
    voiceResources: { voiceUrl: 'file:///fixture/host-voice.html', voicePreload: '/fixture/host-preload.cjs' },
    validate: () => true,
    onFailure: (reason) => failures.push(reason),
    onSceneLog: (line) => sceneLogs.push(line),
    onBodyLog: (line) => bodyLogs.push(line),
    request: async (command) => {
      apiCommands.push(command.kind);
      if (api && command.kind.startsWith('scene.')) return api(command);
      const reply = await replies?.(command);
      if (reply) return reply;
      return ['prepare', 'state'].includes(command.kind) ? { kind: 'state', phase: 'ready' } : { kind: 'ok' };
    },
    ...(realBody
      ? {}
      : {
          createBodyWindow: async ({ url }) => {
            if (typeof failBody === 'function' ? failBody() : failBody) throw new Error('fixture body failed to load');
            const body = new Window({ body: true, url, ...area }); // like the real one: the primary work area
            await body.loadURL(url);
            bodies.push(body);
            await bodyGate?.(); // a test may hold a body's load open
            return body;
          },
        }),
  };
  const electron = {
    app: { isHidden: () => false },
    BrowserWindow: Window,
    ipcMain,
    powerMonitor: new EventEmitter(),
    systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: false }) },
    shell: { openExternal: async () => {} },
    session: {
      fromPartition: (name) => {
        partitionNames.push(name);
        return partition;
      },
    },
    dialog: { showMessageBox: async () => ({ response: dialogResponse }) },
    screen: Object.assign(new EventEmitter(), {
      getPrimaryDisplay: () => ({ workArea: area }),
      getDisplayNearestPoint: () => ({ workArea: area }),
      getDisplayMatching: () => ({ workArea: area }),
      getCursorScreenPoint: () => ({ ...cursor }),
    }),
  };
  const from = (win) => ({ sender: win.webContents, senderFrame: win.webContents.mainFrame });
  return {
    Window,
    counts,
    handlers,
    windows,
    voiceCommands,
    apiCommands,
    failures,
    sceneLogs,
    bodyLogs,
    bodies,
    area,
    cursor,
    screen: electron.screen,
    partitionNames,
    powerMonitor: electron.powerMonitor,
    get panel() {
      return panel;
    },
    mediaStops: () => sent.filter((row) => row.value?.kind === 'media-stopped').map((row) => row.value.reason),
    request: (win, command, activated = false) => handlers.get('companion:request')(from(win), command, activated),
    open: () => createManagedWindow(electron, launch, options),
  };
}

async function openWithCall(f) {
  const managed = await f.open();
  assert.equal((await f.request(f.panel, { kind: 'prepare' }, true)).phase, 'ready');
  assert.equal((await f.request(f.panel, { kind: 'audio.connect', mode: 'receive_only' }, true)).kind, 'ok');
  assert.equal((await f.request(f.panel, { kind: 'state' })).audio.activeMode, 'receive_only');
  return managed;
}

module.exports = { fixture, openWithCall, bodyUrl, input };
