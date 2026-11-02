import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

// Shell/protocol executable fixtures check ordering and generic compatibility.
// Real Redis/OS incarnation evidence is in alpha-named-storage.test.mjs.
function fixture(t, { dbsize = null } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'redis-hook-contract-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = join(directory, 'calls');
  const bin = join(directory, 'bin');
  mkdirSync(bin);
  writeFileSync(log, '');
  writeFileSync(
    join(bin, 'redis-server'),
    '#!/bin/sh\nif [ "$1" = --version ]; then echo "Redis server v=7.0.0"; else echo spawn >> "$REDIS_HOOK_TEST_LOG"; fi\n',
    { mode: 0o755 },
  );
  writeFileSync(
    join(bin, 'redis-cli'),
    `#!/bin/sh\necho "protocol $*" >> "$REDIS_HOOK_TEST_LOG"\ncase "$*" in
      *" ping") echo PONG ;;
      *" dbsize") ${dbsize === 'unknown' ? "echo 'identity unreadable (argv unavailable)' >&2; exit 1" : `echo '${dbsize ?? '1'}'`} ;;
      *" config get appendonly") printf "appendonly\\nyes\\n" ;;
      *) echo OK ;;
    esac\n`,
    { mode: 0o755 },
  );
  return {
    seedRdb: () => writeFileSync(join(directory, 'dump.rdb'), Buffer.alloc(4096, 1)),
    run(options = '', callback = 'return 0', setup = '') {
      return spawnSync(
        'bash',
        [
          '-c',
          `set -e\nsource "$1"\n${setup}\ntrap 'echo "unverified=\${REDIS_STARTUP_DATA_UNVERIFIED:-false}" >> "$REDIS_HOOK_TEST_LOG"' EXIT\nnamed_alpha_capture_redis_identity() { echo "fixed-capture $*" >> "$REDIS_HOOK_TEST_LOG"; ${callback}; }\ncat_cafe_redis_start_daemon --port 15123 --dir "$2" --pidfile "$2/redis.pid" ${options}\n`,
          '_',
          new URL('./redis-rdb-first.sh', import.meta.url).pathname,
          directory,
        ],
        {
          cwd: directory,
          env: {
            PATH: `${bin}:${process.env.PATH}`,
            REDIS_HOOK_TEST_LOG: log,
            REDIS_START_HOOK: 'touch forbidden-side-effect',
          },
          encoding: 'utf8',
          timeout: 5_000,
        },
      );
    },
    calls: () => readFileSync(log, 'utf8').trim().split('\n'),
    forbiddenExists: () => existsSync(join(directory, 'forbidden-side-effect')),
  };
}

test('generic caller keeps normal protocol startup and never invokes the named ownership hook', (t) => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls()[0], 'spawn');
  assert.match(f.calls()[1], /^protocol .* ping$/);
  assert.equal(
    f.calls().some((line) => line.startsWith('fixed-capture')),
    false,
  );
  assert.equal(f.forbiddenExists(), false, 'an environment string does not receive execution authority');
});

for (const dbsize of ['unknown', 'NOAUTH Authentication required']) {
  test(`RDB-first ${dbsize} refuses without treating unknown size as empty or issuing a persistence write`, (t) => {
    const f = fixture(t, { dbsize });
    f.seedRdb();
    const result = f.run('--named-alpha-ownership');
    assert.equal(result.status, 1);
    assert.match(result.stderr, dbsize === 'unknown' ? /identity unreadable/ : /dbsize.*unreadable/);
    assert.doesNotMatch(f.calls().join('\n'), /shutdown|config set/);
  });
}

test('RDB-first confirmed zero size keeps its protective non-saving stop', (t) => {
  const f = fixture(t, { dbsize: '0' });
  f.seedRdb();
  assert.equal(f.run('--named-alpha-ownership').status, 1);
  assert.match(f.calls().join('\n'), /shutdown nosave/);
  assert.doesNotMatch(f.calls().join('\n'), /config set/);
});

