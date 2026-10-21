import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PUBLIC_TEST_DENY_REDIS_URL } from '../scripts/public-test-isolation-preflight.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(__dirname, '../package.json');
const runPublicTestsPath = resolve(__dirname, '../scripts/run-public-tests.sh');
const resolverPath = resolve(__dirname, '../scripts/resolve-public-test-files.mjs');

test('test:public delegates to run-public-tests.sh, never inline grep -v', () => {
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const script = pkg.scripts?.['test:public'] ?? '';
  const prepared = pkg.scripts?.['test:public:prepared'] ?? '';
  const shard = pkg.scripts?.['test:public:shard'] ?? '';
  const summary = pkg.scripts?.['test:public:summary'] ?? '';

  // P1 fix (codex review #2326): npm script must hand off to run-public-tests.sh
  // so resolver failures fail-propagate. Inline $(node resolver.mjs) inside the
  // node --test argv would discard the exit code and let Node walk the whole tree.
  assert.match(script, /test:public:prepared/, script);
  assert.match(prepared, /bash \.\/scripts\/run-public-tests\.sh/, prepared);
  assert.match(shard, /with-test-home\.sh node \.\/scripts\/run-public-test-shard\.mjs/, shard);
  assert.match(summary, /summarize-public-test-shards\.mjs/, summary);
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

test('serial public lane overrides the test-home Redis default before executing any selected test', () => {
  const root = mkdtempSync(join(tmpdir(), 'public-serial-redis-boundary-'));
  const scripts = join(root, 'scripts');
  const bin = join(root, 'bin');
  mkdirSync(scripts);
  mkdirSync(bin);
  cpSync(runPublicTestsPath, join(scripts, 'run-public-tests.sh'));
  cpSync(resolve(__dirname, '../scripts/with-test-home.sh'), join(scripts, 'with-test-home.sh'));
  // Probe the real shell entry without running the whole test set or opening a socket.
  const node = join(bin, 'node');
  writeFileSync(
    node,
    `#!${process.execPath}
if (process.argv.includes('./scripts/resolve-public-test-files.mjs')) {
  console.log('test/selected-fixture.test.js');
} else {
  console.log(JSON.stringify({ redis: process.env.REDIS_URL, args: process.argv.slice(2) }));
}
`,
  );
  chmodSync(node, 0o755);
  const result = spawnSync('bash', [join(scripts, 'with-test-home.sh'), 'bash', join(scripts, 'run-public-tests.sh')], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REDIS_URL: 'redis://127.0.0.1:6399' },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const probe = JSON.parse(result.stdout);
  assert.equal(probe.redis, PUBLIC_TEST_DENY_REDIS_URL);
  assert.ok(probe.args.includes('--test'));
  assert.ok(probe.args.includes('test/selected-fixture.test.js'));
});
