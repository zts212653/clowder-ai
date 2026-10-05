import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

function createSandbox(envFile = '') {
  const dir = mkdtempSync(join(tmpdir(), 'cc-alpha-redis-'));
  mkdirSync(join(dir, 'scripts', 'lib'), { recursive: true });
  for (const path of [
    'start-dev.sh',
    'download-source-overrides.sh',
    'lib/node-runtime-guard.sh',
    'lib/redis-rdb-first.sh',
  ]) {
    cpSync(join(root, 'scripts', path), join(dir, 'scripts', path));
  }
  if (envFile) writeFileSync(join(dir, '.env'), envFile);
  return dir;
}

function runSourceOnly(sandboxDir, commands, env = {}) {
  return spawnSync('bash', ['-lc', commands.join('\n')], {
    cwd: sandboxDir,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TERM: process.env.TERM ?? 'xterm-256color',
      ...env,
    },
  });
}

test('ordinary dev cannot attach to the dedicated Alpha Redis port', () => {
  const sandboxDir = createSandbox();
  try {
    const dev = runSourceOnly(sandboxDir, ['source scripts/start-dev.sh --source-only', 'printf "REACHED\\n"'], {
      REDIS_PORT: '6397',
    });
    assert.notEqual(dev.status, 0);
    assert.match(dev.stderr, /Alpha Redis port 6397/);
    assert.doesNotMatch(dev.stdout, /REACHED/);

    const alpha = runSourceOnly(
      sandboxDir,
      ['source scripts/start-dev.sh --source-only', 'printf "ALPHA=%s\\n" "$REDIS_PORT"'],
      { REDIS_PORT: '6397', CAT_CAFE_DEPLOYMENT_ID: 'alpha' },
    );
    assert.equal(alpha.status, 0, alpha.stderr);
    assert.match(alpha.stdout, /ALPHA=6397/);
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});

test('Alpha CLI Redis coordinates override stale checkout dotenv', () => {
  const sandboxDir = createSandbox(
    'REDIS_PORT=6398\nREDIS_DATA_DIR=/tmp/shared-redis\nREDIS_BACKUP_DIR=/tmp/shared-backups\nREDIS_KEY_PREFIX=cat-cafe:alpha:f317-upgrade:\nCAT_CAFE_ALPHA_ALLOW_EMPTY_REDIS=1\n',
  );
  const dataDir = join(sandboxDir, 'alpha-redis');
  const backupDir = join(sandboxDir, 'alpha-backups');
  try {
    const result = runSourceOnly(
      sandboxDir,
      [
        'source scripts/start-dev.sh --source-only',
        'printf "PORT=%s DIR=%s BACKUP=%s PREFIX=%s EMPTY=%s\\n" "$REDIS_PORT" "$REDIS_DATA_DIR" "$REDIS_BACKUP_DIR" "$REDIS_KEY_PREFIX" "$CAT_CAFE_ALPHA_ALLOW_EMPTY_REDIS"',
      ],
      {
        CAT_CAFE_DEPLOYMENT_ID: 'alpha',
        CAT_CAFE_RESPECT_DOTENV_PORTS: '0',
        REDIS_PORT: '6397',
        REDIS_DATA_DIR: dataDir,
        REDIS_BACKUP_DIR: backupDir,
        REDIS_KEY_PREFIX: 'cat-cafe:',
        CAT_CAFE_ALPHA_ALLOW_EMPTY_REDIS: '0',
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PORT=6397/);
    assert.ok(result.stdout.includes(`DIR=${dataDir}`));
    assert.ok(result.stdout.includes(`BACKUP=${backupDir}`));
    assert.match(result.stdout, /PREFIX=cat-cafe: EMPTY=0/);
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});

test('Alpha rejects a live Redis with the wrong directory or no AOF at attach', () => {
  const sandboxDir = createSandbox();
  const dataDir = join(sandboxDir, 'alpha-redis');
  const binDir = join(sandboxDir, 'bin');
  const stateFile = join(sandboxDir, 'redis-state');
  const dumpPath = join(dataDir, 'dump.rdb');
  mkdirSync(dataDir);
  mkdirSync(binDir);
  writeFileSync(
    join(binDir, 'redis-cli'),
    '#!/bin/sh\ncase "$*" in\n  *" config get dir") printf "dir\\n%s\\n" "$TEST_REDIS_DIR" ;;\n  *" config get appendonly") printf "appendonly\\n%s\\n" "$TEST_APPENDONLY" ;;\n  *" dbsize") printf "%s\\n" "$TEST_DBSIZE" ;;\n  *" ping") test "$(cat "$TEST_REDIS_STATE")" = alive && printf "PONG\\n" ;;\n  *" shutdown nosave") printf stopped > "$TEST_REDIS_STATE" ;;\n  *" shutdown") printf empty > "$TEST_RDB_PATH"; printf stopped > "$TEST_REDIS_STATE" ;;\n  *) exit 1 ;;\nesac\n',
    { mode: 0o755 },
  );
  const probe = (redisDir, appendonly, dbsize = '1', allowEmpty = '0') => {
    writeFileSync(stateFile, 'alive');
    return runSourceOnly(
      sandboxDir,
      [
        'set -e',
        'source scripts/start-dev.sh --source-only',
        'USE_REDIS=true',
        'ensure_redis_dirs() { :; }',
        'archive_redis_snapshot() { :; }',
        'redis_ping() { return 0; }',
        'print_redis_runtime_info() { :; }',
        'setup_storage',
        'printf "ALPHA-ATTACHED\\n"',
      ],
      {
        PATH: `${binDir}:${process.env.PATH}`,
        CAT_CAFE_DEPLOYMENT_ID: 'alpha',
        REDIS_PORT: '19514',
        REDIS_DATA_DIR: dataDir,
        TEST_REDIS_DIR: redisDir,
        TEST_APPENDONLY: appendonly,
        TEST_DBSIZE: dbsize,
        TEST_REDIS_STATE: stateFile,
        TEST_RDB_PATH: dumpPath,
        CAT_CAFE_ALPHA_ALLOW_EMPTY_REDIS: allowEmpty,
      },
    );
  };
  try {
    const wrongDir = probe(join(sandboxDir, 'foreign'), 'yes');
    assert.notEqual(wrongDir.status, 0);
    assert.match(wrongDir.stderr, /Alpha Redis data directory mismatch/);
    assert.doesNotMatch(wrongDir.stdout, /ALPHA-ATTACHED/);
    assert.equal(readFileSync(stateFile, 'utf8'), 'alive', 'foreign Redis must not be stopped');

    const noAof = probe(dataDir, 'no');
    assert.notEqual(noAof.status, 0);
    assert.match(noAof.stderr, /Alpha Redis requires AOF/);

    const valid = probe(dataDir, 'yes');
    assert.equal(valid.status, 0, valid.stderr);
    assert.match(valid.stdout, /ALPHA-ATTACHED/);

    writeFileSync(dumpPath, 'x'.repeat(1024));
    const snapshot = readFileSync(dumpPath);
    const emptyAfterSnapshot = probe(dataDir, 'yes', '0');
    assert.notEqual(emptyAfterSnapshot.status, 0, 'a nonempty snapshot must not silently become an empty Alpha');
    assert.match(emptyAfterSnapshot.stderr, /Alpha Redis loaded an empty database/);
    assert.equal(readFileSync(stateFile, 'utf8'), 'stopped', 'owned empty Redis must be stopped without saving');
    assert.deepEqual(readFileSync(dumpPath), snapshot, 'the original snapshot bytes must survive empty-load refusal');

    const explicitEmpty = probe(dataDir, 'yes', '0', '1');
    assert.equal(explicitEmpty.status, 0, explicitEmpty.stderr);
  } finally {
    rmSync(sandboxDir, { recursive: true, force: true });
  }
});
