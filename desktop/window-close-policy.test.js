const assert = require('node:assert/strict');
const { test } = require('node:test');
const { decideWindowClose } = require('./window-close-policy');

test('Windows manual close hides when the tray is available', () => {
  assert.deepEqual(decideWindowClose({ platform: 'win32', isQuitting: false, trayAvailable: true }), {
    action: 'hide',
    reason: 'manual-close',
  });
});

test('Windows explicit quit is allowed through even with a tray', () => {
  assert.deepEqual(decideWindowClose({ platform: 'win32', isQuitting: true, trayAvailable: true }), {
    action: 'allow',
    reason: 'quit-requested',
  });
});

test('Windows without a tray keeps the window visible so the process has an entry point', () => {
  assert.deepEqual(decideWindowClose({ platform: 'win32', isQuitting: false, trayAvailable: false }), {
    action: 'keep-visible',
    reason: 'tray-unavailable',
  });
});

test('macOS keeps the previous tray-hide behavior', () => {
  assert.deepEqual(decideWindowClose({ platform: 'darwin', isQuitting: false, trayAvailable: true }), {
    action: 'hide',
    reason: 'manual-close',
  });
});

test('non-Windows platforms without a tray retain native close behavior', () => {
  assert.deepEqual(decideWindowClose({ platform: 'darwin', isQuitting: false, trayAvailable: false }), {
    action: 'allow',
    reason: 'non-windows',
  });
});
