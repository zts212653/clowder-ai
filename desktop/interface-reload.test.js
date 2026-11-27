const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { createInterfaceReloadHandler } = require('./interface-reload');

function fixture({ status = 'ready', responses = [], failFirst = false } = {}) {
  const calls = [];
  const contents = new EventEmitter();
  const url = 'http://localhost:5613/thread/one#appearance';
  const window = { webContents: contents, isDestroyed: () => false };
  class MessageChannelMain {
    constructor() {
      this.port1 = Object.assign(new EventEmitter(), { start() {}, close() {} });
      this.port2 = this.port1;
    }
  }
  contents.getURL = () => url;
  contents.postMessage = (channel, _value, [port]) => {
    calls.push(channel);
    if (status !== null) queueMicrotask(() => port.emit('message', { data: status }));
  };
  contents.reloadIgnoringCache = () => {
    calls.push('reload');
    queueMicrotask(() =>
      failFirst ? contents.emit('did-fail-load', {}, -102, 'refused', url, true) : contents.emit('did-finish-load'),
    );
  };
  contents.loadURL = async (target) => {
    calls.push(target);
    contents.emit('did-finish-load');
  };
  const dialog = {
    showMessageBox: async (...args) => {
      calls.push(args.at(-1));
      return { response: responses.shift() ?? 0 };
    },
  };
  return {
    run: createInterfaceReloadHandler({ dialog, MessageChannelMain, prepareTimeoutMs: 10, loadTimeoutMs: 100 }),
    window,
    calls,
    url,
  };
}

test('waits for preflight and reloads only the original contents without a dialog', async () => {
  const { run, window, calls } = fixture();
  await Promise.all([run(window), run(window)]);
  assert.deepEqual(calls, ['desktop-interface-reload:prepare', 'reload']);
});

test('a known attachment, failed draft save, or active editor keeps the page', async () => {
  for (const status of ['attachment', 'draft', 'busy']) {
    const { run, window, calls } = fixture({ status });
    await run(window);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].type, 'info');
  }
});

test('no renderer answer keeps the original page unless the user explicitly continues', async () => {
  const stopped = fixture({ status: null });
  await stopped.run(stopped.window);
  assert.equal(stopped.calls[1].defaultId, 0);
  assert.equal(stopped.calls[1].cancelId, 0);
  assert.equal(stopped.calls.includes('reload'), false);

  const continued = fixture({ status: null, responses: [1] });
  await continued.run(continued.window);
  assert.equal(continued.calls.at(-1), 'reload');
});

test('uses native retry to navigate the same contents to the original URL after a load error', async () => {
  const { run, window, calls, url } = fixture({ failFirst: true, responses: [1] });
  await run(window);
  assert.equal(calls[1], 'reload');
  assert.equal(calls[2].type, 'error');
  assert.equal(calls[3], url);
});

test('gives native feedback when the main window is unavailable', async () => {
  const { run, calls } = fixture();
  await run(null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'info');
});
