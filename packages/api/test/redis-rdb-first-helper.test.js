import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function createFakeRedisBin(root, { version = 'Redis server v=7.2.4 sha=00000000:0 malloc=libc bits=64' } = {}) {
  const binDir = join(root, 'bin');
  const serverArgsLog = join(root, 'redis-server.args');
  const cliArgsLog = join(root, 'redis-cli.args');
  mkdirSync(binDir, { recursive: true });

  writeFileSync(
    join(binDir, 'redis-server'),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then
  printf '%s\\n' "${version}"
  exit 0
fi
printf '%s\\n' "$@" > "${serverArgsLog}"
exit 0
`,
  );
  writeFileSync(
    join(binDir, 'redis-cli'),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "${cliArgsLog}"
if [[ "\${1:-}" == "-p" ]]; then
  shift 2
fi
case "\${1:-}" in
  ping)
    exit 0
    ;;
  config)
    if [[ "\${2:-}" == "get" && "\${3:-}" == "appendonly" ]]; then
      printf 'appendonly\\nyes\\n'
    else
      printf 'OK\\n'
    fi
    ;;
  dbsize)
    printf '1\\n'
    ;;
  shutdown)
    exit 0
    ;;
esac
`,
  );
  chmodSync(join(binDir, 'redis-server'), 0o755);
  chmodSync(join(binDir, 'redis-cli'), 0o755);
  return { binDir, serverArgsLog, cliArgsLog };
}

test('redis RDB-first helper omits appenddirname for Redis 6 single-file AOF', () => {
  const helperPath = resolve(process.cwd(), '../../scripts/lib/redis-rdb-first.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-redis6-helper-'));
  const redisDir = join(tempRoot, 'redis-data');
  mkdirSync(redisDir, { recursive: true });
  const { binDir, serverArgsLog } = createFakeRedisBin(tempRoot, {
    version: 'Redis server v=6.2.14 sha=00000000:0 malloc=libc bits=64',
  });

  try {
    const result = spawnSync(
      'bash',
      [
        '-lc',
        `
set -euo pipefail
source "${helperPath}"
PATH="${binDir}:$PATH"
cat_cafe_redis_start_daemon \
  --port 6398 \
  --bind 127.0.0.1 \
  --dir "${redisDir}" \
  --dbfilename dump.rdb \
  --appendonly yes \
  --appendfilename appendonly.aof \
  --appenddirname appendonlydir \
  --appendfsync everysec \
  --daemonize yes
`,
      ],
      { encoding: 'utf8', env: baseShellEnv() },
    );

    assert.equal(result.status, 0, `helper failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const args = readFileSync(serverArgsLog, 'utf8');
    assert.match(args, /--appendfilename\nappendonly\.aof/);
    assert.doesNotMatch(args, /--appenddirname/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('redis RDB-first helper keeps appenddirname for Redis 7 multipart AOF', () => {
  const helperPath = resolve(process.cwd(), '../../scripts/lib/redis-rdb-first.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-redis7-helper-'));
  const redisDir = join(tempRoot, 'redis-data');
  mkdirSync(redisDir, { recursive: true });
  const { binDir, serverArgsLog } = createFakeRedisBin(tempRoot);

  try {
    const result = spawnSync(
      'bash',
      [
        '-lc',
        `
set -euo pipefail
source "${helperPath}"
PATH="${binDir}:$PATH"
cat_cafe_redis_start_daemon \
  --port 6398 \
  --bind 127.0.0.1 \
  --dir "${redisDir}" \
  --dbfilename dump.rdb \
  --appendonly yes \
  --appendfilename appendonly.aof \
  --appenddirname appendonlydir \
  --appendfsync everysec \
  --daemonize yes
`,
      ],
      { encoding: 'utf8', env: baseShellEnv() },
    );

    assert.equal(result.status, 0, `helper failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    const args = readFileSync(serverArgsLog, 'utf8');
    assert.match(args, /--appenddirname\nappendonlydir/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
