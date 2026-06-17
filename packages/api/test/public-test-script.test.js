import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(__dirname, '../package.json');
const runPublicTestsPath = resolve(__dirname, '../scripts/run-public-tests.sh');
const resolverPath = resolve(__dirname, '../scripts/resolve-public-test-files.mjs');

test('test:public delegates to run-public-tests.sh, never inline grep -v', () => {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const script = pkg.scripts?.['test:public'] ?? '';

  // P1 fix (codex review #2326): npm script must hand off to run-public-tests.sh
  // so resolver failures fail-propagate. Inline $(node resolver.mjs) inside the
  // node --test argv would discard the exit code and let Node walk the whole tree.
  assert.match(script, /bash \.\/scripts\/run-public-tests\.sh/, script);
  assert.doesNotMatch(script, /\$\(node \.\/scripts\/resolve-public-test-files\.mjs\)/, script);
  assert.doesNotMatch(script, /grep -v/, script);
});

test('run-public-tests.sh exists, is executable, and routes through the resolver with strict shell flags', () => {
  assert.ok(existsSync(runPublicTestsPath), 'run-public-tests.sh must exist');
  const mode = statSync(runPublicTestsPath).mode;
  // owner execute bit
  assert.ok((mode & 0o100) !== 0, 'run-public-tests.sh must be owner-executable');

  const source = readFileSync(runPublicTestsPath, 'utf8');
  assert.match(source, /set -euo pipefail/, 'strict shell flags required for fail-propagation');
  assert.match(source, /node \.\/scripts\/resolve-public-test-files\.mjs/, 'must call the resolver');
  assert.match(source, /refusing to run/i, 'must guard against empty / failed resolver output');
});

test('resolve-public-test-files.mjs still exists as the registry source', () => {
  assert.ok(existsSync(resolverPath), 'resolver script must exist');
});
