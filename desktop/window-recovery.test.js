const assert = require('node:assert/strict');
const { test } = require('node:test');
const { resolveWindowRecoveryAction } = require('./window-recovery');

test('focuses the existing main window without starting another owner', () => {
  assert.equal(
    resolveWindowRecoveryAction({ phase: 'ready', hasMainWindow: true, hasSplashWindow: true, isQuitting: false }),
    'focus-main',
  );
});

test('keeps the startup owner and surfaces splash while services are starting', () => {
  assert.equal(
    resolveWindowRecoveryAction({ phase: 'starting', hasMainWindow: false, hasSplashWindow: true, isQuitting: false }),
    'show-splash',
  );
});

test('recreates the visible window after a ready renderer was destroyed', () => {
  assert.equal(
    resolveWindowRecoveryAction({ phase: 'ready', hasMainWindow: false, hasSplashWindow: false, isQuitting: false }),
    'recreate-main',
  );
});

test('ignores launches after an orderly shutdown begins', () => {
  assert.equal(
    resolveWindowRecoveryAction({ phase: 'quitting', hasMainWindow: true, hasSplashWindow: true, isQuitting: true }),
    'ignore',
  );
});
