const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { showVisibleRenderer } = require('./visible-renderer');
function createWindow() {
  const window = new EventEmitter();
  window.webContents = new EventEmitter();
  window.loadURL = () => Promise.resolve();
  return window;
}
test('does not report visibility when loadURL or did-finish-load completes', async () => {
  const window = createWindow();
  let visible = false;
  const wait = showVisibleRenderer({
    window,
    url: 'http://fixture.invalid/',
    onVisible: () => {
      visible = true;
    },
  });
  window.webContents.emit('did-finish-load');
  await new Promise(setImmediate);
  assert.equal(visible, false);
  window.emit('ready-to-show');
  await wait;
  assert.equal(visible, true);
  assert.equal(window.listenerCount('closed'), 0);
});
for (const event of ['closed', 'render-process-gone', 'did-fail-load'])
  test(`rejects an early renderer ${event}`, async () => {
    const window = createWindow();
    let visible = false;
    const wait = showVisibleRenderer({
      window,
      url: 'http://fixture.invalid/',
      onVisible: () => {
        visible = true;
      },
    });
    if (event === 'closed') window.emit(event);
    else window.webContents.emit(event, {}, -102, 'private error', 'private URL', true);
    await assert.rejects(wait, /Renderer/);
    assert.equal(visible, false);
    assert.equal(window.listenerCount('ready-to-show'), 0);
  });
test('ignores subframe failure and bounds a renderer that never becomes visible', async () => {
  const window = createWindow();
  const wait = showVisibleRenderer({
    window,
    url: 'http://fixture.invalid/',
    onVisible: () => assert.fail('Not visible'),
    timeoutMs: 10,
  });
  window.webContents.emit('did-fail-load', {}, -102, '', '', false);
  await assert.rejects(wait, /did not become visible/);
});
test('observes loadURL rejection without waiting for a native dialog', async () => {
  const window = createWindow();
  window.loadURL = async () => {
    throw new Error('controlled load failure');
  };
  await assert.rejects(
    showVisibleRenderer({ window, url: 'http://fixture.invalid/', onVisible: () => {} }),
    /controlled load failure/,
  );
});
for (const early of [true, false])
  test(`cancellation prevents a late visible frame (early=${early})`, async () => {
    const window = createWindow(),
      controller = new AbortController();
    let loads = 0;
    window.loadURL = () => {
      loads++;
      return Promise.resolve();
    };
    if (early) controller.abort(new Error('controlled quit'));
    const wait = showVisibleRenderer({
      window,
      url: 'http://fixture.invalid/',
      signal: controller.signal,
      onVisible: () => assert.fail('Cancelled window was shown'),
    });
    if (!early) controller.abort(new Error('controlled quit'));
    window.emit('ready-to-show');
    await assert.rejects(wait, /controlled quit/);
    assert.equal(loads, early ? 0 : 1);
    assert.equal(window.listenerCount('ready-to-show'), 0);
  });