test('named startup executes only its fixed capture before the first protocol command', (t) => {
  const f = fixture(t);
  const result = f.run('--named-alpha-ownership');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls()[0], 'spawn');
  assert.match(f.calls()[1], /^fixed-capture 15123 .*\/redis\.pid$/);
  assert.match(f.calls()[2], /^protocol .* ping$/);
});

test('capture refusal performs no Redis protocol and an arbitrary hook option cannot fork a server', (t) => {
  const denied = fixture(t);
  assert.notEqual(denied.run('--named-alpha-ownership', 'return 1').status, 0);
  assert.equal(
    denied.calls().some((line) => line.startsWith('protocol')),
    false,
  );
  const arbitrary = fixture(t);
  assert.notEqual(arbitrary.run('--after-start forbidden').status, 0);
  assert.deepEqual(arbitrary.calls(), ['unverified=false']);
});

// Inject protocol responses only; the production helper still decides when
// DBSIZE and AOF may run. The shell sleep advances its real clock interface so
// deadline cases take milliseconds rather than a full startup wait.
function pingScenario(body, sleep = ':') {
  return `
: > "$REDIS_HOOK_TEST_LOG.pings"
sleep() { ${sleep}; }
redis-cli() {
  case "$*" in
    *" ping")
      echo ping >> "$REDIS_HOOK_TEST_LOG.pings"
      local attempt
      attempt=$(wc -l < "$REDIS_HOOK_TEST_LOG.pings")
      echo "ping-attempt=$attempt" >> "$REDIS_HOOK_TEST_LOG"
      ${body}
      ;;
    *) command redis-cli "$@" ;;
  esac
}
`;
}

test('RDB loading past the old poll count waits for PONG before DBSIZE or AOF', (t) => {
  const f = fixture(t);
  f.seedRdb();
  const result = f.run(
    '--named-alpha-ownership',
    'return 0',
    pingScenario(`
    if [ "$attempt" -le 60 ]; then echo 'LOADING Redis is loading the dataset in memory'; else echo PONG; fi
  `),
  );
  assert.equal(result.status, 0, result.stderr);
  const calls = f.calls();
  assert.equal(calls.filter((line) => line.startsWith('ping-attempt=')).length, 61);
  const ready = calls.findIndex((line) => /ping-attempt=\s*61$/.test(line));
  assert.ok(calls.findIndex((line) => line.endsWith(' dbsize')) > ready);
  assert.ok(calls.findIndex((line) => line.includes('config set appendonly yes')) > ready);
});

for (const response of ['OK', 'NOAUTH Authentication required', 'ERR invalid command']) {
  test(`successful CLI exit with ${response} refuses immediately without persistence writes`, (t) => {
    const f = fixture(t);
    f.seedRdb();
    const result = f.run('--named-alpha-ownership', 'return 0', pingScenario(`echo '${response}'`));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PING.*(OK|NOAUTH|ERR)/);
    assert.equal(f.calls().filter((line) => line.startsWith('ping-attempt=')).length, 1);
    assert.doesNotMatch(f.calls().join('\n'), /dbsize|config set|shutdown/);
    assert.equal(f.calls().at(-1), 'unverified=true');
  });
}

test('loading deadline keeps data unverified and never starts DBSIZE or AOF', (t) => {
  const f = fixture(t);
  f.seedRdb();
  const result = f.run(
    '--named-alpha-ownership',
    'return 0',
    pingScenario("echo 'LOADING Redis is loading the dataset in memory'", 'SECONDS=$((SECONDS + 15))'),
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /readiness.*(budget|timed out)/);
  assert.equal(f.calls().filter((line) => line.startsWith('ping-attempt=')).length, 2);
  assert.doesNotMatch(f.calls().join('\n'), /dbsize|config set|shutdown/);
  assert.equal(f.calls().at(-1), 'unverified=true');
});

