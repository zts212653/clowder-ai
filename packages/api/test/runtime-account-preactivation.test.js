import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

function prepareFixture(root, { verdict = 2, checkerPresent = true, stalePackage } = {}) {
  const checker = join(root, 'packages/api/dist/scripts/runtime-account-preflight/cli.js');
  mkdirSync(dirname(checker), { recursive: true });
  for (const name of ['api', 'shared']) {
    mkdirSync(join(root, `packages/${name}/dist`), { recursive: true });
    writeFileSync(join(root, `packages/${name}/dist/index.js`), '');
    writeFileSync(
      join(root, `packages/${name}/dist/.build-commit`),
      name === stalePackage ? 'old-head' : 'fixture-head',
    );
  }
  if (checkerPresent) {
    writeFileSync(
      checker,
      `process.stderr.write('Account preflight inspected ' + process.argv.slice(2).join(' ') + '\\n'); process.exitCode = ${verdict};\n`,
    );
  }
}

function launchFixture({ verdict = 2, deployment = 'runtime', checkerPresent = true, stalePackage, allow = false }) {
  const root = mkdtempSync(join(tmpdir(), 'account-preactivation-'));
  try {
    prepareFixture(root, { verdict, checkerPresent, stalePackage });
    const script = resolve('../../scripts/start-dev.sh');
    return spawnSync(
      'bash',
      [
        '-c',
        `
set -e
source "$1" --source-only >/dev/null
PROJECT_DIR="$2"
CAT_CAFE_DEPLOYMENT_ID="$3"
ALLOW_ACCOUNT_REGRESSION="$4"
git() { printf 'fixture-head'; }
guard_main_branch_start() { :; }
guard_runtime_redis_sanctuary() { :; }
kill_managed_ports() { printf 'REPLACEMENT_REACHED'; exit 0; }
main
`,
        'account-preactivation-test',
        script,
        root,
        deployment,
        String(allow),
      ],
      {
        encoding: 'utf8',
        env: { PATH: process.env.PATH, HOME: root, TERM: 'dumb', CAT_CAFE_SKIP_NODE_RUNTIME_GUARD: '1' },
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('a rejected active account prevents the launcher from touching existing processes', () => {
  const result = launchFixture({});
  assert.doesNotMatch(result.stdout, /REPLACEMENT_REACHED/, result.stderr);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /Account preflight inspected/);
  assert.doesNotMatch(result.stdout, /正在关闭服务|再见/);
});

test('unknown checker failure does not turn a diagnostic fault into an outage', () => {
  const result = launchFixture({ verdict: 1 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /REPLACEMENT_REACHED/);
  assert.match(result.stderr, /unknown.*checker failed/i);
});

test('a healthy candidate can replace existing processes', () => {
  const result = launchFixture({ verdict: 0 });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /REPLACEMENT_REACHED/);
  assert.match(result.stdout, /正在关闭服务/);
});

test('missing checker is unknown and does not turn a build invariant fault into an account veto', () => {
  const result = launchFixture({ checkerPresent: false });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /REPLACEMENT_REACHED/);
  assert.match(result.stderr, /preflight is missing/);
});

for (const stalePackage of ['shared', 'api']) {
  test(`a stale ${stalePackage} build is never used as candidate evidence`, () => {
    const result = launchFixture({ stalePackage });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /REPLACEMENT_REACHED/);
    assert.match(result.stderr, /build invariant missing\/stale/);
    assert.doesNotMatch(result.stderr, /Account preflight inspected/);
  });
}

test('non-runtime development launch does not inspect runtime bindings', () => {
  const result = launchFixture({ deployment: 'alpha' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /REPLACEMENT_REACHED/);
  assert.doesNotMatch(result.stderr, /Account preflight inspected/);
});

test('explicit loss acceptance reaches the checker separately from runtime --force', () => {
  const result = launchFixture({ verdict: 0, allow: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /--api-port \d+ --allow-account-regression/);
});

test('daemon launch rejects before any daemon state or process is created', () => {
  const root = mkdtempSync(join(tmpdir(), 'account-preactivation-daemon-'));
  try {
    prepareFixture(root);
    mkdirSync(join(root, 'scripts/lib'), { recursive: true });
    for (const path of [
      'start-dev.sh',
      'download-source-overrides.sh',
      'lib/node-runtime-guard.sh',
      'lib/redis-rdb-first.sh',
    ]) {
      cpSync(resolve('../../scripts', path), join(root, 'scripts', path));
    }
    mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'bin/git'), '#!/bin/sh\nprintf fixture-head\n', { mode: 0o755 });
    const result = spawnSync('bash', [join(root, 'scripts/start-dev.sh'), '--daemon', '--memory'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        PATH: `${join(root, 'bin')}:${process.env.PATH}`,
        HOME: root,
        TERM: 'dumb',
        CAT_CAFE_SKIP_NODE_RUNTIME_GUARD: '1',
        CAT_CAFE_DEPLOYMENT_ID: 'runtime',
      },
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /Account preflight inspected/);
    assert.doesNotMatch(result.stdout, /后台模式启动|Daemon PID:|正在关闭服务|再见/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
