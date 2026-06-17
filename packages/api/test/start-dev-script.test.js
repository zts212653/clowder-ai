import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

function baseShellEnv(overrides = {}) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TERM: process.env.TERM ?? 'xterm-256color',
    ...overrides,
  };
}

function commandExists(command) {
  return (
    spawnSync('bash', ['-lc', `command -v "${command}" >/dev/null 2>&1`], {
      encoding: 'utf8',
      env: baseShellEnv(),
    }).status === 0
  );
}

function runSourceOnlySnippet(scriptPath, snippet, envOverrides = {}) {
  const result = spawnSync(
    'bash',
    ['-lc', `set -e\nsource "${scriptPath}" --source-only >/dev/null 2>&1\ntrap - EXIT INT TERM\n${snippet}`],
    { encoding: 'utf8', env: baseShellEnv(envOverrides) },
  );

  assert.equal(result.status, 0, `snippet failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  return result.stdout.trim();
}

function createBashOnlyPath(root) {
  const binDir = join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'bash'), '#!/bin/sh\nexec /bin/bash "$@"\n', { mode: 0o755 });
  return binDir;
}

function createProbePath(root, tools) {
  const binDir = createBashOnlyPath(root);
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(join(binDir, name), body, { mode: 0o755 });
  }
  return binDir;
}

function listenOnLoopback() {
  const server = createServer();
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolvePromise(server));
  });
}

async function stopRedis(redisCli, mode = 'nosave', attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    if (redisCli('ping').status !== 0) return;
    redisCli('shutdown', mode);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  assert.notEqual(redisCli('ping').status, 0, 'test Redis must stop during cleanup');
}

test('source-only exposes helper functions for testing seams', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const output = runSourceOnlySnippet(
    scriptPath,
    `
declare -F configure_mcp_server_path >/dev/null
declare -F background_eval_with_null_stdin >/dev/null
declare -F wait_for_port_or_exit >/dev/null
declare -F api_launch_command >/dev/null
declare -F frontend_launch_command >/dev/null
declare -F ensure_api_native_addons >/dev/null
declare -F web_production_build_ready >/dev/null
declare -F default_redis_storage_key >/dev/null
declare -F default_redis_data_dir >/dev/null
declare -F default_redis_backup_dir >/dev/null
declare -F maybe_quarantine_stale_aof_dir >/dev/null
declare -F cat_cafe_redis_start_daemon >/dev/null
printf 'ok'
`,
  );

  assert.equal(output, 'ok');
});

test('probe_port_with_dev_tcp falls back when timeout is unavailable', async () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-start-dev-no-timeout-'));
  const server = await listenOnLoopback();

  try {
    const binDir = createBashOnlyPath(tempRoot);
    const port = server.address().port;
    const output = runSourceOnlySnippet(
      scriptPath,
      `
PATH="${binDir}"
probe_port_with_dev_tcp "${port}"
printf 'ok'
`,
    );

    assert.match(output, /ok$/);
  } finally {
    await new Promise((resolvePromise) => server.close(resolvePromise));
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('probe_port_with_nc wraps nc with timeout when timeout is available', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-start-dev-nc-timeout-'));
  const timeoutLog = join(tempRoot, 'timeout.log');
  const ncLog = join(tempRoot, 'nc.log');

  try {
    const binDir = createProbePath(tempRoot, {
      timeout: `#!/bin/bash
printf '%s\\n' "$*" >> "${timeoutLog}"
shift
exec "$@"
`,
      nc: `#!/bin/bash
printf '%s\\n' "$*" >> "${ncLog}"
exit 0
`,
    });

    const output = runSourceOnlySnippet(
      scriptPath,
      `
PATH="${binDir}"
probe_port_with_nc 6543
printf 'ok'
`,
    );

    assert.match(output, /ok$/);
    assert.equal(readFileSync(timeoutLog, 'utf8').trim(), '1 nc -z 127.0.0.1 6543');
    assert.equal(readFileSync(ncLog, 'utf8').trim(), '-z 127.0.0.1 6543');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('probe_port_with_nc falls back to bare nc when timeout is unavailable', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-start-dev-nc-no-timeout-'));
  const ncLog = join(tempRoot, 'nc.log');

  try {
    const binDir = createProbePath(tempRoot, {
      nc: `#!/bin/bash
printf '%s\\n' "$*" >> "${ncLog}"
exit 0
`,
    });

    const output = runSourceOnlySnippet(
      scriptPath,
      `
PATH="${binDir}"
probe_port_with_nc 6544
printf 'ok'
`,
    );

    assert.equal(output, 'ok');
    assert.equal(readFileSync(ncLog, 'utf8').trim(), '-z 127.0.0.1 6544');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('redis_ping wraps redis-cli ping with timeout when timeout is available', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-start-dev-redis-timeout-'));
  const timeoutLog = join(tempRoot, 'timeout.log');
  const redisLog = join(tempRoot, 'redis.log');

  try {
    const binDir = createProbePath(tempRoot, {
      timeout: `#!/bin/bash
printf '%s\\n' "$*" >> "${timeoutLog}"
shift
exec "$@"
`,
      'redis-cli': `#!/bin/bash
printf '%s\\n' "$*" >> "${redisLog}"
exit 0
`,
    });

    const output = runSourceOnlySnippet(
      scriptPath,
      `
PATH="${binDir}"
REDIS_PORT=6545
redis_ping
printf 'ok'
`,
    );

    assert.equal(output, 'ok');
    assert.equal(readFileSync(timeoutLog, 'utf8').trim(), '2 redis-cli -p 6545 ping');
    assert.equal(readFileSync(redisLog, 'utf8').trim(), '-p 6545 ping');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('redis_ping falls back to bare redis-cli when timeout is unavailable', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-start-dev-redis-no-timeout-'));
  const redisLog = join(tempRoot, 'redis.log');

  try {
    const binDir = createProbePath(tempRoot, {
      'redis-cli': `#!/bin/bash
printf '%s\\n' "$*" >> "${redisLog}"
exit 0
`,
    });

    const output = runSourceOnlySnippet(
      scriptPath,
      `
PATH="${binDir}"
REDIS_PORT=6546
redis_ping
printf 'ok'
`,
    );

    assert.equal(output, 'ok');
    assert.equal(readFileSync(redisLog, 'utf8').trim(), '-p 6546 ping');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test(
  'Redis cold start uses RDB-first bootstrap when dump.rdb exists without appendonlydir',
  { skip: !(commandExists('redis-server') && commandExists('redis-cli')) },
  async () => {
    const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
    const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-rdb-first-start-'));
    const redisDir = join(tempRoot, 'redis-data');
    mkdirSync(redisDir, { recursive: true });

    const server = await listenOnLoopback();
    const port = server.address().port;
    await new Promise((resolvePromise) => server.close(resolvePromise));

    const redisCli = (...args) =>
      spawnSync('redis-cli', ['-p', String(port), ...args], {
        encoding: 'utf8',
        env: baseShellEnv(),
      });

    try {
      const seed = spawnSync(
        'redis-server',
        [
          '--port',
          String(port),
          '--bind',
          '127.0.0.1',
          '--dir',
          redisDir,
          '--dbfilename',
          'dump.rdb',
          '--appendonly',
          'no',
          '--daemonize',
          'yes',
        ],
        { encoding: 'utf8', env: baseShellEnv() },
      );
      assert.equal(seed.status, 0, `seed redis failed\nstdout:\n${seed.stdout}\nstderr:\n${seed.stderr}`);
      for (let i = 0; i < 50 && redisCli('ping').status !== 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(redisCli('set', 'cat-cafe:rdb-first-probe', 'survived').status, 0);
      assert.equal(redisCli('save').status, 0);
      await stopRedis(redisCli, 'save');
      rmSync(join(redisDir, 'appendonlydir'), { recursive: true, force: true });

      const result = spawnSync(
        'bash',
        [
          '-lc',
          `
set -eo pipefail
source "${scriptPath}" --source-only >/dev/null 2>&1
trap - EXIT INT TERM
cat_cafe_redis_start_daemon \
  --port "${port}" \
  --bind 127.0.0.1 \
  --dir "${redisDir}" \
  --dbfilename dump.rdb \
  --save "3600 1 300 100 60 10000" \
  --appendonly yes \
  --appendfilename appendonly.aof \
  --appenddirname appendonlydir \
  --appendfsync everysec \
  --daemonize yes \
  --pidfile "${join(redisDir, `redis-${port}.pid`)}" \
  --logfile "${join(redisDir, `redis-${port}.log`)}"
redis-cli -p "${port}" dbsize
redis-cli -p "${port}" get cat-cafe:rdb-first-probe
redis-cli -p "${port}" config get appendonly | sed -n '2p'
redis-cli -p "${port}" shutdown nosave >/dev/null 2>&1 || true
`,
        ],
        { encoding: 'utf8', env: baseShellEnv() },
      );

      assert.equal(result.status, 0, `rdb-first start failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
      const output = result.stdout.trim().split('\n').slice(-3);
      assert.deepEqual(output, ['1', 'survived', 'yes']);
    } finally {
      await stopRedis(redisCli, 'nosave');
      rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);

test('signal traps clean up and exit with standard signal codes', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  for (const [signal, expectedStatus] of [
    ['INT', 130],
    ['TERM', 143],
  ]) {
    const result = spawnSync(
      'bash',
      ['-lc', `source "${scriptPath}" --source-only >/dev/null 2>&1\nkill -${signal} $$\nexit 99`],
      { encoding: 'utf8', env: baseShellEnv() },
    );

    assert.equal(result.status, expectedStatus, `${signal} stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /正在关闭服务/);
    assert.match(result.stdout, /再见！/);
    assert.equal((result.stdout.match(/再见！/g) ?? []).length, 1);
  }
});

test('configure_mcp_server_path sets default path when env is unset', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-start-dev-default-'));
  const expectedPath = join(tempRoot, 'packages', 'mcp-server', 'dist', 'index.js');

  try {
    mkdirSync(join(tempRoot, 'packages', 'mcp-server', 'dist'), { recursive: true });

    const output = runSourceOnlySnippet(
      scriptPath,
      `
PROJECT_DIR="${tempRoot}"
unset CAT_CAFE_MCP_SERVER_PATH
configure_mcp_server_path >/dev/null
printf '%s' "$CAT_CAFE_MCP_SERVER_PATH"
`,
    );

    assert.equal(output, expectedPath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('configure_mcp_server_path uses default path when env is empty string', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-start-dev-empty-'));
  const expectedPath = join(tempRoot, 'packages', 'mcp-server', 'dist', 'index.js');

  try {
    mkdirSync(join(tempRoot, 'packages', 'mcp-server', 'dist'), { recursive: true });

    const output = runSourceOnlySnippet(
      scriptPath,
      `
PROJECT_DIR="${tempRoot}"
export CAT_CAFE_MCP_SERVER_PATH=""
configure_mcp_server_path >/dev/null
printf '%s' "$CAT_CAFE_MCP_SERVER_PATH"
`,
    );

    assert.equal(output, expectedPath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('configure_mcp_server_path keeps explicit CAT_CAFE_MCP_SERVER_PATH', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const explicitPath = '/tmp/custom/mcp-server-entry.js';

  const output = runSourceOnlySnippet(
    scriptPath,
    `
export CAT_CAFE_MCP_SERVER_PATH="${explicitPath}"
configure_mcp_server_path >/dev/null
printf '%s' "$CAT_CAFE_MCP_SERVER_PATH"
`,
  );

  assert.equal(output, explicitPath);
});

test('ensure_api_native_addons rebuilds better-sqlite3 after Node ABI drift', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-start-dev-native-rebuild-'));
  const binDir = join(tempRoot, 'bin');
  const apiDir = join(tempRoot, 'packages', 'api');
  const nodeProbeCount = join(tempRoot, 'node-probe-count');
  const pnpmLog = join(tempRoot, 'pnpm.log');

  try {
    mkdirSync(binDir, { recursive: true });
    mkdirSync(apiDir, { recursive: true });
    writeFileSync(join(apiDir, 'package.json'), '{"name":"@cat-cafe/api"}\n');
    writeFileSync(
      join(binDir, 'node'),
      `#!/bin/bash
if [ "\${1:-}" = "-e" ]; then
  case "\${2:-}" in
    *"new Database(':memory:')"*) ;;
    *) exit 2 ;;
  esac
  count=0
  [ -f "${nodeProbeCount}" ] && count="$(cat "${nodeProbeCount}")"
  count=$((count + 1))
  printf '%s\\n' "$count" > "${nodeProbeCount}"
  [ "$count" -ge 2 ]
  exit $?
fi
exit 0
`,
      { mode: 0o755 },
    );
    writeFileSync(
      join(binDir, 'pnpm'),
      `#!/bin/bash
printf '%s\\n' "$*" >> "${pnpmLog}"
exit 0
`,
      { mode: 0o755 },
    );

    const output = runSourceOnlySnippet(
      scriptPath,
      `
PROJECT_DIR="${tempRoot}"
PATH="${binDir}:$PATH"
ensure_api_native_addons
printf 'ok'
`,
    );

    assert.match(output, /ok$/);
    assert.match(readFileSync(pnpmLog, 'utf8'), /rebuild better-sqlite3/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

function createTempProject() {
  const tmp = mkdtempSync(join(tmpdir(), 'env-local-'));
  const scriptsDir = join(tmp, 'scripts');
  mkdirSync(scriptsDir);
  mkdirSync(join(scriptsDir, 'lib'), { recursive: true });
  const realScriptsDir = resolve(process.cwd(), '../../scripts');
  cpSync(join(realScriptsDir, 'start-dev.sh'), join(scriptsDir, 'start-dev.sh'));
  cpSync(join(realScriptsDir, 'download-source-overrides.sh'), join(scriptsDir, 'download-source-overrides.sh'));
  cpSync(join(realScriptsDir, 'lib', 'node-runtime-guard.sh'), join(scriptsDir, 'lib', 'node-runtime-guard.sh'));
  cpSync(join(realScriptsDir, 'lib', 'redis-rdb-first.sh'), join(scriptsDir, 'lib', 'redis-rdb-first.sh'));
  chmodSync(join(scriptsDir, 'start-dev.sh'), 0o755);
  return tmp;
}

function copyStartDevClosure(tempRoot, scriptPath, tempScriptPath, tempOverridesPath) {
  mkdirSync(join(tempRoot, 'scripts', 'lib'), { recursive: true });
  cpSync(scriptPath, tempScriptPath);
  cpSync(resolve(process.cwd(), '../../scripts/download-source-overrides.sh'), tempOverridesPath);
  cpSync(
    resolve(process.cwd(), '../../scripts/lib/node-runtime-guard.sh'),
    join(tempRoot, 'scripts', 'lib', 'node-runtime-guard.sh'),
  );
  cpSync(
    resolve(process.cwd(), '../../scripts/lib/redis-rdb-first.sh'),
    join(tempRoot, 'scripts', 'lib', 'redis-rdb-first.sh'),
  );
}

test('.env.local overrides same-name keys from .env (#603)', () => {
  const tmp = createTempProject();
  try {
    writeFileSync(join(tmp, '.env'), 'FRONTEND_PORT=3003\nPREVIEW_GATEWAY_PORT=4099\n');
    writeFileSync(join(tmp, '.env.local'), 'FRONTEND_PORT=3013\nPREVIEW_GATEWAY_PORT=4199\n');
    const scriptPath = join(tmp, 'scripts', 'start-dev.sh');

    const result = spawnSync(
      'bash',
      [
        '-lc',
        `set -e\nsource "${scriptPath}" --source-only >/dev/null 2>&1\ntrap - EXIT INT TERM\nprintf '%s|%s' "$FRONTEND_PORT" "$PREVIEW_GATEWAY_PORT"`,
      ],
      {
        encoding: 'utf8',
        env: baseShellEnv({ CAT_CAFE_RESPECT_DOTENV_PORTS: '1' }),
      },
    );

    assert.equal(result.status, 0, `snippet failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), '3013|4199');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('CLI env vars beat .env.local for port keys in default mode (#603)', () => {
  const tmp = createTempProject();
  try {
    writeFileSync(join(tmp, '.env'), 'FRONTEND_PORT=3003\nAPI_SERVER_PORT=3004\n');
    writeFileSync(join(tmp, '.env.local'), 'FRONTEND_PORT=3013\nAPI_SERVER_PORT=3014\n');
    const scriptPath = join(tmp, 'scripts', 'start-dev.sh');

    const result = spawnSync(
      'bash',
      [
        '-lc',
        `set -e\nsource "${scriptPath}" --source-only >/dev/null 2>&1\ntrap - EXIT INT TERM\nprintf '%s|%s' "$FRONTEND_PORT" "$API_SERVER_PORT"`,
      ],
      {
        encoding: 'utf8',
        env: baseShellEnv({ FRONTEND_PORT: '3099', API_SERVER_PORT: '3098' }),
      },
    );

    assert.equal(result.status, 0, `snippet failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), '3099|3098');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('.env.local beats CLI env in respect-dotenv-ports mode (#603)', () => {
  const tmp = createTempProject();
  try {
    writeFileSync(join(tmp, '.env'), 'FRONTEND_PORT=3003\n');
    writeFileSync(join(tmp, '.env.local'), 'FRONTEND_PORT=3013\n');
    const scriptPath = join(tmp, 'scripts', 'start-dev.sh');

    const result = spawnSync(
      'bash',
      [
        '-lc',
        `set -e\nsource "${scriptPath}" --source-only >/dev/null 2>&1\ntrap - EXIT INT TERM\nprintf '%s' "$FRONTEND_PORT"`,
      ],
      {
        encoding: 'utf8',
        env: baseShellEnv({ FRONTEND_PORT: '3099', CAT_CAFE_RESPECT_DOTENV_PORTS: '1' }),
      },
    );

    assert.equal(result.status, 0, `snippet failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), '3013');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('.env.local can activate respect-dotenv-ports mode (#603)', () => {
  const tmp = createTempProject();
  try {
    writeFileSync(join(tmp, '.env'), 'FRONTEND_PORT=3003\n');
    writeFileSync(join(tmp, '.env.local'), 'CAT_CAFE_RESPECT_DOTENV_PORTS=1\nFRONTEND_PORT=3013\n');
    const scriptPath = join(tmp, 'scripts', 'start-dev.sh');

    const result = spawnSync(
      'bash',
      [
        '-lc',
        `set -e\nsource "${scriptPath}" --source-only >/dev/null 2>&1\ntrap - EXIT INT TERM\nprintf '%s' "$FRONTEND_PORT"`,
      ],
      {
        encoding: 'utf8',
        env: baseShellEnv({ FRONTEND_PORT: '3099' }),
      },
    );

    assert.equal(result.status, 0, `snippet failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), '3013');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('global sidecar owner marker from wrapper env beats dotenv values', () => {
  const tmp = createTempProject();
  try {
    writeFileSync(join(tmp, '.env.local'), 'CAT_CAFE_PROVISION_GLOBAL_SIDECAR=0\n');
    const scriptPath = join(tmp, 'scripts', 'start-dev.sh');

    const result = spawnSync(
      'bash',
      [
        '-lc',
        `set -e\nsource "${scriptPath}" --source-only >/dev/null 2>&1\ntrap - EXIT INT TERM\nprintf '%s' "$CAT_CAFE_PROVISION_GLOBAL_SIDECAR"`,
      ],
      {
        encoding: 'utf8',
        env: baseShellEnv({ CAT_CAFE_PROVISION_GLOBAL_SIDECAR: '1' }),
      },
    );

    assert.equal(result.status, 0, `snippet failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), '1');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('dotenv cannot grant global sidecar ownership without wrapper env', () => {
  const tmp = createTempProject();
  try {
    writeFileSync(join(tmp, '.env.local'), 'CAT_CAFE_PROVISION_GLOBAL_SIDECAR=1\n');
    const scriptPath = join(tmp, 'scripts', 'start-dev.sh');

    const result = spawnSync(
      'bash',
      [
        '-lc',
        `set -e\nsource "${scriptPath}" --source-only >/dev/null 2>&1\ntrap - EXIT INT TERM\nprintf '%s' "\${CAT_CAFE_PROVISION_GLOBAL_SIDECAR-unset}"`,
      ],
      {
        encoding: 'utf8',
        env: baseShellEnv(),
      },
    );

    assert.equal(result.status, 0, `snippet failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), 'unset');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('explicit port env vars override .env values for direct startup', () => {
  const tmp = createTempProject();
  try {
    const scriptPath = join(tmp, 'scripts', 'start-dev.sh');
    const result = spawnSync(
      'bash',
      [
        '-lc',
        `set -e\nsource "${scriptPath}" --source-only >/dev/null 2>&1\ntrap - EXIT INT TERM\nprintf '%s|%s|%s' "$FRONTEND_PORT" "$API_SERVER_PORT" "$REDIS_PORT"`,
      ],
      {
        encoding: 'utf8',
        env: baseShellEnv({
          FRONTEND_PORT: '3023',
          API_SERVER_PORT: '3024',
          REDIS_PORT: '6409',
        }),
      },
    );

    assert.equal(result.status, 0, `snippet failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), '3023|3024|6409');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('explicit NEXT_PUBLIC_API_URL override survives project .env during direct startup', () => {
  const tmp = createTempProject();
  try {
    const scriptPath = join(tmp, 'scripts', 'start-dev.sh');
    const result = spawnSync(
      'bash',
      [
        '-lc',
        `set -e\nsource "${scriptPath}" --source-only >/dev/null 2>&1\ntrap - EXIT INT TERM\nprintf '%s' "$NEXT_PUBLIC_API_URL"`,
      ],
      {
        encoding: 'utf8',
        env: baseShellEnv({
          NEXT_PUBLIC_API_URL: 'http://localhost:3035',
        }),
      },
    );

    assert.equal(result.status, 0, `snippet failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), 'http://localhost:3035');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('explicit PREVIEW_GATEWAY_PORT override survives project .env during direct startup', () => {
  const tmp = createTempProject();
  try {
    const scriptPath = join(tmp, 'scripts', 'start-dev.sh');
    const result = spawnSync(
      'bash',
      [
        '-lc',
        `set -e\nsource "${scriptPath}" --source-only >/dev/null 2>&1\ntrap - EXIT INT TERM\nprintf '%s' "$PREVIEW_GATEWAY_PORT"`,
      ],
      {
        encoding: 'utf8',
        env: baseShellEnv({
          PREVIEW_GATEWAY_PORT: '5120',
        }),
      },
    );

    assert.equal(result.status, 0, `snippet failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), '5120');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('direct command mode can prefer current .env ports over ambient shell ports', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-start-dev-dotenv-ports-'));
  const tempScriptPath = join(tempRoot, 'scripts', 'start-dev.sh');
  const tempOverridesPath = join(tempRoot, 'scripts', 'download-source-overrides.sh');
  const baseEnv = baseShellEnv({
    CAT_CAFE_RESPECT_DOTENV_PORTS: '1',
  });

  try {
    copyStartDevClosure(tempRoot, scriptPath, tempScriptPath, tempOverridesPath);
    writeFileSync(
      join(tempRoot, '.env'),
      'FRONTEND_PORT=3003\nAPI_SERVER_PORT=3004\nNEXT_PUBLIC_API_URL=http://localhost:3004\n',
      'utf8',
    );

    const result = spawnSync(
      'bash',
      [
        '-lc',
        `set -e\nsource "${tempScriptPath}" --source-only >/dev/null 2>&1\ntrap - EXIT INT TERM\nprintf '%s|%s|%s' "$FRONTEND_PORT" "$API_SERVER_PORT" "$NEXT_PUBLIC_API_URL"`,
      ],
      {
        cwd: tempRoot,
        encoding: 'utf8',
        env: {
          ...baseEnv,
          FRONTEND_PORT: '3002',
          API_SERVER_PORT: '3000',
          NEXT_PUBLIC_API_URL: 'http://localhost:3000',
        },
      },
    );

    assert.equal(result.status, 0, `snippet failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), '3003|3004|http://localhost:3004');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('raw dev entry remaps setup-style Redis 6399 defaults to dev Redis 6398 (IPv4 normalization)', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-start-dev-redis-dev-default-'));
  const tempScriptPath = join(tempRoot, 'scripts', 'start-dev.sh');
  const tempOverridesPath = join(tempRoot, 'scripts', 'download-source-overrides.sh');

  try {
    copyStartDevClosure(tempRoot, scriptPath, tempScriptPath, tempOverridesPath);
    writeFileSync(join(tempRoot, '.env'), 'REDIS_PORT=6399\nREDIS_URL=redis://localhost:6399\n', 'utf8');

    const result = spawnSync(
      'bash',
      [
        '-lc',
        `set -e\nsource "${tempScriptPath}" --source-only >/dev/null 2>&1\ntrap - EXIT INT TERM\nprintf '%s|%s' "$REDIS_PORT" "$REDIS_URL"`,
      ],
      {
        cwd: tempRoot,
        encoding: 'utf8',
        env: baseShellEnv(),
      },
    );

    assert.equal(result.status, 0, `snippet failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), '6398|redis://127.0.0.1:6398');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('respect-dotenv mode keeps explicit Redis 6399 defaults intact for wrappers', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-start-dev-redis-dotenv-keep-'));
  const tempScriptPath = join(tempRoot, 'scripts', 'start-dev.sh');
  const tempOverridesPath = join(tempRoot, 'scripts', 'download-source-overrides.sh');

  try {
    copyStartDevClosure(tempRoot, scriptPath, tempScriptPath, tempOverridesPath);
    writeFileSync(join(tempRoot, '.env'), 'REDIS_PORT=6399\nREDIS_URL=redis://localhost:6399\n', 'utf8');

    const result = spawnSync(
      'bash',
      [
        '-lc',
        `set -e\nsource "${tempScriptPath}" --source-only >/dev/null 2>&1\ntrap - EXIT INT TERM\nprintf '%s|%s' "$REDIS_PORT" "$REDIS_URL"`,
      ],
      {
        cwd: tempRoot,
        encoding: 'utf8',
        env: baseShellEnv({
          CAT_CAFE_RESPECT_DOTENV_PORTS: '1',
        }),
      },
    );

    assert.equal(result.status, 0, `snippet failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(result.stdout.trim(), '6399|redis://localhost:6399');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('redis port override also recomputes isolated redis dirs', () => {
  const tmp = createTempProject();
  const tempHome = mkdtempSync(join(tmpdir(), 'cat-cafe-start-dev-redis-override-'));

  try {
    const scriptPath = join(tmp, 'scripts', 'start-dev.sh');
    const result = spawnSync(
      'bash',
      [
        '-lc',
        `set -e\nsource "${scriptPath}" --source-only >/dev/null 2>&1\ntrap - EXIT INT TERM\nprintf '%s|%s|%s' "$REDIS_STORAGE_KEY" "$REDIS_DATA_DIR" "$REDIS_BACKUP_DIR"`,
      ],
      {
        encoding: 'utf8',
        env: baseShellEnv({
          HOME: tempHome,
          REDIS_PORT: '6409',
        }),
      },
    );

    assert.equal(result.status, 0, `snippet failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.equal(
      result.stdout.trim(),
      ['dev-6409', `${tempHome}/.cat-cafe/redis-dev-6409`, `${tempHome}/.cat-cafe/redis-backups/dev-6409`].join('|'),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('redis snapshot archive failure warns and does not abort startup flow', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-start-dev-archive-warn-'));
  const dataDir = join(tempRoot, 'data');
  const backupDir = join(tempRoot, 'backup');

  try {
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(backupDir, { recursive: true });
    writeFileSync(join(dataDir, 'dump.rdb'), 'stub');
    chmodSync(backupDir, 0o500);

    const result = spawnSync(
      'bash',
      [
        '-lc',
        `set -e\nsource "${scriptPath}" --source-only >/dev/null 2>&1\ntrap - EXIT INT TERM\nREDIS_PORT=65432\nREDIS_STORAGE_KEY=test-65432\nREDIS_DATA_DIR="${dataDir}"\nREDIS_BACKUP_DIR="${backupDir}"\nREDIS_DBFILE=dump.rdb\narchive_redis_snapshot manual\nprintf 'ok'`,
      ],
      { encoding: 'utf8' },
    );

    assert.equal(result.status, 0, `snapshot failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /Redis 快照归档失败/);
    assert.match(result.stdout, /ok$/);
  } finally {
    chmodSync(backupDir, 0o700);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('stale AOF guard quarantines tiny old appendonlydir before cold start', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-start-dev-stale-aof-'));
  const dataDir = join(tempRoot, 'data');
  const backupDir = join(tempRoot, 'backup');

  try {
    const output = runSourceOnlySnippet(
      scriptPath,
      `
mkdir -p "${dataDir}/appendonlydir" "${backupDir}"
REDIS_STORAGE_KEY=test-6399
REDIS_DATA_DIR="${dataDir}"
REDIS_BACKUP_DIR="${backupDir}"
REDIS_DBFILE=dump.rdb
dd if=/dev/zero of="${dataDir}/dump.rdb" bs=1024 count=2048 >/dev/null 2>&1
printf 'file appendonly.aof.1.base.rdb seq 1 type b\\n' > "${dataDir}/appendonlydir/appendonly.aof.manifest"
touch -t 202401010000 "${dataDir}/appendonlydir/appendonly.aof.manifest"
touch "${dataDir}/dump.rdb"
maybe_quarantine_stale_aof_dir >/dev/null
if [ -d "${dataDir}/appendonlydir" ]; then
  printf 'dir-present'
elif compgen -G "${backupDir}/stale-aof-test-6399-*" >/dev/null; then
  printf 'moved'
else
  printf 'missing-backup'
fi
`,
    );

    assert.equal(output, 'moved');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('stale AOF guard keeps appendonlydir when base size is proportional to dump', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-start-dev-healthy-aof-'));
  const dataDir = join(tempRoot, 'data');
  const backupDir = join(tempRoot, 'backup');

  try {
    const output = runSourceOnlySnippet(
      scriptPath,
      `
mkdir -p "${dataDir}/appendonlydir" "${backupDir}"
REDIS_STORAGE_KEY=test-6399
REDIS_DATA_DIR="${dataDir}"
REDIS_BACKUP_DIR="${backupDir}"
REDIS_DBFILE=dump.rdb
dd if=/dev/zero of="${dataDir}/dump.rdb" bs=1024 count=2048 >/dev/null 2>&1
dd if=/dev/zero of="${dataDir}/appendonlydir/appendonly.aof.1.base.rdb" bs=1024 count=1024 >/dev/null 2>&1
dd if=/dev/zero of="${dataDir}/appendonlydir/appendonly.aof.1.incr.aof" bs=1024 count=256 >/dev/null 2>&1
touch -t 202401010000 "${dataDir}/appendonlydir/appendonly.aof.1.incr.aof"
touch -t 202401010000 "${dataDir}/appendonlydir/appendonly.aof.1.base.rdb"
touch "${dataDir}/dump.rdb"
maybe_quarantine_stale_aof_dir >/dev/null
if [ -d "${dataDir}/appendonlydir" ]; then
  printf 'kept'
else
  printf 'moved'
fi
`,
    );

    assert.equal(output, 'kept');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('stale AOF guard quarantines tiny base even when incr AOF exists', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-start-dev-stale-aof-incr-'));
  const dataDir = join(tempRoot, 'data');
  const backupDir = join(tempRoot, 'backup');

  try {
    const output = runSourceOnlySnippet(
      scriptPath,
      `
mkdir -p "${dataDir}/appendonlydir" "${backupDir}"
REDIS_STORAGE_KEY=test-6399
REDIS_DATA_DIR="${dataDir}"
REDIS_BACKUP_DIR="${backupDir}"
REDIS_DBFILE=dump.rdb
dd if=/dev/zero of="${dataDir}/dump.rdb" bs=1024 count=2048 >/dev/null 2>&1
dd if=/dev/zero of="${dataDir}/appendonlydir/appendonly.aof.1.base.rdb" bs=1 count=88 >/dev/null 2>&1
dd if=/dev/zero of="${dataDir}/appendonlydir/appendonly.aof.1.incr.aof" bs=1024 count=256 >/dev/null 2>&1
touch -t 202401010000 "${dataDir}/appendonlydir/appendonly.aof.1.base.rdb"
touch -t 202401010000 "${dataDir}/appendonlydir/appendonly.aof.1.incr.aof"
touch "${dataDir}/dump.rdb"
maybe_quarantine_stale_aof_dir >/dev/null
if [ -d "${dataDir}/appendonlydir" ]; then
  printf 'dir-present'
elif compgen -G "${backupDir}/stale-aof-test-6399-*" >/dev/null; then
  printf 'moved'
else
  printf 'missing-backup'
fi
`,
    );

    assert.equal(output, 'moved');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('manual mirror args map to npm, pip, and HuggingFace environment overrides', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const output = runSourceOnlySnippet(
    scriptPath,
    `
unset CAT_CAFE_NPM_REGISTRY CAT_CAFE_PIP_INDEX_URL CAT_CAFE_PIP_EXTRA_INDEX_URL CAT_CAFE_HF_ENDPOINT
unset NPM_CONFIG_REGISTRY PIP_INDEX_URL PIP_EXTRA_INDEX_URL HF_ENDPOINT
parse_manual_download_source_arg '--npm-registry=https://npm.mirror.example'
parse_manual_download_source_arg '--pip-index-url=https://pip.mirror.example/simple'
parse_manual_download_source_arg '--pip-extra-index-url=https://pip.extra.example/simple'
parse_manual_download_source_arg '--hf-endpoint=https://hf.mirror.example'
apply_manual_download_source_overrides
printf '%s|%s|%s|%s|%s|%s|%s|%s' \
  "$CAT_CAFE_NPM_REGISTRY" "$NPM_CONFIG_REGISTRY" \
  "$CAT_CAFE_PIP_INDEX_URL" "$PIP_INDEX_URL" \
  "$CAT_CAFE_PIP_EXTRA_INDEX_URL" "$PIP_EXTRA_INDEX_URL" \
  "$CAT_CAFE_HF_ENDPOINT" "$HF_ENDPOINT"
`,
  );

  assert.equal(
    output,
    [
      'https://npm.mirror.example',
      'https://npm.mirror.example',
      'https://pip.mirror.example/simple',
      'https://pip.mirror.example/simple',
      'https://pip.extra.example/simple',
      'https://pip.extra.example/simple',
      'https://hf.mirror.example',
      'https://hf.mirror.example',
    ].join('|'),
  );
});

test('background_eval_with_null_stdin detaches background jobs from caller stdin', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const output = runSourceOnlySnippet(
    scriptPath,
    `
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' RETURN
printf 'parent-stdin' > "$tmp_dir/input.txt"
exec < "$tmp_dir/input.txt"
background_eval_with_null_stdin "sleep 1"
pid=$!
lsof -p "$pid" -a -d 0 -Fn
wait "$pid"
`,
  );

  assert.match(output, /n\/dev\/null/);
});

test('wait_for_port_or_exit fails fast when background process exits before binding', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const output = runSourceOnlySnippet(
    scriptPath,
    `
background_eval_with_null_stdin "exit 0"
pid=$!
if wait_for_port_or_exit 65534 "test-service" "$pid" 2 >/dev/null; then
  printf 'unexpected-success'
else
  printf 'failed-fast'
fi
`,
  );

  assert.equal(output, 'failed-fast');
});

test('wait_for_port_or_exit falls back when lsof probe fails but the port is actually listening', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const output = runSourceOnlySnippet(
    scriptPath,
    `
tmp_dir=$(mktemp -d)
trap 'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; rm -rf "$tmp_dir"' RETURN
cat > "$tmp_dir/server.js" <<'EOF'
const net = require('node:net');
const server = net.createServer((socket) => {
  socket.on('error', () => {});
  socket.end();
});
server.on('error', (err) => {
  console.error(err);
  process.exit(1);
});
server.listen(65531, '127.0.0.1', () => {
  setInterval(() => {}, 1000);
});
EOF
node "$tmp_dir/server.js" >/dev/null 2>&1 &
server_pid=$!
for _ in 1 2 3 4 5 6 7 8 9 10; do
  nc -z 127.0.0.1 65531 >/dev/null 2>&1 && break
  sleep 0.1
done
lsof() { return 1; }
ss() { return 127; }
if wait_for_port_or_exit 65531 "test-service" "$server_pid" 2 >/dev/null; then
  printf 'fallback-ok'
else
  printf 'fallback-failed'
fi
`,
  );

  assert.equal(output, 'fallback-ok');
});

test('terminate_managed_pids kills tracked child process trees', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const output = runSourceOnlySnippet(
    scriptPath,
    `
if ! command -v pgrep >/dev/null 2>&1; then
  printf 'skipped'
  exit 0
fi
sh -c 'sleep 30 & wait' &
parent_pid=$!
child_pid=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  child_pid=$(pgrep -P "$parent_pid" | head -n 1 || true)
  [ -n "$child_pid" ] && break
  sleep 0.1
done
[ -n "$child_pid" ] || { printf 'missing-child'; exit 1; }
MANAGED_PIDS=("$parent_pid")
terminate_managed_pids
sleep 0.2
if kill -0 "$child_pid" 2>/dev/null; then
  printf 'child-alive'
else
  printf 'child-killed'
fi
`,
  );

  assert.equal(output, 'child-killed');
});

test('port_listen_pids accepts fuser pid output from stderr', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const output = runSourceOnlySnippet(
    scriptPath,
    `
lsof() { return 1; }
ss() { return 1; }
fuser() { printf '3000/tcp: 4321 9876\\n' >&2; }
printf '%s' "$(port_listen_pids 3000 | paste -sd ',' -)"
`,
  );

  assert.equal(output, '4321,9876');
});

test('api_launch_command uses exec so wait tracks the long-lived server process', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const output = runSourceOnlySnippet(
    scriptPath,
    `
CAT_CAFE_DIRECT_NO_WATCH=1
PROD_WEB=true
printf '%s' "$(api_launch_command)"
`,
  );

  assert.equal(output, 'cd packages/api && exec env NODE_ENV=production pnpm run start');
});

test('api_launch_command routes multiple env assignments through env before pnpm', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const output = runSourceOnlySnippet(
    scriptPath,
    `
CAT_CAFE_DIRECT_NO_WATCH=1
PROD_WEB=true
DEBUG_MODE=true
printf '%s' "$(api_launch_command)"
`,
  );

  assert.equal(output, 'cd packages/api && exec env NODE_ENV=production LOG_LEVEL=debug pnpm run start');
});

test('api_launch_command output is actually executable: pnpm gets invoked with NODE_ENV propagated', () => {
  // Regression guard for LL-052: string-literal assertions above can't catch
  // `exec VAR=val pnpm` (no env) because bash would treat VAR=val as the program
  // name. This test eval()s the command in a bash sandbox with a pnpm shim on
  // PATH and asserts the shim actually ran with NODE_ENV=production.
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-start-dev-real-exec-'));
  const fakeApiDir = join(tempRoot, 'packages', 'api');
  const shimDir = join(tempRoot, 'bin');
  const capturePath = join(tempRoot, 'captured.txt');

  try {
    mkdirSync(fakeApiDir, { recursive: true });
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      join(shimDir, 'pnpm'),
      `#!/usr/bin/env bash\nprintf 'NODE_ENV=%s\\nARGS=%s\\n' "\${NODE_ENV:-<unset>}" "$*" > "${capturePath}"\n`,
      'utf8',
    );
    chmodSync(join(shimDir, 'pnpm'), 0o755);

    const result = spawnSync(
      'bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        `set -e
source "${scriptPath}" --source-only >/dev/null 2>&1
trap - EXIT INT TERM
CAT_CAFE_DIRECT_NO_WATCH=1
PROD_WEB=true
cmd=$(api_launch_command)
cd "${tempRoot}"
eval "$cmd"`,
      ],
      {
        encoding: 'utf8',
        env: baseShellEnv({ PATH: `${shimDir}:${process.env.PATH ?? ''}` }),
      },
    );

    assert.equal(
      result.status,
      0,
      `bash failed to exec api_launch_command (would catch broken \`exec VAR=val pnpm\` form)\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    const captured = readFileSync(capturePath, 'utf8');
    assert.match(captured, /NODE_ENV=production/, 'NODE_ENV did not propagate to pnpm');
    assert.match(captured, /ARGS=run start/, 'pnpm args incorrect');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('frontend_launch_command uses exec in production mode so wait tracks next start', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const output = runSourceOnlySnippet(
    scriptPath,
    `
PROD_WEB=true
WEB_PORT=3013
printf '%s' "$(frontend_launch_command)"
`,
  );

  assert.equal(
    output,
    'cd packages/web && pnpm run sync:vendor-assets && PORT=3013 exec pnpm exec next start -p 3013 -H 0.0.0.0',
  );
});

test('frontend_launch_command syncs vendor assets before Next dev when package lifecycle hooks are bypassed', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const output = runSourceOnlySnippet(
    scriptPath,
    `
PROD_WEB=false
WEB_PORT=3011
printf '%s' "$(frontend_launch_command)"
`,
  );

  assert.equal(
    output,
    'cd packages/web && NODE_ENV=development NEXT_IGNORE_INCORRECT_LOCKFILE=1 PORT=3011 exec pnpm exec node scripts/sync-vendor-assets.mjs --watch -- next dev -p 3011',
  );
});

test('frontend_launch_command dev mode overrides inherited production NODE_ENV', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-start-dev-frontend-node-env-'));
  const fakeWebDir = join(tempRoot, 'packages', 'web');
  const shimDir = join(tempRoot, 'bin');
  const capturePath = join(tempRoot, 'captured.txt');

  try {
    mkdirSync(fakeWebDir, { recursive: true });
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(
      join(shimDir, 'pnpm'),
      `#!/usr/bin/env bash\nprintf 'NODE_ENV=%s\\nARGS=%s\\n' "\${NODE_ENV:-<unset>}" "$*" > "${capturePath}"\n`,
      'utf8',
    );
    chmodSync(join(shimDir, 'pnpm'), 0o755);

    const result = spawnSync(
      'bash',
      [
        '--noprofile',
        '--norc',
        '-c',
        `set -e
source "${scriptPath}" --source-only >/dev/null 2>&1
trap - EXIT INT TERM
PROD_WEB=false
WEB_PORT=3011
cmd=$(frontend_launch_command)
cd "${tempRoot}"
eval "$cmd"`,
      ],
      {
        encoding: 'utf8',
        env: baseShellEnv({ PATH: `${shimDir}:${process.env.PATH ?? ''}`, NODE_ENV: 'production' }),
      },
    );

    assert.equal(
      result.status,
      0,
      `bash failed to exec frontend_launch_command\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    const captured = readFileSync(capturePath, 'utf8');
    assert.match(captured, /NODE_ENV=development/, 'frontend next dev inherited production NODE_ENV');
    assert.match(
      captured,
      /ARGS=exec node scripts\/sync-vendor-assets\.mjs --watch -- next dev -p 3011/,
      'pnpm args incorrect',
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('web_production_build_ready requires BUILD_ID instead of only .next directory', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-start-dev-web-build-'));

  try {
    mkdirSync(join(tempRoot, 'packages', 'web', '.next'), { recursive: true });

    const output = runSourceOnlySnippet(
      scriptPath,
      `
PROJECT_DIR="${tempRoot}"
if web_production_build_ready; then
  printf 'ready-before|'
else
  printf 'missing-before|'
fi
printf 'build-id' > "$PROJECT_DIR/packages/web/.next/BUILD_ID"
if web_production_build_ready; then
  printf 'ready-after'
else
  printf 'missing-after'
fi
`,
    );

    assert.equal(output, 'missing-before|ready-after');
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('print_manual_download_source_summary returns zero under set -e even when no overrides are set', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const output = runSourceOnlySnippet(
    scriptPath,
    `
set -e
print_manual_download_source_summary
printf 'survived'
`,
  );

  assert.equal(output, 'survived');
});

test('custom Redis port gets isolated default data and backup dirs', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempHome = mkdtempSync(join(tmpdir(), 'cat-cafe-redis-home-'));

  try {
    const output = runSourceOnlySnippet(
      scriptPath,
      `
HOME="${tempHome}"
REDIS_PROFILE=dev
REDIS_PORT=6389
printf '%s|%s|%s' \
  "$(default_redis_storage_key "$REDIS_PROFILE" "$REDIS_PORT")" \
  "$(default_redis_data_dir "$REDIS_PROFILE" "$REDIS_PORT")" \
  "$(default_redis_backup_dir "$REDIS_PROFILE" "$REDIS_PORT")"
`,
    );

    assert.equal(
      output,
      ['dev-6389', `${tempHome}/.cat-cafe/redis-dev-6389`, `${tempHome}/.cat-cafe/redis-backups/dev-6389`].join('|'),
    );
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('default Redis port keeps legacy data and backup dir names', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempHome = mkdtempSync(join(tmpdir(), 'cat-cafe-redis-home-'));

  try {
    const output = runSourceOnlySnippet(
      scriptPath,
      `
HOME="${tempHome}"
REDIS_PROFILE=dev
REDIS_PORT=6399
printf '%s|%s|%s' \
  "$(default_redis_storage_key "$REDIS_PROFILE" "$REDIS_PORT")" \
  "$(default_redis_data_dir "$REDIS_PROFILE" "$REDIS_PORT")" \
  "$(default_redis_backup_dir "$REDIS_PROFILE" "$REDIS_PORT")"
`,
    );

    assert.equal(
      output,
      ['dev', `${tempHome}/.cat-cafe/redis-dev`, `${tempHome}/.cat-cafe/redis-backups/dev`].join('|'),
    );
  } finally {
    rmSync(tempHome, { recursive: true, force: true });
  }
});
