import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PUBLIC_CONTRACT_TESTS = [
  'capability-revoke.test.js',
  'install-policy.test.js',
  'probe-state.test.js',
  'skill-content-scanner.test.js',
  'skill-permissions.test.js',
  'skill-security-store.test.js',
  'version-lock.test.js',
];

describe('Public test import contract', () => {
  test('Node 20 public-contract tests do not import source TypeScript directly', () => {
    for (const testFile of PUBLIC_CONTRACT_TESTS) {
      const source = readFileSync(join(__dirname, testFile), 'utf8');
      assert.doesNotMatch(
        source,
        /from ['"]\.\.\/src\/.*\.ts['"]/,
        `${testFile} must import built JS from dist/, not source TypeScript`,
      );
    }
  });
});
