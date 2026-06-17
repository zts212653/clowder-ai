import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { requireBash } from './test-bash-runtime.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'pre-merge-check.sh');

function writeExecutable(filePath, source) {
  writeFileSync(filePath, source, 'utf8');
  chmodSync(filePath, 0o755);
}

function createGitStub(logPath, stubRoot = repoRoot) {
  return `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, \`git \${args.join(' ')}\\n\`);

if (args[0] === 'branch' && args[1] === '--show-current') {
  process.stdout.write('fix/test\\n');
  process.exit(0);
}

if (args[0] === 'status' && args[1] === '--porcelain') {
  process.exit(0);
}

if (args[0] === 'fetch' && args[1] === 'origin' && args[2] === 'main') {
  process.exit(0);
}

if (args[0] === 'rebase' && args[1] === 'origin/main') {
  process.exit(0);
}

if (args[0] === 'rev-parse' && args[1] === '--short' && args[2] === 'HEAD') {
  process.stdout.write('abc1234\\n');
  process.exit(0);
}

if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
  process.stdout.write('abc1234def5678\\n');
  process.exit(0);
}

if (args[0] === 'worktree' && args[1] === 'list' && args[2] === '--porcelain') {
  process.stdout.write(${JSON.stringify(`worktree ${stubRoot}\n`)});
  process.exit(0);
}

if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
  process.stdout.write(${JSON.stringify(`${stubRoot}\n`)});
  process.exit(0);
}

process.stderr.write(\`unexpected git invocation: \${args.join(' ')}\\n\`);
process.exit(1);
`;
}

function createPnpmStub(logPath) {
  return `#!/usr/bin/env node
const { appendFileSync } = require('node:fs');
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, \`pnpm \${args.join(' ')}\\n\`);
if (args[0] === 'install') {
  appendFileSync(
    ${JSON.stringify(logPath)},
    \`env NODE_ENV=\${process.env.NODE_ENV ?? '<unset>'} npm_config_production=\${process.env.npm_config_production ?? '<unset>'} NPM_CONFIG_PRODUCTION=\${process.env.NPM_CONFIG_PRODUCTION ?? '<unset>'}\\n\`,
  );
}

const command =
  args[0] === '-r'
    ? args.slice(0, 4).join(' ')
    : args[0] === '--filter'
      ? args.slice(0, 3).join(' ')
      : args[0] === 'run'
        ? args.slice(0, 2).join(' ')
        : args[0];
const knownCommands = new Set([
  'install',
  'run check:biome-version',
  'build',
  'test',
  'check',
  '-r --if-present run build',
  '-r exec bash -lc',
  '--filter @cat-cafe/web lint',
  '--filter @cat-cafe/api run',
]);
if (!knownCommands.has(command)) {
  process.stderr.write(\`unexpected pnpm invocation: \${args.join(' ')}\\n\`);
  process.exit(1);
}

process.exit(0);
`;
}

function createPublicSyncFixture(baseDir) {
  const fakeRoot = path.join(baseDir, 'fake-repo');
  mkdirSync(path.join(fakeRoot, 'packages', 'api'), { recursive: true });
  // Symlink scripts/ so gate guard and other script references work
  symlinkSync(path.join(repoRoot, 'scripts'), path.join(fakeRoot, 'scripts'));
  // Minimal package.json with test:public script — simulates public sync target
  writeFileSync(
    path.join(fakeRoot, 'packages', 'api', 'package.json'),
    JSON.stringify({ scripts: { 'test:public': 'echo ok' } }),
    'utf8',
  );
  // NO .claude/settings.json — that's the sentinel resolve_test_mode checks
  return fakeRoot;
}

