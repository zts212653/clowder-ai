const { EventEmitter } = require('node:events');
const { createManagedWindow } = require('./window.cjs');

const input = {
  url: `http://companion-${'a'.repeat(32)}.localhost:4187/packages/fixture/body/index.html`,
  presentation: { width: 320, height: 350, frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true },
};

function fixture() {
  const handlers = new Map();
  const partition = new EventEmitter();
  partition.webRequest = { onBeforeRequest() {} };
  partition.setPermissionCheckHandler = () => {};
  partition.setPermissionRequestHandler = () => {};
  partition.setDisplayMediaRequestHandler = () => {};
  let win;
  let reducedMotion = false;
  let cursor = { x: 1000, y: 500 };
  const area = { x: 0, y: 0, width: 1280, height: 720 };
  class Window extends EventEmitter {
    constructor(options) {
      super();
      win = this;
      this.bounds = { x: options.x, y: options.y, width: options.width, height: options.height };
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = { url: input.url };
      this.webContents.getURL = () => this.url;
      this.webContents.send = () => {};
      this.webContents.reload = () => {};
      this.webContents.setWindowOpenHandler = () => {};
      this.visible = false;
      this.destroyed = false;
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
  return {
    get win() {
      return win;
    },
    setReducedMotion(value) {
      reducedMotion = value;
    },
    setCursor(value) {
      cursor = value;
    },
    request(command, activated = false) {
      return handlers.get('companion:request')(
        { sender: win.webContents, senderFrame: win.webContents.mainFrame },
        command,
        activated,
      );
    },
    electron: {
      app: { isHidden: () => false },
      BrowserWindow: Window,
      ipcMain: Object.assign(new EventEmitter(), {
        handle: (name, handler) => handlers.set(name, handler),
        removeHandler: (name) => handlers.delete(name),
      }),
      powerMonitor: new EventEmitter(),
      systemPreferences: { getAnimationSettings: () => ({ prefersReducedMotion: reducedMotion }) },
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

function open(f) {
  return createManagedWindow(f.electron, input, {
    validate: () => true,
    request: async (command) =>
      ['state', 'prepare'].includes(command.kind)
        ? { kind: 'state', phase: 'ready', behaviorEnabled: true }
        : { kind: 'ok' },
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

module.exports = { input, fixture, open, deferred };
