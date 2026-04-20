import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimeScriptSource = join(__dirname, '..', '..', '..', 'scripts', 'runtime-worktree.sh');
const tempDirs = [];
const tempProcs = [];

function createTempProject(name) {
  const projectDir = mkdtempSync(join(tmpdir(), `${name}-`));
  tempDirs.push(projectDir);
  mkdirSync(join(projectDir, 'scripts'), { recursive: true });
  mkdirSync(join(projectDir, 'packages', 'web'), { recursive: true });
  mkdirSync(join(projectDir, 'packages', 'api'), { recursive: true });
  mkdirSync(join(projectDir, 'packages', 'mcp-server'), { recursive: true });
  mkdirSync(join(projectDir, 'packages', 'shared'), { recursive: true });
  writeFileSync(join(projectDir, 'scripts', 'runtime-worktree.sh'), readFileSync(runtimeScriptSource, 'utf8'), {
    mode: 0o755,
  });
  writeFileSync(join(projectDir, 'scripts', 'start-dev.sh'), '#!/bin/sh\nprintf "STARTED:%s\\n" "$PWD"\n', {
    mode: 0o755,
  });
  return projectDir;
}

function createPnpmStub(projectDir) {
  const binDir = join(projectDir, 'bin');
  const logFile = join(projectDir, 'pnpm.log');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, 'pnpm'),
    `#!/bin/bash
set -euo pipefail
log_file="\${RUNTIME_TEST_PNPM_LOG:?}"
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
if [ "\${1:-}" = "run" ] && [ "\${2:-}" = "build" ]; then
  case "$target_dir" in
    */packages/shared)
      mkdir -p "$target_dir/dist"
      : > "$target_dir/dist/index.js"
      ;;
    */packages/mcp-server)
      mkdir -p "$target_dir/dist"
      : > "$target_dir/dist/index.js"
      ;;
    */packages/web)
      mkdir -p "$target_dir/.next"
      printf 'stub-build-id\\n' > "$target_dir/.next/BUILD_ID"
      ;;
  esac
  exit 0
fi
exit 0
`,
    { mode: 0o755 },
  );
  return { binDir, logFile };
}

function withStubbedPnpmEnv(projectDir) {
  const { binDir, logFile } = createPnpmStub(projectDir);
  return {
    ...process.env,
    CAT_CAFE_RUNTIME_RESTART_OK: '1',
    PATH: `${binDir}:${process.env.PATH}`,
    RUNTIME_TEST_PNPM_LOG: logFile,
  };
}

function seedRuntimeDependencyMarkers(projectDir) {
  mkdirSync(join(projectDir, 'node_modules', '.pnpm'), { recursive: true });
  mkdirSync(join(projectDir, 'packages', 'web', 'node_modules', 'next'), { recursive: true });
  writeFileSync(join(projectDir, 'packages', 'web', 'node_modules', 'next', 'package.json'), '{}');
  mkdirSync(join(projectDir, 'packages', 'api', 'node_modules', 'tsx'), { recursive: true });
  writeFileSync(join(projectDir, 'packages', 'api', 'node_modules', 'tsx', 'package.json'), '{}');
  mkdirSync(join(projectDir, 'packages', 'mcp-server', 'node_modules', 'typescript'), { recursive: true });
  writeFileSync(join(projectDir, 'packages', 'mcp-server', 'node_modules', 'typescript', 'package.json'), '{}');
}

