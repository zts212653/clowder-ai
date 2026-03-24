import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

function runSourceOnlySnippet(scriptPath, snippet) {
  const result = spawnSync(
    'bash',
    ['-lc', `set -e\nsource "${scriptPath}" --source-only >/dev/null 2>&1\ntrap - EXIT INT TERM\n${snippet}`],
    { encoding: 'utf8' },
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
declare -F port_has_listener >/dev/null
declare -F list_listening_pids >/dev/null
declare -F wait_for_port_or_exit >/dev/null
declare -F api_launch_command >/dev/null
declare -F frontend_launch_command >/dev/null
declare -F default_redis_storage_key >/dev/null
declare -F default_redis_data_dir >/dev/null
declare -F default_redis_backup_dir >/dev/null
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
      env: {
        ...process.env,
        FRONTEND_PORT: '3023',
        API_SERVER_PORT: '3024',
        REDIS_PORT: '6409',
      },
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
      env: {
        ...process.env,
        NEXT_PUBLIC_API_URL: 'http://localhost:3035',
      },
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
      env: {
        ...process.env,
        PREVIEW_GATEWAY_PORT: '5120',
      },
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
  const baseEnv = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TERM: process.env.TERM ?? 'xterm-256color',
    CAT_CAFE_RESPECT_DOTENV_PORTS: '1',
  };

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
        env: {
          ...process.env,
          HOME: tempHome,
          REDIS_PORT: '6409',
        },
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

test('wait_for_port_or_exit accepts ss listener when lsof is a false negative', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const output = runSourceOnlySnippet(
    scriptPath,
    `
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' RETURN
cat > "$tmp_dir/ss" <<'EOF'
#!/bin/sh
printf '%s\n' \
  'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process' \
  'LISTEN 0 511 0.0.0.0:3013 0.0.0.0:* users:(("next-server",pid=4242,fd=23))'
EOF
cat > "$tmp_dir/lsof" <<'EOF'
#!/bin/sh
exit 1
EOF
chmod +x "$tmp_dir/ss" "$tmp_dir/lsof"
PATH="$tmp_dir:$PATH"
if wait_for_port_or_exit 3013 "Frontend" "$$" 1 >/dev/null; then
  printf 'ss-detected'
else
  printf 'missed-listener'
fi
`,
  );

  assert.equal(output, 'ss-detected');
});

test('kill_processes_on_port can terminate ss-detected listener when lsof misses it', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const output = runSourceOnlySnippet(
    scriptPath,
    `
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' RETURN
sleep 30 &
victim=$!
cat > "$tmp_dir/ss" <<EOF
#!/bin/sh
if kill -0 "$victim" 2>/dev/null; then
  printf '%s\\n' \
    'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process' \
    'LISTEN 0 511 0.0.0.0:3013 0.0.0.0:* users:(("next-server",pid=$victim,fd=23))'
else
  printf '%s\\n' 'State Recv-Q Send-Q Local Address:Port Peer Address:Port Process'
fi
EOF
cat > "$tmp_dir/lsof" <<'EOF'
#!/bin/sh
exit 1
EOF
chmod +x "$tmp_dir/ss" "$tmp_dir/lsof"
PATH="$tmp_dir:$PATH"
kill_processes_on_port 3013 >/dev/null
if kill -0 "$victim" 2>/dev/null; then
  printf 'still-running'
else
  printf 'killed-via-ss'
fi
wait "$victim" 2>/dev/null || true
`,
  );

  assert.equal(output, 'killed-via-ss');
});

test('api_launch_command uses exec so wait tracks the long-lived server process', () => {
  const scriptPath = resolve(process.cwd(), '../../scripts/start-dev.sh');
  const output = runSourceOnlySnippet(
    scriptPath,
    `
CAT_CAFE_DIRECT_NO_WATCH=1
printf '%s' "$(api_launch_command)"
`,
  );

  assert.equal(output, 'cd packages/api && exec pnpm run start');
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