test('identity refusal after LOADING is terminal and cannot become a loading retry', (t) => {
  const f = fixture(t);
  f.seedRdb();
  const result = f.run(
    '--named-alpha-ownership',
    'return 0',
    pingScenario(`
    if [ "$attempt" -eq 1 ]; then echo 'LOADING Redis is loading the dataset in memory';
    else echo 'identity unreadable (argv unavailable)' >&2; return 1; fi
  `),
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /identity unreadable/);
  assert.equal(f.calls().filter((line) => line.startsWith('ping-attempt=')).length, 2);
  assert.doesNotMatch(f.calls().join('\n'), /dbsize|config set|shutdown/);
});

test('an AOF configuration error cannot become a successful CLI exit', (t) => {
  const f = fixture(t);
  f.seedRdb();
  const result = f.run(
    '--named-alpha-ownership',
    'return 0',
    `
redis-cli() {
  case "$*" in
    *" config set appendfsync everysec")
      echo 'ERR fixture persistence refusal'
      case " $* " in *" -e "*) return 1 ;; *) return 0 ;; esac
      ;;
    *) command redis-cli "$@" ;;
  esac
}
`,
  );
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /ERR fixture persistence refusal/);
  assert.doesNotMatch(f.calls().join('\n'), /config set appendonly yes/);
});

test('AOF confirmation preserves an identity refusal and never retries it', (t) => {
  const f = fixture(t);
  f.seedRdb();
  const result = f.run(
    '--named-alpha-ownership',
    'return 0',
    `
sleep() { :; }
redis-cli() {
  case "$*" in
    *" config get appendonly")
      echo config-read-refusal >> "$REDIS_HOOK_TEST_LOG"
      echo 'identity unreadable (argv unavailable)' >&2; return 1
      ;;
    *) command redis-cli "$@" ;;
  esac
}
`,
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /identity unreadable/);
  assert.equal(f.calls().filter((line) => line === 'config-read-refusal').length, 1);
});

test('a connection refusal may settle, but the generic caller still requires PONG', (t) => {
  const f = fixture(t);
  const result = f.run(
    '',
    'return 0',
    pingScenario(`
    if [ "$attempt" -eq 1 ]; then
      echo 'Could not connect to Redis at 127.0.0.1:15123: Connection refused' >&2; return 1
    fi
    echo PONG
  `),
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(f.calls().filter((line) => line.startsWith('ping-attempt=')).length, 2);
});

test('a PONG arriving after the fixed deadline cannot authorize persistence', (t) => {
  const f = fixture(t);
  f.seedRdb();
  const result = f.run(
    '--named-alpha-ownership',
    'return 0',
    pingScenario(
      `
    if [ "$attempt" -eq 1 ]; then echo 'LOADING Redis is loading the dataset in memory';
    else /bin/sleep 2; echo PONG; fi
  `,
      'SECONDS=$((SECONDS + 29))',
    ),
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /readiness.*budget exhausted/);
  assert.doesNotMatch(f.calls().join('\n'), /dbsize|config set|shutdown/);
});

test('a connected server that never replies cannot hang the PING child', async (t) => {
  const sockets = new Set();
  const server = createServer((socket) => sockets.add(socket));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  const child = spawn(
    'bash',
    [
      '-c',
      'source "$1"; cat_cafe_redis_wait_for_ping "$2" 1 0',
      '_',
      new URL('./redis-rdb-first.sh', import.meta.url).pathname,
      String(server.address().port),
    ],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  let forced = false;
  child.stderr.on('data', (data) => {
    stderr += data;
  });
  const timer = setTimeout(() => {
    forced = true;
    // This group was created by the test; bound teardown even on the old hang.
    process.kill(-child.pid, 'SIGKILL');
  }, 5_000);
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  }).finally(() => clearTimeout(timer));
  assert.equal(forced, false, 'production must terminate its PING, not the test watchdog');
  assert.equal(code, 1);
  assert.match(stderr, /PING command failed.*ETIMEDOUT/);
});
