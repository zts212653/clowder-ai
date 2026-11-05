const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const appLifecycle = require('./app-lifecycle');
const { showVisibleRenderer } = require('./visible-renderer');

function mainWindowFixture({ assertServices = () => {}, useVisibleRenderer = false } = {}) {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf('async function createMainWindow()');
  const end = source.indexOf('const shutdown =', start);
  assert.ok(start >= 0 && end > start, 'main window factory must exist');
  const webContents = new EventEmitter();
  const events = [];
  let invalidations = 0;
  let window;
  const context = vm.createContext({
    BrowserWindow: class extends EventEmitter {
      constructor() {
        super();
        this.webContents = webContents;
        window = this;
      }
      setMenu() {}
      loadURL(url) {
        events.push({ name: 'loadURL', url });
      }
      show() {
        events.push({ name: 'show' });
      }
    },
    path,
    __dirname,
    API_ORIGIN: 'http://localhost:3200',
    APP_ORIGIN: 'http://localhost:5200',
    APP_URL: 'http://localhost:5200',
    installRendererNavigation() {},
    shell: {},
    dbg() {},
    appLifecycle,
    lifecycle: (name, details) => events.push({ name, details }),
    updatePrompt: { markRendererUnavailable: () => invalidations++ },
    startupTimeline: { runPhase: (_name, action) => action(), mark() {} },
    showVisibleRenderer: useVisibleRenderer ? showVisibleRenderer : async () => {},
    createVersionedRendererUrl: (url) => url,
    app: { getVersion: () => 'fixture' },
    startupController: new AbortController(),
    services: { assertStartupProcessesRunning: assertServices },
    splashWindow: null,
  });
  return {
    events,
    webContents,
    start: () => vm.runInContext(`${source.slice(start, end)}\ncreateMainWindow();`, context),
    signalFirstFrame: () => window?.emit('ready-to-show'),
    invalidations: () => invalidations,
  };
}

test('the actual main window invalidates update readiness when its renderer exits', async () => {
  const { start, invalidations, webContents, events } = mainWindowFixture();
  await start();
  assert.equal(invalidations(), 0);
  const details = { reason: 'crashed', exitCode: 7 };
  webContents.emit('render-process-gone', {}, details);
  assert.equal(invalidations(), 1);
  assert.deepEqual(events, [{ name: 'renderer-process-gone', details }]);
  webContents.emit('did-navigate');
  assert.equal(invalidations(), 2);
});

for (const afterNavigation of [false, true]) {
  test(`rejects a renderer handoff after service exit (after navigation: ${afterNavigation})`, async () => {
    let exited = !afterNavigation;
    const { start, events, signalFirstFrame } = mainWindowFixture({
      useVisibleRenderer: true,
      assertServices: () => {
        if (exited) throw new Error('owned Web exited');
      },
    });
    const startup = start();
    exited = true;
    signalFirstFrame();
    await assert.rejects(startup, /owned Web exited/);
    assert.deepEqual(
      events.map(({ name }) => name),
      afterNavigation ? ['loadURL'] : [],
    );
  });
}
