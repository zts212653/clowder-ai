import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function createGitStub(logPath) {
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
  process.stdout.write(${JSON.stringify(`worktree ${repoRoot}\n`)});
  process.exit(0);
}

if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') {
  process.stdout.write(${JSON.stringify(`${repoRoot}\n`)});
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

const command = args[0] === '-r' ? args.slice(0, 4).join(' ') : args[0];
const knownCommands = new Set(['install', 'build', 'test', 'lint', 'check', '-r --if-present run build', '-r exec bash -lc']);
if (!knownCommands.has(command)) {
  process.stderr.write(\`unexpected pnpm invocation: \${args.join(' ')}\\n\`);
  process.exit(1);
}

process.exit(0);
`;
}

function runGate(bash, args = [], extraEnv = {}) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'pre-merge-check-test-'));
  const binDir = path.join(tempDir, 'bin');
  const logPath = path.join(tempDir, 'commands.log');

  try {
    writeFileSync(logPath, '', 'utf8');
    mkdirSync(binDir, { recursive: true });
    writeExecutable(path.join(binDir, 'git'), createGitStub(logPath));
    writeExecutable(path.join(binDir, 'pnpm'), createPnpmStub(logPath));

    const result = spawnSync(bash, [scriptPath, ...args], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...extraEnv,
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
    const buildIndex = result.logLines.indexOf('pnpm -r --if-present run build');

    assert.notEqual(rebaseIndex, -1, 'expected rebase to run');
    assert.notEqual(installIndex, -1, 'expected pnpm install to run');
    assert.notEqual(buildIndex, -1, 'expected pnpm build to run');
    assert.ok(rebaseIndex < installIndex, `expected install after rebase, got:\n${result.logLines.join('\n')}`);
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
});
