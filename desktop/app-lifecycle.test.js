const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createAppLifecycleHandlers, serializeProcessError } = require('./app-lifecycle');

function createFixture(platform = 'win32') {
  const entries = [];
  const quitSources = [];
  const shutdown = { handleBeforeQuit: (event) => (event.handled = true) };
  const handlers = createAppLifecycleHandlers({
    lifecycle: (name, details) => entries.push({ name, details }),
    requestQuit: (source) => quitSources.push(source),
    shutdown,
    getState: () => ({ isQuitting: false, quitSource: null, trayAvailable: true }),
    platform,
  });
  return { entries, quitSources, handlers };
}

test('Windows window-all-closed is diagnostic only and does not request quit', () => {
  const fixture = createFixture('win32');
  fixture.handlers.windowAllClosed();
  assert.deepEqual(fixture.quitSources, []);
  assert.equal(fixture.entries[0].name, 'window-all-closed');
});

test('non-Windows window-all-closed requests the normal quit path', () => {
  const fixture = createFixture('darwin');
  fixture.handlers.windowAllClosed();
  assert.deepEqual(fixture.quitSources, ['window-all-closed']);
});

test('before-quit and terminal quit lifecycle are recorded', () => {
  const fixture = createFixture();
  const event = {};
  fixture.handlers.beforeQuit(event);
  fixture.handlers.willQuit();
  fixture.handlers.quit({}, 0);
  assert.equal(event.handled, true);
  assert.deepEqual(
    fixture.entries.map((entry) => entry.name),
    ['before-quit', 'will-quit', 'app-quit'],
  );
});

test('uncaught exceptions and rejected promises retain actionable error details', () => {
  const fixture = createFixture();
  fixture.handlers.uncaughtExceptionMonitor(new Error('tray callback failed'));
  fixture.handlers.unhandledRejection('redis child stopped');
  assert.equal(fixture.entries[0].details.message, 'tray callback failed');
  assert.equal(fixture.entries[1].details.message, 'redis child stopped');
  assert.deepEqual(serializeProcessError(new Error('x')).name, 'Error');
});

test('process exit records the exit code', () => {
  const fixture = createFixture();
  fixture.handlers.processExit(1);
  assert.equal(fixture.entries[0].name, 'process-exit');
  assert.equal(fixture.entries[0].details.exitCode, 1);
});
