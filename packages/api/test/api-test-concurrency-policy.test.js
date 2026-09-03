import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('canonical API test command stays within the measured full-suite worker budget', () => {
  const script = packageJson.scripts.test;

  assert.match(script, /--test\s+--test-concurrency=4\s+--test-timeout=60000/);
  assert.doesNotMatch(script, /--test-concurrency=0/);
});
