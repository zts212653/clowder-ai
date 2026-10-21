const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const appLifecycle = require('./app-lifecycle');

test('the actual main window invalidates update readiness when its renderer exits', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const start = source.indexOf('async function createMainWindow()');
  const end = source.indexOf('const shutdown =', start);
  assert.ok(start >= 0 && end > start, 'main window factory must exist');
  const webContents = new EventEmitter();
  const events = [];
  let invalidations = 0;
  const context = vm.createContext({
    BrowserWindow: class extends EventEmitter {
      constructor() {
        super();
        this.webContents = webContents;
      }
      setMenu() {}
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
    showVisibleRenderer: async () => {},
    createVersionedRendererUrl: (url) => url,
    app: { getVersion: () => 'fixture' },
    startupController: new AbortController(),
  });
  await vm.runInContext(`${source.slice(start, end)}\ncreateMainWindow();`, context);
  assert.equal(invalidations, 0);
  const details = { reason: 'crashed', exitCode: 7 };
  webContents.emit('render-process-gone', {}, details);
  assert.equal(invalidations, 1);
  assert.deepEqual(events, [{ name: 'renderer-process-gone', details }]);
  webContents.emit('did-navigate');
  assert.equal(invalidations, 2);
});
