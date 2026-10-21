const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createLifecycleLogger } = require('./lifecycle-diagnostics');

test('lifecycle logger emits a stable event and structured details', () => {
  const entries = [];
  createLifecycleLogger((entry) => entries.push(entry))('tray-created', { platform: 'win32' });
  assert.equal(entries[0], '[lifecycle] tray-created {"platform":"win32"}');
});
