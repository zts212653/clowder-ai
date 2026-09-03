import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const REQUIRED_TESTS = [
  'test/runtime-interaction-service.test.ts',
  'test/runtime-interaction-routes.test.ts',
  'test/runtime-interaction-composition.test.ts',
  'test/runtime-interaction-card-publisher.test.ts',
  'test/codex-runtime-interaction-adapter.test.ts',
  'test/codex-runtime-interaction-wire-edge.test.ts',
  'test/approval-hub/f306-approval-adapter.test.ts',
  'test/codex-app-server-protocol-resilience.test.mjs',
];

test('canonical API test command executes every F306 runtime interaction contract suite', () => {
  assert.match(packageJson.scripts.test, /test:runtime-interaction/);
  for (const testPath of REQUIRED_TESTS) {
    assert.match(packageJson.scripts['test:runtime-interaction'] ?? '', new RegExp(escapeRegExp(testPath)));
  }
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
