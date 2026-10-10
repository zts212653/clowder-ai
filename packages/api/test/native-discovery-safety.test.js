import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeNativeStartup } from '../dist/routes/native-runtimes.js';

test('discovery does not expose credential or URL-bearing startup descriptors', () => {
  assert.equal(safeNativeStartup('node', ['entry.js', '--profile', 'acp']), true);
  assert.equal(safeNativeStartup('agent', ['--api-key', 'hidden']), false);
  assert.equal(safeNativeStartup('agent', ['--base-url=https://user:password@example.test']), false);
  assert.equal(safeNativeStartup('agent', ['--token=hidden']), false);
});
