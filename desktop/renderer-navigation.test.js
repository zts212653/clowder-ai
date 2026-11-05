const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { installRendererNavigation } = require('./renderer-navigation');

test('retains navigation, trusted downloads and current preview-origin boundaries', async () => {
  const webContents = new EventEmitter();
  const downloads = [],
    external = [];
  let popup;
  let origins = new Set(['http://localhost:5200']);
  webContents.downloadURL = (url) => downloads.push(url);
  webContents.setWindowOpenHandler = (handler) => {
    popup = handler;
  };
  installRendererNavigation({
    window: { webContents },
    appOrigin: 'http://localhost:5200',
    apiOrigin: 'http://localhost:3200',
    getLinkOrigins: () => origins,
    shell: {
      openExternal: async (url) => {
        external.push(url);
      },
    },
    dbg() {},
  });
  const navigate = (event, url, isMainFrame = true) => {
    let prevented = false;
    webContents.emit(event, {
      url,
      isMainFrame,
      preventDefault() {
        prevented = true;
      },
    });
    return prevented;
  };
  assert.equal(navigate('will-navigate', 'http://localhost:5200/settings'), false);
  assert.equal(navigate('will-redirect', 'https://untrusted.invalid/'), true);
  assert.equal(navigate('will-navigate', 'https://frame.invalid/', false), false);
  assert.equal(navigate('will-navigate', 'http://localhost:3200/uploads/example.html'), true);
  assert.deepEqual(downloads, ['http://localhost:3200/uploads/example.html']);
  assert.deepEqual(popup({ url: 'http://localhost:4200/preview' }), { action: 'deny' });
  assert.equal(external.length, 0);
  origins = new Set([...origins, 'http://localhost:4200']);
  assert.deepEqual(popup({ url: 'http://localhost:4200/preview' }), { action: 'deny' });
  popup({ url: 'javascript:alert(1)' });
  await new Promise(setImmediate);
  assert.deepEqual(external, ['http://localhost:4200/preview']);
});
