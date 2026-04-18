import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function runSourceOnlySnippet(scriptPath, snippet, envOverrides = {}) {
  const result = spawnSync(
    'bash',
    ['-lc', `set -e\nsource "${scriptPath}" --source-only >/dev/null 2>&1\ntrap - EXIT INT TERM\n${snippet}`],
    { encoding: 'utf8', env: baseShellEnv(envOverrides) },
  );

  assert.equal(result.status, 0, `snippet failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

  return result.stdout.trim();
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
declare -F default_redis_storage_key >/dev/null
declare -F default_redis_data_dir >/dev/null
declare -F default_redis_backup_dir >/dev/null
declare -F maybe_quarantine_stale_aof_dir >/dev/null
printf 'ok'
`,
  );

  assert.equal(output, 'ok');
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

test('load_dare_env_from_local whitelists anthropic key+endpoint overrides', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const output = runSourceOnlySnippet(
    scriptPath,
    `
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' RETURN
cd "$tmp_dir"
cat > .env.local <<'EOF'
DARE_API_KEY=sk-dare-local
DARE_ENDPOINT=https://dare-proxy.example/v1
ANTHROPIC_API_KEY=sk-ant-local
ANTHROPIC_BASE_URL=https://anthropic-proxy.example
EOF
unset DARE_API_KEY DARE_ENDPOINT ANTHROPIC_API_KEY ANTHROPIC_BASE_URL
load_dare_env_from_local
printf '%s|%s|%s|%s' "$DARE_API_KEY" "$DARE_ENDPOINT" "$ANTHROPIC_API_KEY" "$ANTHROPIC_BASE_URL"
`,
  );

  assert.equal(output, 'sk-dare-local|https://dare-proxy.example/v1|sk-ant-local|https://anthropic-proxy.example');
});

test('explicit port env vars override .env values for direct startup', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
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
});

test('explicit NEXT_PUBLIC_API_URL override survives project .env during direct startup', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
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
});

test('explicit PREVIEW_GATEWAY_PORT override survives project .env during direct startup', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
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
    mkdirSync(join(tempRoot, 'scripts'), { recursive: true });
    cpSync(scriptPath, tempScriptPath);
    cpSync(resolve(process.cwd(), '../../scripts/download-source-overrides.sh'), tempOverridesPath);
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

test('raw dev entry remaps setup-style Redis 6399 defaults to dev Redis 6398', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-start-dev-redis-dev-default-'));
  const tempScriptPath = join(tempRoot, 'scripts', 'start-dev.sh');
  const tempOverridesPath = join(tempRoot, 'scripts', 'download-source-overrides.sh');

  try {
    mkdirSync(join(tempRoot, 'scripts'), { recursive: true });
    cpSync(scriptPath, tempScriptPath);
    cpSync(resolve(process.cwd(), '../../scripts/download-source-overrides.sh'), tempOverridesPath);
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
    assert.equal(result.stdout.trim(), '6398|redis://localhost:6398');
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
    mkdirSync(join(tempRoot, 'scripts'), { recursive: true });
    cpSync(scriptPath, tempScriptPath);
    cpSync(resolve(process.cwd(), '../../scripts/download-source-overrides.sh'), tempOverridesPath);
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
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const tempHome = mkdtempSync(join(tmpdir(), 'cat-cafe-start-dev-redis-override-'));

  try {
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

  assert.equal(output, 'cd packages/api && exec NODE_ENV=production pnpm run start');
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

  assert.equal(output, 'cd packages/web && PORT=3013 exec pnpm exec next start -p 3013 -H 0.0.0.0');
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
