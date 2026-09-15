import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const target = 'a'.repeat(40);
// Exported launchers must select the public profile; the home launcher must not.
const launchPrefix = existsSync(join(repoRoot, 'sync-manifest.yaml'))
  ? '--prod-web\n'
  : '--prod-web\n--profile=opensource\n';

test('installers and help consumers advertise the flag-free runtime entry', () => {
  for (const path of [
    'README.md',
    'scripts/setup.sh',
    'scripts/install.sh',
    'scripts/lib/node-runtime-guard.sh',
    'scripts/start-dev.sh',
    'scripts/start-entry.mjs',
  ]) {
    const source = readFileSync(join(repoRoot, path), 'utf8');
    assert.doesNotMatch(source, /pnpm (?:runtime:)?start[^\n]*--expected-target-sha/);
  }
});

function createFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'runtime-start-args-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [
    'scripts/start-entry.mjs',
    'scripts/runtime-worktree.sh',
    'scripts/daemon-state.mjs',
    'scripts/lib/platform-status.mjs',
    'scripts/lib/quickstart-freshness.sh',
    'scripts/lib/node-runtime-guard.sh',
    'scripts/lib/daemon-state.mjs',
    'scripts/lib/process-identity.mjs',
    'scripts/lib/daemon-health-probe.mjs',
    'scripts/lib/daemon-stop-operation.mjs',
    'scripts/lib/daemon-stop-record.mjs',
    'scripts/lib/daemon-stop-claim.mjs',
    'scripts/lib/process-tree.mjs',
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repoRoot, path), join(root, path));
  }
  const { scripts } = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      private: true,
      scripts: {
        start: scripts.start,
        'runtime:start': scripts['runtime:start'],
      },
    }),
  );
  writeFileSync(join(root, '.cat-cafe-runtime-revision'), `${target}\n`);
  mkdirSync(join(root, 'node_modules'), { recursive: true });
  for (const [pkg, dep] of [
    ['web', 'next'],
    ['api', 'tsx'],
    ['mcp-server', 'typescript'],
  ]) {
    const depDir = join(root, 'packages', pkg, 'node_modules', dep);
    mkdirSync(depDir, { recursive: true });
    writeFileSync(join(depDir, 'package.json'), '{}');
  }
  for (const pkg of ['shared', 'api', 'mcp-server', 'web']) {
    const dir = join(root, 'packages', pkg, pkg === 'web' ? '.next' : 'dist');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, pkg === 'web' ? 'BUILD_ID' : 'index.js'), 'fixture\n');
    writeFileSync(join(dir, '.build-commit'), `${target}\n`);
  }
  // The real launch scripts stop here: no daemon, network service, or Redis is started.
  writeFileSync(join(root, 'scripts', 'start-dev.sh'), '#!/bin/bash\nprintf "%s\\n" "$@" > started-args.txt\n', {
    mode: 0o755,
  });
  return root;
}

function runStart(root, script, args) {
  return spawnSync('pnpm', [script, ...args], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
    env: {
      ...process.env,
      CAT_CAFE_SKIP_NODE_RUNTIME_GUARD: '1',
      API_SERVER_PORT: '19876',
      FRONTEND_PORT: '19875',
      PREVIEW_GATEWAY_PORT: '0',
      REDIS_URL: 'redis://localhost:6398',
    },
  });
}

for (const script of ['start', 'runtime:start']) {
  test(`pnpm ${script} derives its archive target with no runtime flags`, (t) => {
    const root = createFixture(t);
    const result = runStart(root, script, []);
    assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(join(root, 'started-args.txt'), 'utf8'), launchPrefix);
  });

  for (const args of [['--daemon'], ['--', '--daemon']]) {
    test(`pnpm ${script} ${args.join(' ')} derives its archive target and forwards daemon arguments`, (t) => {
      const root = createFixture(t);
      const result = runStart(root, script, args);
      assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
      assert.equal(readFileSync(join(root, 'started-args.txt'), 'utf8'), `${launchPrefix}--daemon\n`);
    });
  }

  for (const separator of [[], ['--']]) {
    for (const shaArgs of [['--expected-target-sha', target], [`--expected-target-sha=${target}`]]) {
      test(`pnpm ${script} ${[...separator, ...shaArgs].join(' ')} forwards daemon arguments`, (t) => {
        const root = createFixture(t);
        const result = runStart(root, script, [...separator, ...shaArgs, '--daemon']);
        assert.equal(result.status, 0, `${result.error ?? ''}\n${result.stdout}\n${result.stderr}`);
        assert.equal(readFileSync(join(root, 'started-args.txt'), 'utf8'), `${launchPrefix}--daemon\n`);
      });
    }
  }

  test(`pnpm ${script} preserves a later explicit child-argument separator`, (t) => {
    const root = createFixture(t);
    const result = runStart(root, script, [
      '--',
      '--expected-target-sha',
      target,
      '--',
      '--daemon',
      '--dir',
      'child path',
    ]);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(readFileSync(join(root, 'started-args.txt'), 'utf8'), `${launchPrefix}--daemon\n--dir\nchild path\n`);
  });

  test(`pnpm ${script} rejects malformed or mismatched explicit targets after --`, (t) => {
    for (const shaArgs of [
      ['--expected-target-sha', 'deadbeef'],
      ['--expected-target-sha', 'b'.repeat(40)],
    ]) {
      const root = createFixture(t);
      const result = runStart(root, script, ['--', ...shaArgs, '--daemon']);
      assert.notEqual(result.status, 0);
      const expectedError =
        shaArgs[1]?.length === 40
          ? /bundle revision.*does not equal expected target/
          : /expected-target-sha.*full.*SHA/;
      assert.match(`${result.stdout}\n${result.stderr}`, expectedError);
      assert.equal(existsSync(join(root, 'started-args.txt')), false);
    }
  });
}