async function waitForLocalPort(port, attempts = 20) {
  for (let i = 0; i < attempts; i += 1) {
    const connected = await new Promise((resolve) => {
      const socket = createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for localhost:${port}`);
}

afterEach(async () => {
  while (tempProcs.length > 0) {
    const proc = tempProcs.pop();
    proc.kill('SIGKILL');
  }
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop(), { recursive: true, force: true });
  }
});

describe('runtime-worktree.sh', () => {
  it('keeps the runtime-worktree entrypoint executable in the repository', () => {
    const mode = statSync(runtimeScriptSource).mode & 0o111;
    assert.notEqual(mode, 0, 'runtime-worktree.sh should retain an executable bit');
  });

  it('starts in-place when project is not a git repository', () => {
    const projectDir = createTempProject('runtime-non-git');
    seedRuntimeDependencyMarkers(projectDir);

    const result = spawnSync('bash', [join(projectDir, 'scripts', 'runtime-worktree.sh'), 'start', '--no-sync'], {
      cwd: projectDir,
      encoding: 'utf8',
      env: { ...process.env, CAT_CAFE_RUNTIME_RESTART_OK: '1' },
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /running in-place \(deployment mode\)/);
    assert.match(result.stdout, new RegExp(`STARTED:${projectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('ignores sibling runtime .env when starting in-place outside git', async () => {
    const projectDir = createTempProject('runtime-non-git-sibling-runtime');
    seedRuntimeDependencyMarkers(projectDir);

    const siblingRuntimeDir = join(projectDir, '..', 'cat-cafe-runtime');
    mkdirSync(siblingRuntimeDir, { recursive: true });
    writeFileSync(join(siblingRuntimeDir, '.env'), 'API_SERVER_PORT=3010\n');

    const server = spawn(
      process.execPath,
      [
        '-e',
        `const net=require('node:net');
const server=net.createServer((socket)=>{socket.on('error',()=>{}); socket.end();});
server.listen(3010,'127.0.0.1',()=>setInterval(()=>{},1000));`,
      ],
      { stdio: 'ignore' },
    );
    tempProcs.push(server);
    await waitForLocalPort(3010);

    const result = spawnSync('bash', [join(projectDir, 'scripts', 'runtime-worktree.sh'), 'start', '--no-sync'], {
      cwd: projectDir,
      encoding: 'utf8',
      env: { ...process.env, CAT_CAFE_RUNTIME_RESTART_OK: '1' },
    });

    assert.equal(result.status, 0, `exit=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /running in-place \(deployment mode\)/);
    assert.match(result.stdout, new RegExp(`STARTED:${projectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.doesNotMatch(result.stderr, /API port appears active/);
  });

  it('seeds missing runtime auth config from the launcher project during init', () => {
    const projectDir = createTempProject('runtime-auth-config-seed');
    const runtimeDir = mkdtempSync(join(tmpdir(), 'runtime-auth-config-worktree-'));
    const remoteDir = mkdtempSync(join(tmpdir(), 'runtime-auth-config-remote-'));
    tempDirs.push(runtimeDir, remoteDir);

    execFileSync('git', ['init', '-b', 'main'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['add', 'scripts', 'packages'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['init', '--bare', remoteDir], { stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: projectDir, stdio: 'ignore' });

    mkdirSync(join(projectDir, '.cat-cafe'), { recursive: true });
    writeFileSync(
      join(projectDir, '.cat-cafe', 'accounts.json'),
      `${JSON.stringify({ codex: { authType: 'oauth', models: ['gpt-5.4'] } }, null, 2)}\n`,
      'utf8',
    );
    writeFileSync(
      join(projectDir, '.cat-cafe', 'credentials.json'),
      `${JSON.stringify({ 'installer-openai': { apiKey: 'sk-runtime' } }, null, 2)}\n`,
      'utf8',
    );

    const result = spawnSync(
      'bash',
      [join(projectDir, 'scripts', 'runtime-worktree.sh'), 'init', '--dir', runtimeDir, '--no-install'],
      {
        cwd: projectDir,
        encoding: 'utf8',
      },
    );

    assert.equal(result.status, 0, `exit=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const normalizedRuntimeDir = realpathSync(runtimeDir);
    assert.deepEqual(JSON.parse(readFileSync(join(normalizedRuntimeDir, '.cat-cafe', 'accounts.json'), 'utf8')), {
      codex: { authType: 'oauth', models: ['gpt-5.4'] },
    });
    assert.deepEqual(JSON.parse(readFileSync(join(normalizedRuntimeDir, '.cat-cafe', 'credentials.json'), 'utf8')), {
      'installer-openai': { apiKey: 'sk-runtime' },
    });
  });

  it('fails fast when project is a git repo but the configured remote is missing', () => {
    const projectDir = createTempProject('runtime-missing-remote');
    execFileSync('git', ['init', '-b', 'main'], { cwd: projectDir, stdio: 'ignore' });

    const result = spawnSync('bash', [join(projectDir, 'scripts', 'runtime-worktree.sh'), 'start', '--no-sync'], {
      cwd: projectDir,
      encoding: 'utf8',
      env: { ...process.env, CAT_CAFE_RUNTIME_RESTART_OK: '1' },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /remote 'origin' not found/);
    assert.doesNotMatch(result.stdout, /running in-place \(deployment mode\)/);
  });

  it('auto-installs missing runtime dependencies before in-place start', () => {
    const projectDir = createTempProject('runtime-self-heal-install');
    const env = withStubbedPnpmEnv(projectDir);

    const result = spawnSync('bash', [join(projectDir, 'scripts', 'runtime-worktree.sh'), 'start', '--no-sync'], {
      cwd: projectDir,
      encoding: 'utf8',
      env,
    });

    assert.equal(result.status, 0);
    assert.match(result.stdout, /detected missing runtime prerequisites/);
    assert.match(result.stdout, /running pnpm install --frozen-lockfile/);
    assert.match(result.stdout, /STARTED:/);
    const pnpmLog = readFileSync(env.RUNTIME_TEST_PNPM_LOG, 'utf8');
    assert.match(pnpmLog, /install --frozen-lockfile/);
  });

  it('fails with guidance when auto-install is disabled and prerequisites are missing', () => {
    const projectDir = createTempProject('runtime-self-heal-no-install');
    const env = withStubbedPnpmEnv(projectDir);

    const result = spawnSync(
      'bash',
      [join(projectDir, 'scripts', 'runtime-worktree.sh'), 'start', '--no-sync', '--no-install'],
      {
        cwd: projectDir,
        encoding: 'utf8',
        env,
      },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /runtime prerequisites missing/);
    assert.match(result.stderr, /pnpm -C .* install --frozen-lockfile/);
    assert.doesNotMatch(result.stdout, /STARTED:/);
  });

  it('rebuilds missing quick-start artifacts before start', () => {
    const projectDir = createTempProject('runtime-self-heal-quick-build');
    const env = withStubbedPnpmEnv(projectDir);
    seedRuntimeDependencyMarkers(projectDir);

    const result = spawnSync(
      'bash',
      [join(projectDir, 'scripts', 'runtime-worktree.sh'), 'start', '--no-sync', '--', '--quick'],
      {
        cwd: projectDir,
        encoding: 'utf8',
        env,
      },
    );

    assert.equal(result.status, 0);
    assert.match(result.stdout, /quick start missing shared dist/);
    assert.match(result.stdout, /quick start missing MCP server dist/);
    assert.match(result.stdout, /quick start missing web production build/);
    assert.match(result.stdout, /STARTED:/);

    const pnpmLog = readFileSync(env.RUNTIME_TEST_PNPM_LOG, 'utf8');
    assert.match(pnpmLog, /-C .*packages\/shared run build/);
    assert.match(pnpmLog, /-C .*packages\/mcp-server run build/);
    assert.match(pnpmLog, /-C .*packages\/web run build/);
  });

  it('starts in-place when .git is a dangling pointer file', () => {
    const projectDir = createTempProject('runtime-dangling-git');
    seedRuntimeDependencyMarkers(projectDir);
    writeFileSync(join(projectDir, '.git'), 'gitdir: /tmp/does-not-exist-anymore\n', 'utf8');

    const result = spawnSync('bash', [join(projectDir, 'scripts', 'runtime-worktree.sh'), 'start', '--no-sync'], {
      cwd: projectDir,
      encoding: 'utf8',
      env: { ...process.env, CAT_CAFE_RUNTIME_RESTART_OK: '1' },
    });

    assert.equal(result.status, 0, `exit=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /running in-place \(deployment mode\)/);
    assert.match(result.stdout, new RegExp(`STARTED:${projectDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('refuses restart when nc fallback sees an active API port and lsof-style probes fail', async () => {
    const projectDir = createTempProject('runtime-port-fallback');
    seedRuntimeDependencyMarkers(projectDir);
    const { binDir, logFile } = createPnpmStub(projectDir);
    writeFileSync(join(binDir, 'lsof'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    writeFileSync(join(binDir, 'ss'), '#!/bin/sh\nexit 127\n', { mode: 0o755 });

    const server = spawn(
      process.execPath,
      [
        '-e',
        `const net=require('node:net');
const server=net.createServer((socket)=>{socket.on('error',()=>{}); socket.end();});
server.listen(3002,'127.0.0.1',()=>setInterval(()=>{},1000));`,
      ],
      { stdio: 'ignore' },
    );
    tempProcs.push(server);
    await waitForLocalPort(3002);

    const result = spawnSync('bash', [join(projectDir, 'scripts', 'runtime-worktree.sh'), 'start', '--no-sync'], {
      cwd: projectDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        API_SERVER_PORT: '3002',
        PATH: `${binDir}:${process.env.PATH}`,
        RUNTIME_TEST_PNPM_LOG: logFile,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /API port appears active/);
    assert.doesNotMatch(result.stdout, /STARTED:/);
  });

  it('reads API_SERVER_PORT from runtime .env before allowing restart', async () => {
    const projectDir = createTempProject('runtime-port-from-env-file');
    seedRuntimeDependencyMarkers(projectDir);
    writeFileSync(join(projectDir, '.env'), 'API_SERVER_PORT=3010\n');

    const server = spawn(
      process.execPath,
      [
        '-e',
        `const net=require('node:net');
const server=net.createServer((socket)=>{socket.on('error',()=>{}); socket.end();});
server.listen(3010,'127.0.0.1',()=>setInterval(()=>{},1000));`,
      ],
      { stdio: 'ignore' },
    );
    tempProcs.push(server);
    await waitForLocalPort(3010);

    const result = spawnSync('bash', [join(projectDir, 'scripts', 'runtime-worktree.sh'), 'start', '--no-sync'], {
      cwd: projectDir,
      encoding: 'utf8',
      env: {
        ...process.env,
        CAT_CAFE_RUNTIME_DIR: projectDir,
      },
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /API port appears active/);
    assert.doesNotMatch(result.stdout, /STARTED:/);
  });

  it('auto-stashes isolated pnpm lock drift before sync during start', () => {
    const projectDir = createTempProject('runtime-lock-drift-start');
    const runtimeDir = mkdtempSync(join(tmpdir(), 'runtime-lock-drift-worktree-'));
    const remoteDir = mkdtempSync(join(tmpdir(), 'runtime-lock-drift-remote-'));
    tempDirs.push(runtimeDir, remoteDir);

    writeFileSync(join(projectDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
    execFileSync('git', ['init', '-b', 'main'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir, stdio: 'ignore' });

    execFileSync('git', ['init', '--bare', remoteDir], { stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['fetch', 'origin', 'main'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['worktree', 'add', runtimeDir, '-b', 'runtime/main-sync', 'origin/main'], {
      cwd: projectDir,
      stdio: 'ignore',
    });
    const normalizedRuntimeDir = realpathSync(runtimeDir);

    writeFileSync(join(normalizedRuntimeDir, 'pnpm-lock.yaml'), 'lockfileVersion: 8\n', 'utf8');
    const env = withStubbedPnpmEnv(normalizedRuntimeDir);

    const result = spawnSync('bash', [join(projectDir, 'scripts', 'runtime-worktree.sh'), 'start', '--daemon'], {
      cwd: projectDir,
      encoding: 'utf8',
      env: {
        ...env,
        CAT_CAFE_RUNTIME_RESTART_OK: '1',
        CAT_CAFE_RUNTIME_DIR: normalizedRuntimeDir,
        API_SERVER_PORT: '19899',
      },
    });

    assert.equal(result.status, 0, `exit=${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /lock drift detected/i);
    assert.match(result.stdout, /STARTED:/);
    const dirty = execFileSync('git', ['diff', '--name-only'], { cwd: normalizedRuntimeDir, encoding: 'utf8' }).trim();
    assert.equal(dirty, '');
  });

  it('rejects staged dirty files even when unstaged lock drift is present', () => {
    const projectDir = createTempProject('runtime-staged-plus-lock');
    const runtimeDir = mkdtempSync(join(tmpdir(), 'runtime-staged-lock-worktree-'));
    const remoteDir = mkdtempSync(join(tmpdir(), 'runtime-staged-lock-remote-'));
    tempDirs.push(runtimeDir, remoteDir);

    writeFileSync(join(projectDir, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n', 'utf8');
    writeFileSync(join(projectDir, 'src.js'), 'original\n', 'utf8');
    execFileSync('git', ['init', '-b', 'main'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: projectDir, stdio: 'ignore' });

    execFileSync('git', ['init', '--bare', remoteDir], { stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', remoteDir], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['fetch', 'origin', 'main'], { cwd: projectDir, stdio: 'ignore' });
    execFileSync('git', ['worktree', 'add', runtimeDir, '-b', 'runtime/main-sync', 'origin/main'], {
      cwd: projectDir,
      stdio: 'ignore',
    });
    const normalizedRuntimeDir = realpathSync(runtimeDir);

    // Staged non-lock change + unstaged lock drift
    writeFileSync(join(normalizedRuntimeDir, 'src.js'), 'modified\n', 'utf8');
    execFileSync('git', ['add', 'src.js'], { cwd: normalizedRuntimeDir, stdio: 'ignore' });
    writeFileSync(join(normalizedRuntimeDir, 'pnpm-lock.yaml'), 'lockfileVersion: 8\n', 'utf8');

    const env = withStubbedPnpmEnv(normalizedRuntimeDir);
    const result = spawnSync('bash', [join(projectDir, 'scripts', 'runtime-worktree.sh'), 'start', '--daemon'], {
      cwd: projectDir,
      encoding: 'utf8',
      env: {
        ...env,
        CAT_CAFE_RUNTIME_RESTART_OK: '1',
        CAT_CAFE_RUNTIME_DIR: normalizedRuntimeDir,
        API_SERVER_PORT: '19899',
      },
    });

    assert.notEqual(
      result.status,
      0,
      `should reject but exited 0\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stderr, /runtime worktree has local changes/);
  });
});
