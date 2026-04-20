import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const alphaScriptSource = join(__dirname, '..', '..', '..', 'scripts', 'alpha-worktree.sh');
const tempDirs = [];

function createTempProject(name) {
  const projectDir = mkdtempSync(join(tmpdir(), `${name}-`));
  tempDirs.push(projectDir);

  mkdirSync(join(projectDir, 'scripts'), { recursive: true });
  mkdirSync(join(projectDir, 'packages', 'web'), { recursive: true });
  mkdirSync(join(projectDir, 'packages', 'api'), { recursive: true });
  mkdirSync(join(projectDir, 'packages', 'mcp-server'), { recursive: true });
  mkdirSync(join(projectDir, 'packages', 'shared'), { recursive: true });

  writeFileSync(join(projectDir, 'scripts', 'alpha-worktree.sh'), readFileSync(alphaScriptSource, 'utf8'), {
    mode: 0o755,
  });
  writeFileSync(join(projectDir, 'scripts', 'start-dev.sh'), '#!/bin/sh\nprintf "ALPHA-STARTED:%s\\n" "$PWD"\n', {
    mode: 0o755,
  });
  writeFileSync(join(projectDir, 'packages', 'web', 'package.json'), '{}\n', 'utf8');
  writeFileSync(join(projectDir, 'packages', 'api', 'package.json'), '{}\n', 'utf8');
  writeFileSync(join(projectDir, 'packages', 'mcp-server', 'package.json'), '{}\n', 'utf8');
  writeFileSync(join(projectDir, 'packages', 'shared', 'package.json'), '{}\n', 'utf8');

  return projectDir;
}

