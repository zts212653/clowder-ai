import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

test('redis-restore script restarts with AOF enabled and quarantines old appendonly dir', () => {
  const repoRoot = resolve(process.cwd(), '../..');
  const scriptPath = join(repoRoot, 'scripts', 'redis-restore-from-rdb.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-restore-script-'));
  const fakeBin = join(tempRoot, 'bin');
  const targetDir = join(tempRoot, 'redis-data');
  const sourceDump = join(tempRoot, 'source.rdb');
  const argsLog = join(tempRoot, 'redis-server.args');
  const cliLog = join(tempRoot, 'redis-cli.args');

  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(targetDir, { recursive: true });
  mkdirSync(join(targetDir, 'appendonlydir'), { recursive: true });

  writeFileSync(sourceDump, 'restored-data', 'utf8');
  writeFileSync(join(targetDir, 'dump.rdb'), 'old-data', 'utf8');
  writeFileSync(
    join(targetDir, 'appendonlydir', 'appendonly.aof.manifest'),
    'file appendonly.aof.1.base.rdb seq 1 type b\n',
    'utf8',
  );

  const mockRedisCli = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MOCK_REDIS_CLI_ARGS_FILE"
if [[ "\${1:-}" == "-p" ]]; then
  shift 2
fi
cmd="\${1:-}"
case "$cmd" in
  ping)
    exit 0
    ;;
  config)
    if [[ "\${2:-}" == "set" ]]; then
      echo OK
      exit 0
    fi
    key="\${3:-}"
    case "$key" in
      dir)
        printf 'dir\\n%s\\n' "$MOCK_TARGET_DIR"
        ;;
      dbfilename)
        printf 'dbfilename\\n%s\\n' "\${MOCK_DBFILE:-dump.rdb}"
        ;;
      appendonly)
        printf 'appendonly\\n%s\\n' "\${MOCK_APPENDONLY:-yes}"
        ;;
      appendfilename)
        printf 'appendfilename\\n%s\\n' "\${MOCK_APPENDFILENAME:-appendonly.aof}"
        ;;
      appenddirname)
        printf 'appenddirname\\n%s\\n' "\${MOCK_APPENDDIRNAME:-appendonlydir}"
        ;;
      appendfsync)
        printf 'appendfsync\\n%s\\n' "\${MOCK_APPENDFSYNC:-everysec}"
        ;;
      *)
        printf '%s\\n\\n' "$key"
        ;;
    esac
    ;;
  shutdown)
    exit 0
    ;;
  dbsize)
    echo 123
    ;;
  --scan)
    echo 'cat-cafe:sample-key'
    ;;
  *)
    exit 0
    ;;
