const { EventEmitter } = require('node:events');
const { writeSync } = require('node:fs');
const { registerHooks } = require('node:module');
const Module = require('node:module');
const { fixture, input } = require('./window-motion-fixture.cjs');

const f = fixture();
const mode = process.argv[2];
let releaseReady;
const ready =
  mode === 'late-ready'
    ? new Promise((resolve) => {
        releaseReady = resolve;
      })
    : Promise.resolve();
let releaseLoad;
const loadReady =
  mode === 'late-load'
    ? new Promise((resolve) => {
        releaseLoad = resolve;
      })
    : Promise.resolve();
let quitCalls = 0;
let exitCalls = 0;
let windowsCreated = 0;
let profile;
let readyCalls = 0;
const report = (value) => writeSync(4, `${JSON.stringify(value)}\n`);
// Observe without handling: the baseline still takes Node's fatal uncaught path.
process.on('uncaughtExceptionMonitor', (error) => report({ kind: 'uncaught', code: error.code }));
const app = Object.assign(new EventEmitter(), {
  whenReady: () => {
    report({ kind: 'waiting-ready', calls: ++readyCalls });
    return ready;
  },
  isHidden: () => false,
  setName() {},
  setPath(name, value) {
    if (name === 'userData') profile = value;
  },
  dock: { setIcon() {} },
  quit() {
    quitCalls++;
    app.emit('before-quit');
    if (f.win && !f.win.isDestroyed()) f.win.destroy();
    report({ kind: 'quit-called', quitCalls });
    if (!['late-ready', 'late-load'].includes(mode)) setImmediate(() => process.exit(0));
  },
  exit(code) {
    exitCalls++;
    setImmediate(() => process.exit(code));
  },
});
const BaseWindow = f.electron.BrowserWindow;
f.electron.app = app;
f.electron.BrowserWindow = class extends BaseWindow {
  constructor(options) {
    super(options);
    windowsCreated++;
  }
  async loadURL(url) {
    await super.loadURL(url);
    if (mode === 'late-load') report({ kind: 'waiting-load' });
    await loadReady;
  }
  destroy() {
    super.destroy();
    app.emit('window-all-closed');
  }
};
const load = Module._load;
Module._load = function (request, parent, isMain) {
  return request === 'electron' ? f.electron : load.call(this, request, parent, isMain);
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('/desktop-window-runtime/admission.js'))
      return { url: 'fixture:desktop-contract', shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === 'fixture:desktop-contract')
      return {
        format: 'module',
        source: 'export const companionCommandValidator = () => () => true;',
        shortCircuit: true,
      };
    return nextLoad(url, context);
  },
});
process.on('message', (message) => {
  if (message === 'start') {
    require('./main.cjs');
    report({ kind: 'started' });
  }
  if (message === 'destroy-window') f.win.destroy();
  if (message === 'native-quit') app.quit();
  if (message === 'bridge')
    void f.request({ kind: 'state' }).then((reply) => report({ kind: 'bridge-settled', reply }));
  if (message === 'release-ready') releaseReady();
  if (message === 'release-load') releaseLoad();
  if (message === 'finish') setImmediate(() => setImmediate(() => process.exit(0)));
});
process.on('exit', () =>
  report({ kind: 'terminal', quitCalls, exitCalls, windowsCreated, destroyed: f.win?.isDestroyed(), profile }),
);
report({ kind: 'fixture-ready', input });