function createPnpmStub(projectDir) {
  const binDir = join(projectDir, 'bin');
  const logFile = join(projectDir, 'pnpm.log');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(logFile, '', 'utf8');
  writeFileSync(
    join(binDir, 'pnpm'),
    `#!/bin/bash
set -euo pipefail
log_file="\${ALPHA_TEST_PNPM_LOG:?}"
printf '%s\\n' "$*" >> "$log_file"
target_dir="$PWD"
if [ "\${1:-}" = "-C" ]; then
  target_dir="$2"
  shift 2
fi
if [ "\${1:-}" = "install" ] && [ "\${2:-}" = "--frozen-lockfile" ]; then
  mkdir -p "$target_dir/node_modules/.pnpm"
  mkdir -p "$target_dir/packages/web/node_modules/next"
  : > "$target_dir/packages/web/node_modules/next/package.json"
  mkdir -p "$target_dir/packages/api/node_modules/tsx"
  : > "$target_dir/packages/api/node_modules/tsx/package.json"
  mkdir -p "$target_dir/packages/mcp-server/node_modules/typescript"
  : > "$target_dir/packages/mcp-server/node_modules/typescript/package.json"
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  );

  return { binDir, logFile };
}

function seedPartialAlphaInstall(alphaDir) {
  mkdirSync(join(alphaDir, 'node_modules', '.pnpm'), { recursive: true });
}

function initProjectWithAlphaWorktree(projectDir) {
  const remoteDir = mkdtempSync(join(tmpdir(), 'alpha-worktree-remote-'));
  const alphaSandboxDir = mkdtempSync(join(tmpdir(), 'alpha-worktree-sandbox-'));
  const alphaDir = join(alphaSandboxDir, 'alpha');
  tempDirs.push(remoteDir, alphaSandboxDir);

  execFileSync('git', ['init', '-b', 'main'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir, stdio: 'ignore' });

  execFileSync('git', ['init', '--bare', remoteDir], { stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['fetch', 'origin', 'main'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['worktree', 'add', alphaDir, '-b', 'alpha/main-sync', 'origin/main'], {
    cwd: projectDir,
    stdio: 'ignore',
  });

  return realpathSync(alphaDir);
}

function initProjectWithLegacyAlphaWorktree(projectDir) {
  const remoteDir = mkdtempSync(join(tmpdir(), 'alpha-legacy-remote-'));
  const legacySandboxDir = mkdtempSync(join(tmpdir(), 'alpha-legacy-sandbox-'));
  const legacyDir = join(legacySandboxDir, 'legacy-alpha');
  tempDirs.push(remoteDir, legacySandboxDir);

  execFileSync('git', ['init', '-b', 'main'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir, stdio: 'ignore' });

  execFileSync('git', ['init', '--bare', remoteDir], { stdio: 'ignore' });
  execFileSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['fetch', 'origin', 'main'], { cwd: projectDir, stdio: 'ignore' });
  execFileSync('git', ['worktree', 'add', legacyDir, '-b', 'main-test/main-sync', 'origin/main'], {
    cwd: projectDir,
    stdio: 'ignore',
  });

  return realpathSync(legacyDir);
}

function runAlphaCommand(projectDir, command, alphaDir, extraArgs = [], extraEnv = {}) {
  const { binDir, logFile } = createPnpmStub(projectDir);
  const result = spawnSync(
    'bash',
    [join(projectDir, 'scripts', 'alpha-worktree.sh'), command, '--dir', alphaDir, ...extraArgs],
    {
      cwd: projectDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        ALPHA_TEST_PNPM_LOG: logFile,
        CAT_CAFE_ALPHA_WEB_PORT: '19511',
        CAT_CAFE_ALPHA_API_PORT: '19512',
        CAT_CAFE_ALPHA_GATEWAY_PORT: '19513',
        CAT_CAFE_ALPHA_REDIS_PORT: '19514',
        ...extraEnv,
      },
    },
  );

  return { ...result, pnpmLog: readFileSync(logFile, 'utf8') };
}

function runAlpha(projectDir, alphaDir, extraArgs = []) {
  return runAlphaCommand(projectDir, 'start', alphaDir, ['--no-sync', ...extraArgs]);
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('alpha-worktree.sh', () => {
  it('auto-installs when node_modules exists but dependency markers are incomplete', (t) => {
    if (process.platform === 'win32') t.skip('requires bash');

    const projectDir = createTempProject('alpha-self-heal-install');
    const alphaDir = initProjectWithAlphaWorktree(projectDir);
    seedPartialAlphaInstall(alphaDir);

    const result = runAlpha(projectDir, alphaDir);

    assert.equal(result.status, 0, `exit=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /detected missing alpha prerequisites/);
    assert.match(result.stdout, /installing dependencies in alpha worktree/);
    assert.match(result.stdout, /ALPHA-STARTED:/);
    assert.match(result.pnpmLog, /install --frozen-lockfile/);
  });

  it('fails with guidance when dependency markers are incomplete and auto-install is disabled', (t) => {
    if (process.platform === 'win32') t.skip('requires bash');

    const projectDir = createTempProject('alpha-self-heal-no-install');
    const alphaDir = initProjectWithAlphaWorktree(projectDir);
    seedPartialAlphaInstall(alphaDir);

    const result = runAlpha(projectDir, alphaDir, ['--no-install']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /alpha prerequisites missing/);
    assert.match(result.stderr, /install --frozen-lockfile/);
    assert.doesNotMatch(result.stdout, /ALPHA-STARTED:/);
  });

  it('migrates the legacy alpha worktree even when the target dir already exists empty', (t) => {
    if (process.platform === 'win32') t.skip('requires bash');

    const projectDir = createTempProject('alpha-legacy-migration');
    const legacyDir = initProjectWithLegacyAlphaWorktree(projectDir);
    const alphaSandboxDir = mkdtempSync(join(tmpdir(), 'alpha-target-dir-'));
    const alphaDir = join(alphaSandboxDir, 'alpha');
    const resolvedLegacyDir = realpathSync(legacyDir);
    tempDirs.push(alphaSandboxDir);
    mkdirSync(alphaDir, { recursive: true });

    const result = runAlphaCommand(projectDir, 'init', alphaDir, [], {
      CAT_CAFE_ALPHA_LEGACY_DIR: legacyDir,
    });

    const worktreeList = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: projectDir,
      encoding: 'utf8',
    });
    const resolvedAlphaDir = realpathSync(alphaDir);

    assert.equal(result.status, 0, `exit=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /migrating legacy alpha worktree/);
    assert.match(result.stdout, /legacy alpha worktree migrated/);
    assert.match(worktreeList, new RegExp(`worktree ${resolvedAlphaDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.doesNotMatch(
      worktreeList,
      new RegExp(`worktree ${resolvedLegacyDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
    assert.equal(
      execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: alphaDir, encoding: 'utf8' }).trim(),
      'alpha/main-sync',
    );
  });
});