esac
`;

  const mockRedisServer = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then
  echo 'Redis server v=7.2.4 sha=00000000:0 malloc=libc bits=64'
  exit 0
fi
printf '%s\\n' "$@" > "$MOCK_REDIS_SERVER_ARGS_FILE"
exit 0
`;

  writeFileSync(join(fakeBin, 'redis-cli'), mockRedisCli, 'utf8');
  writeFileSync(join(fakeBin, 'redis-server'), mockRedisServer, 'utf8');
  chmodSync(join(fakeBin, 'redis-cli'), 0o755);
  chmodSync(join(fakeBin, 'redis-server'), 0o755);

  const result = spawnSync('bash', [scriptPath, '--source', sourceDump, '--target-port', '6399', '--yes'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      MOCK_TARGET_DIR: targetDir,
      MOCK_REDIS_SERVER_ARGS_FILE: argsLog,
      MOCK_REDIS_CLI_ARGS_FILE: cliLog,
      MOCK_APPENDONLY: 'yes',
      MOCK_APPENDFILENAME: 'appendonly.aof',
      MOCK_APPENDDIRNAME: 'appendonlydir',
      MOCK_APPENDFSYNC: 'everysec',
    },
  });

  try {
    assert.equal(result.status, 0, `restore failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const restoredDump = readFileSync(join(targetDir, 'dump.rdb'), 'utf8');
    assert.equal(restoredDump, 'restored-data');

    const backupDir = join(targetDir, 'cat-cafe-redis-backups');
    const backupEntries = readdirSync(backupDir);
    assert.ok(
      backupEntries.some((entry) => entry.startsWith('appendonlydir.') && entry.endsWith('.bak')),
      `expected quarantined appendonlydir backup, got: ${backupEntries.join(', ')}`,
    );

    const serverArgs = readFileSync(argsLog, 'utf8');
    assert.match(serverArgs, /--appendonly\nno/);
    assert.match(serverArgs, /--appendfilename\nappendonly\.aof/);
    assert.match(serverArgs, /--appenddirname\nappendonlydir/);
    assert.match(serverArgs, /--appendfsync\neverysec/);
    const cliArgs = readFileSync(cliLog, 'utf8');
    assert.match(cliArgs, /-p 6399 config set appendonly yes/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('redis-restore script tolerates Redis 6 without appenddirname config', () => {
  const repoRoot = resolve(process.cwd(), '../..');
  const scriptPath = join(repoRoot, 'scripts', 'redis-restore-from-rdb.sh');
  const tempRoot = mkdtempSync(join(tmpdir(), 'cat-cafe-restore-redis6-script-'));
  const fakeBin = join(tempRoot, 'bin');
  const targetDir = join(tempRoot, 'redis-data');
  const sourceDump = join(tempRoot, 'source.rdb');
  const argsLog = join(tempRoot, 'redis-server.args');
  const cliLog = join(tempRoot, 'redis-cli.args');

  mkdirSync(fakeBin, { recursive: true });
  mkdirSync(targetDir, { recursive: true });

  writeFileSync(sourceDump, 'restored-data', 'utf8');
  writeFileSync(join(targetDir, 'dump.rdb'), 'old-data', 'utf8');
  writeFileSync(join(targetDir, 'appendonly.aof'), 'old-aof-data', 'utf8');

  const mockRedisCli = `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$MOCK_REDIS_CLI_ARGS_FILE"
if [[ "\${1:-}" == "-p" ]]; then
  shift 2
fi
cmd="\${1:-}"
case "$cmd" in
  ping)
    exit 0
    ;;
  config)
    if [[ "\${2:-}" == "set" ]]; then
      echo OK
      exit 0
    fi
    key="\${3:-}"
    case "$key" in
      dir)
        printf 'dir\\n%s\\n' "$MOCK_TARGET_DIR"
        ;;
      dbfilename)
        printf 'dbfilename\\n%s\\n' "\${MOCK_DBFILE:-dump.rdb}"
        ;;
      appendonly)
        printf 'appendonly\\n%s\\n' "\${MOCK_APPENDONLY:-yes}"
        ;;
      appendfilename)
        printf 'appendfilename\\n%s\\n' "\${MOCK_APPENDFILENAME:-appendonly.aof}"
        ;;
      appenddirname)
        echo 'ERR unknown option or number of arguments for CONFIG GET appenddirname' >&2
        exit 1
        ;;
      appendfsync)
        printf 'appendfsync\\n%s\\n' "\${MOCK_APPENDFSYNC:-everysec}"
        ;;
      *)
        printf '%s\\n\\n' "$key"
        ;;
    esac
    ;;
  shutdown)
    exit 0
    ;;
  dbsize)
    echo 123
    ;;
  --scan)
    echo 'cat-cafe:sample-key'
    ;;
  *)
    exit 0
    ;;
esac
`;

  const mockRedisServer = `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then
  echo 'Redis server v=6.2.14 sha=00000000:0 malloc=libc bits=64'
  exit 0
fi
printf '%s\\n' "$@" > "$MOCK_REDIS_SERVER_ARGS_FILE"
exit 0
`;

  writeFileSync(join(fakeBin, 'redis-cli'), mockRedisCli, 'utf8');
  writeFileSync(join(fakeBin, 'redis-server'), mockRedisServer, 'utf8');
  chmodSync(join(fakeBin, 'redis-cli'), 0o755);
  chmodSync(join(fakeBin, 'redis-server'), 0o755);

  const result = spawnSync('bash', [scriptPath, '--source', sourceDump, '--target-port', '6399', '--yes'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      MOCK_TARGET_DIR: targetDir,
      MOCK_REDIS_SERVER_ARGS_FILE: argsLog,
      MOCK_REDIS_CLI_ARGS_FILE: cliLog,
      MOCK_APPENDONLY: 'yes',
      MOCK_APPENDFILENAME: 'appendonly.aof',
      MOCK_APPENDFSYNC: 'everysec',
    },
  });

  try {
    assert.equal(result.status, 0, `restore failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);

    const restoredDump = readFileSync(join(targetDir, 'dump.rdb'), 'utf8');
    assert.equal(restoredDump, 'restored-data');

    const backupDir = join(targetDir, 'cat-cafe-redis-backups');
    const backupEntries = readdirSync(backupDir);
    assert.ok(
      backupEntries.some((entry) => entry.startsWith('appendonly.aof.') && entry.endsWith('.bak')),
      `expected quarantined appendonly.aof backup, got: ${backupEntries.join(', ')}`,
    );

    const serverArgs = readFileSync(argsLog, 'utf8');
    assert.match(serverArgs, /--appendonly\nno/);
    assert.match(serverArgs, /--appendfilename\nappendonly\.aof/);
    assert.doesNotMatch(serverArgs, /--appenddirname/);
    const cliArgs = readFileSync(cliLog, 'utf8');
    assert.match(cliArgs, /-p 6399 config set appendonly yes/);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