function runGate(bash, args = [], extraEnv = {}, options = {}) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'pre-merge-check-test-'));
  const binDir = path.join(tempDir, 'bin');
  const logPath = path.join(tempDir, 'commands.log');

  const effectiveRoot = options.publicSyncFixture ? createPublicSyncFixture(tempDir) : repoRoot;

  try {
    writeFileSync(logPath, '', 'utf8');
    mkdirSync(binDir, { recursive: true });
    writeExecutable(path.join(binDir, 'git'), createGitStub(logPath, effectiveRoot));
    writeExecutable(path.join(binDir, 'pnpm'), createPnpmStub(logPath));

    const result = spawnSync(bash, [scriptPath, ...args], {
      cwd: effectiveRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...extraEnv,
        CAT_CAFE_GATE_GUARD_SKIP_PRESSURE: '1',
        CAT_CAFE_GATE_LOCK_DIR: path.join(tempDir, 'pre-merge-check.lock'),
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    });

    const logLines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
    return { ...result, logLines };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('pre-merge-check dependency refresh order', () => {
  it('runs pnpm install after rebasing onto origin/main', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash);

    assert.equal(result.status, 0, result.stderr);
    const rebaseIndex = result.logLines.findIndex((line) => line.startsWith('git rebase origin/main'));
    const installIndex = result.logLines.indexOf('pnpm install --frozen-lockfile');
    const biomeVersionIndex = result.logLines.indexOf('pnpm run check:biome-version');
    const buildIndex = result.logLines.indexOf('pnpm -r --if-present run build');

    assert.notEqual(rebaseIndex, -1, 'expected rebase to run');
    assert.notEqual(installIndex, -1, 'expected pnpm install to run');
    assert.notEqual(biomeVersionIndex, -1, 'expected biome version guard to run');
    assert.notEqual(buildIndex, -1, 'expected pnpm build to run');
    assert.ok(rebaseIndex < installIndex, `expected install after rebase, got:\n${result.logLines.join('\n')}`);
    assert.ok(
      installIndex < biomeVersionIndex,
      `expected biome version guard after install, got:\n${result.logLines.join('\n')}`,
    );
    assert.ok(
      biomeVersionIndex < buildIndex,
      `expected build after biome version guard, got:\n${result.logLines.join('\n')}`,
    );
    assert.ok(installIndex < buildIndex, `expected build after install, got:\n${result.logLines.join('\n')}`);
  });

  it('clears inherited production install env before pnpm install', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash, [], {
      NODE_ENV: 'production',
      npm_config_production: 'true',
      NPM_CONFIG_PRODUCTION: 'true',
    });

    assert.equal(result.status, 0, result.stderr);
    const envLine = result.logLines.find((line) => line.startsWith('env NODE_ENV='));

    assert.ok(envLine, `expected install env line, got:\n${result.logLines.join('\n')}`);
    assert.equal(
      envLine,
      'env NODE_ENV=<unset> npm_config_production=<unset> NPM_CONFIG_PRODUCTION=<unset>',
      `expected gate to clear inherited production install env, got:\n${result.logLines.join('\n')}`,
    );
  });

  it('uses public API tests when source-only Claude settings are absent', (t) => {
    const bash = requireBash(t);
    // Use a fake repo root without .claude/settings.json to simulate public sync target.
    // Without this fixture, source checkouts have the sentinel → resolve_test_mode picks "full".
    const result = runGate(bash, [], {}, { publicSyncFixture: true });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(
      result.logLines.includes('pnpm --filter @cat-cafe/api run test:public'),
      `expected public test suite in public sync target, got:\n${result.logLines.join('\n')}`,
    );
    assert.ok(
      !result.logLines.includes('pnpm test'),
      `public sync target must not run source-only full tests, got:\n${result.logLines.join('\n')}`,
    );
  });

  it('allows full test mode to be forced explicitly', (t) => {
    const bash = requireBash(t);
    const result = runGate(bash, [], { CAT_CAFE_GATE_TEST_MODE: 'full' });

    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.logLines.includes('pnpm test'), `expected full test suite, got:\n${result.logLines.join('\n')}`);
    assert.ok(
      !result.logLines.includes('pnpm --filter @cat-cafe/api run test:public'),
      `full mode must not run public test suite, got:\n${result.logLines.join('\n')}`,
    );
  });
});
