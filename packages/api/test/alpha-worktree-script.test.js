import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const alphaScriptSource = join(__dirname, '..', '..', '..', 'scripts', 'alpha-worktree.sh');
const nodeRuntimeGuardSource = join(__dirname, '..', '..', '..', 'scripts', 'lib', 'node-runtime-guard.sh');
const quickstartFreshnessSource = join(__dirname, '..', '..', '..', 'scripts', 'lib', 'quickstart-freshness.sh');
const alphaRedisIdentitySource = join(__dirname, '..', '..', '..', 'scripts', 'lib', 'alpha-redis-identity.sh');
const tempDirs = [];

process.env.CAT_CAFE_SKIP_NODE_RUNTIME_GUARD = '1';

function createTempProject(name) {
  const projectDir = mkdtempSync(join(tmpdir(), `${name}-`));
  tempDirs.push(projectDir);

  mkdirSync(join(projectDir, 'scripts'), { recursive: true });
  mkdirSync(join(projectDir, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(projectDir, 'packages', 'web'), { recursive: true });
  mkdirSync(join(projectDir, 'packages', 'api'), { recursive: true });
  mkdirSync(join(projectDir, 'packages', 'mcp-server'), { recursive: true });
  mkdirSync(join(projectDir, 'packages', 'shared'), { recursive: true });

  writeFileSync(join(projectDir, 'scripts', 'alpha-worktree.sh'), readFileSync(alphaScriptSource, 'utf8'), {
    mode: 0o755,
  });
  writeFileSync(
    join(projectDir, 'scripts', 'lib', 'node-runtime-guard.sh'),
    readFileSync(nodeRuntimeGuardSource, 'utf8'),
    {
      mode: 0o644,
    },
  );
  writeFileSync(
    join(projectDir, 'scripts', 'lib', 'quickstart-freshness.sh'),
    readFileSync(quickstartFreshnessSource, 'utf8'),
    {
      mode: 0o644,
    },
  );
  writeFileSync(
    join(projectDir, 'scripts', 'lib', 'alpha-redis-identity.sh'),
    readFileSync(alphaRedisIdentitySource, 'utf8'),
    { mode: 0o644 },
  );
  writeFileSync(
    join(projectDir, 'scripts', 'start-dev.sh'),
    '#!/bin/sh\nprintf "ALPHA-STARTED:%s REDIS_PORT=%s REDIS_DATA_DIR=%s REDIS_KEY_PREFIX=%s\\n" "$PWD" "$REDIS_PORT" "$REDIS_DATA_DIR" "$REDIS_KEY_PREFIX"\n',
    {
      mode: 0o755,
    },
  );
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

function runAlpha(projectDir, alphaDir, extraArgs = [], options = {}) {
  const { binDir, logFile } = createPnpmStub(projectDir);
  if (options.redisCliScript) {
    writeFileSync(join(binDir, 'redis-cli'), options.redisCliScript, { mode: 0o755 });
  }
  if (options.lsofScript) {
    writeFileSync(join(binDir, 'lsof'), options.lsofScript, { mode: 0o755 });
  }
  const childEnv = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    ALPHA_TEST_PNPM_LOG: logFile,
    CAT_CAFE_ALPHA_FRONTEND_PORT: '19511',
    CAT_CAFE_ALPHA_API_PORT: '19512',
    CAT_CAFE_ALPHA_PREVIEW_GATEWAY_PORT: '19513',
    CAT_CAFE_ALPHA_REDIS_PORT: '19514',
    ...options.env,
  };
  for (const [key, value] of Object.entries(childEnv)) {
    if (value === undefined) delete childEnv[key];
  }
  const result = spawnSync(
    'bash',
    [
      join(projectDir, 'scripts', 'alpha-worktree.sh'),
      'start',
      '--dir',
      alphaDir,
      '--no-sync',
      '--no-quick',
      ...extraArgs,
    ],
    {
      cwd: projectDir,
      encoding: 'utf8',
      env: childEnv,
    },
  );

  return { ...result, pnpmLog: readFileSync(logFile, 'utf8') };
}

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('alpha-worktree.sh', () => {
  it('pins dedicated Redis coordinates inside the child when launcher env is lost', () => {
    const projectDir = createTempProject('alpha-lost-launcher-env');
    writeFileSync(join(projectDir, '.env'), 'REDIS_KEY_PREFIX=cat-cafe:alpha:f317-upgrade:\n');
    const alphaDir = initProjectWithAlphaWorktree(projectDir);
    const unavailable = '#!/bin/sh\nexit 1\n';

    const result = runAlpha(projectDir, alphaDir, [], {
      redisCliScript: unavailable,
      lsofScript: unavailable,
      env: { HOME: projectDir, CAT_CAFE_ALPHA_REDIS_PORT: undefined, REDIS_KEY_PREFIX: undefined },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /REDIS_PORT=6397/);
    assert.match(result.stdout, new RegExp(`REDIS_DATA_DIR=${alphaDir}/.cat-cafe/redis`));
    assert.match(result.stdout, /REDIS_KEY_PREFIX=cat-cafe:\s*$/m);
  });

  it('auto-installs when node_modules exists but dependency markers are incomplete', () => {
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

  it('fails with guidance when dependency markers are incomplete and auto-install is disabled', () => {
    const projectDir = createTempProject('alpha-self-heal-no-install');
    const alphaDir = initProjectWithAlphaWorktree(projectDir);
    seedPartialAlphaInstall(alphaDir);

    const result = runAlpha(projectDir, alphaDir, ['--no-install']);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /alpha prerequisites missing/);
    assert.match(result.stderr, /install --frozen-lockfile/);
    assert.doesNotMatch(result.stdout, /ALPHA-STARTED:/);
  });

  it('refuses a live Redis endpoint whose data directory belongs to another stack', () => {
    const projectDir = createTempProject('alpha-foreign-redis');
    const alphaDir = initProjectWithAlphaWorktree(projectDir);
    const foreignDir = join(projectDir, 'foreign-redis');
    mkdirSync(foreignDir);
    const redisCliScript = `#!/bin/sh
case "$*" in
  *" ping") printf 'PONG\\n' ;;
  *" config get dir") printf 'dir\\n${foreignDir}\\n' ;;
  *) exit 1 ;;
esac
`;

    const result = runAlpha(projectDir, alphaDir, [], { redisCliScript });

    assert.notEqual(result.status, 0, 'foreign Redis must block Alpha before start-dev');
    assert.match(result.stderr, /Redis data directory mismatch/);
    assert.doesNotMatch(result.stdout, /ALPHA-STARTED:/);
    assert.equal(
      existsSync(join(alphaDir, '.cat-cafe', 'redis')),
      false,
      'failed preflight must not seed an empty target',
    );
  });

  it('requires an explicit decision before replacing legacy Alpha data with an empty instance', () => {
    const projectDir = createTempProject('alpha-migration-required');
    writeFileSync(join(projectDir, '.env'), 'ALPHA_EMPTY_REDIS_ALLOWED=true\nALPHA_REDIS_PORT=19514\n');
    const alphaDir = initProjectWithAlphaWorktree(projectDir);
    const redisCliScript = `#!/bin/sh
case "$*" in
  *"-p 6397 ping") exit 1 ;;
  *"-p 6398 ping") printf 'PONG\\n' ;;
  *"-p 6398 dbsize") printf '8215\\n' ;;
  *) exit 1 ;;
esac
`;
    const options = {
      redisCliScript,
      lsofScript: '#!/bin/sh\nexit 1\n',
      env: { CAT_CAFE_ALPHA_REDIS_PORT: undefined },
    };

    const blocked = runAlpha(projectDir, alphaDir, [], options);
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /Alpha Redis migration required/);
    assert.equal(existsSync(join(alphaDir, '.cat-cafe', 'redis')), false);

    const explicitEmpty = runAlpha(projectDir, alphaDir, ['--allow-empty-redis'], options);
    assert.equal(explicitEmpty.status, 0, explicitEmpty.stderr);
    assert.match(explicitEmpty.stdout, /REDIS_PORT=6397/);
  });

  it('refuses the legacy shared worktree Redis port even when it is idle', () => {
    const projectDir = createTempProject('alpha-shared-redis-port');
    const alphaDir = initProjectWithAlphaWorktree(projectDir);

    const result = runAlpha(projectDir, alphaDir, [], { env: { CAT_CAFE_ALPHA_REDIS_PORT: '6398' } });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /shared Redis port 6398/);
    assert.doesNotMatch(result.stdout, /ALPHA-STARTED:/);
  });
});
