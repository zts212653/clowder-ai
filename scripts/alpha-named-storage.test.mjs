import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { captureNamedAlphaRedisIdentity, verifyNamedAlphaRedisIdentity } from './lib/alpha-redis-process.mjs';
import { storageFixture } from './lib/alpha-storage-test-fixture.mjs';

for (const [point, observation, emptyMemory] of [
  ['dir', 2],
  ['appendonly', 3],
  ['dbsize', 4],
  ['dbsize with unverified empty memory', 4, true],
]) {
  test(`post-PING ${point} identity refusal stays visible and cannot become an empty-database shutdown`, async (t) => {
    const f = await storageFixture(t, { unreadableAfterBoot: true });
    f.seedRdb();
    const originalRdb = readFileSync(join(f.directory, 'dump.rdb'));
    const trace = join(f.directory, 'readiness-observations.ndjson');
    const protocol = join(f.directory, 'protocol.log');
    const bin = join(f.directory, 'protocol-bin');
    mkdirSync(bin);
    writeFileSync(
      join(bin, 'redis-cli'),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ALPHA_TEST_PROTOCOL_TRACE"\nexec "$ALPHA_TEST_REAL_REDIS_CLI" "$@"\n',
      { mode: 0o755 },
    );
    const result = f.storage(
      `
eval "$(declare -f cat_cafe_redis_start_daemon | sed '1s/cat_cafe_redis_start_daemon/original_redis_start_daemon/')"
cat_cafe_redis_start_daemon() {
  original_redis_start_daemon "$@" || return 1
  ${emptyMemory ? 'redis-cli -p "$REDIS_PORT" flushdb >/dev/null' : ''}
  : > "$ALPHA_TEST_READINESS_TRACE"
}
`,
      {
        PATH: `${bin}:${process.env.PATH}`,
        ALPHA_TEST_READINESS_TRACE: trace,
        // Exhaust the current full-scope reobservation before expecting refusal.
        ALPHA_TEST_UNREADABLE_AT: `${observation}+${observation + 1}`,
        ALPHA_TEST_PROTOCOL_TRACE: protocol,
        ALPHA_TEST_REAL_REDIS_CLI: execFileSync('which', ['redis-cli'], { encoding: 'utf8' }).trim(),
      },
      { expectRetainedRedis: emptyMemory },
    );
    const samples = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(samples[observation - 1].argvAvailable, false, 'reach the exact refused verification');
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /identity unreadable \(argv unavailable\)/);
    assert.doesNotMatch(result.stderr, /empty database|empty RDB load/);
    assert.doesNotMatch(result.stdout, /STORAGE_PROOF=/);
    assert.doesNotMatch(readFileSync(protocol, 'utf8'), /shutdown nosave/, 'no protocol shutdown from an unknown size');
    assert.equal(
      existsSync(f.pidFile),
      Boolean(emptyMemory),
      'unverified empty memory must remain owned without saving over the nonempty snapshot',
    );
    if (emptyMemory) assert.deepEqual(readFileSync(join(f.directory, 'dump.rdb')), originalRdb);
  });
}

for (const unavailable of ['2+3', '2+3+6+7']) {
  test(`RDB-first unreadable DBSIZE at ${unavailable} preserves an unloaded snapshot through cleanup`, async (t) => {
    const f = await storageFixture(t, { unreadableAfterBoot: true });
    f.seedRdb();
    const snapshot = readFileSync(join(f.directory, 'dump.rdb'));
    const trace = join(f.directory, 'rdb-first-observations.ndjson');
    const result = f.storage(
      `
timeout() { shift; "$@"; }
eval "$(declare -f cat_cafe_redis_start_daemon | sed '1s/cat_cafe_redis_start_daemon/original_redis_start_daemon/')"
eval "$(declare -f cat_cafe_redis_enable_aof_after_rdb_boot | sed '1s/cat_cafe_redis_enable_aof_after_rdb_boot/original_enable_aof/')"
cat_cafe_redis_start_daemon() {
  : > "$ALPHA_TEST_READINESS_TRACE"
  original_redis_start_daemon "$@"
}
cat_cafe_redis_enable_aof_after_rdb_boot() {
  # This private fixture simulates an RDB boot whose memory did not load its keys.
  command redis-cli -h 127.0.0.1 -p "$1" flushdb >/dev/null
  original_enable_aof "$@"
}
`,
      { ALPHA_TEST_READINESS_TRACE: trace, ALPHA_TEST_UNREADABLE_AT: unavailable },
      { expectRetainedRedis: true },
    );
    const samples = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
    const refused = samples.flatMap((sample, index) => (sample.argvAvailable === false ? [index + 1] : []));
    assert.deepEqual(refused, unavailable.split('+').map(Number), 'reach both the startup and requested cleanup reads');
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.match(result.stderr, /identity unreadable \(argv unavailable\)/);
    assert.match(result.stderr, /cleanup incomplete; preserving named Alpha lease and data/);
    assert.doesNotMatch(result.stdout, /STORAGE_PROOF=/);
    assert.deepEqual(
      readFileSync(join(f.directory, 'dump.rdb')),
      snapshot,
      'never save empty memory over the original RDB',
    );
    assert.equal(existsSync(f.pidFile), true, 'retain the registered Redis until test-owned teardown');
    assert.equal(f.redis('dbsize'), '0', 'the retained instance still has the empty memory used by this regression');
  });
}

test('actual storage startup preserves the tuple received by the production API coordinate consumer', async (t) => {
  const f = await storageFixture(t);
  const result = f.storage();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.split('\n').find((item) => item.startsWith('STORAGE_PROOF='));
  assert.ok(line, result.stdout);
  const proof = JSON.parse(line.slice('STORAGE_PROOF='.length));
  assert.deepEqual(proof, { current: true, redisUrl: `redis://127.0.0.1:${f.port}`, sidecar: '0', leaseCount: 1 });
  assert.equal(existsSync(f.pidFile), false, 'actual launcher EXIT cleanup stops only its owned Redis');
});

test('actual RDB-first startup proves ownership before PING/AOF and recovers its own persisted keys', async (t) => {
  const f = await storageFixture(t);
  f.seedRdb();
  const result = f.storage();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /booting RDB first/);
  assert.doesNotMatch(result.stderr, /refusing unproven/);
  assert.equal(existsSync(f.pidFile), false, 'normal cleanup must leave no owned listener');
  assert.ok(existsSync(join(f.directory, 'recovered-marker')));
  assert.equal(readFileSync(join(f.directory, 'recovered-marker'), 'utf8').trim().length, 4096);
});

test('readiness exhaustion preserves a nonempty RDB without AOF or saving EXIT cleanup', async (t) => {
  const f = await storageFixture(t);
  f.seedRdb();
  const snapshot = readFileSync(join(f.directory, 'dump.rdb'));
  const result = f.storage(
    `
eval "$(declare -f redis-cli | sed '1s/redis-cli/original_guarded_cli/')"
redis-cli() {
  case "$*" in
    *" ping")
      # Still execute the real per-call identity verifier and native Redis PING.
      original_guarded_cli "$@" >/dev/null || return 1
      echo 'LOADING Redis is loading the dataset in memory'
      ;;
    *) original_guarded_cli "$@" ;;
  esac
}
sleep() { SECONDS=$((SECONDS + 15)); }
`,
    {},
    { expectRetainedRedis: true },
  );
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /readiness.*budget exhausted/);
  assert.doesNotMatch(result.stdout, /STORAGE_PROOF=/);
  assert.equal(f.redis('dbsize'), '1', 'nonempty memory is not permission to save after readiness failed');
  assert.equal(existsSync(join(f.directory, 'appendonlydir')), false);
  assert.deepEqual(readFileSync(join(f.directory, 'dump.rdb')), snapshot);
  assert.equal(existsSync(f.pidFile), true, 'keep its ownership for explicit non-saving teardown');
});

test('RDB-first protocol failure after native ownership capture cleans the own listener', async (t) => {
  const f = await storageFixture(t);
  f.seedRdb();
  const result = f.storage('cat_cafe_redis_enable_aof_after_rdb_boot() { return 1; }');
  assert.notEqual(result.status, 0, 'explicit AOF failure fixture must reject startup');
  assert.equal(existsSync(f.pidFile), false, 'proved owned Redis is cleaned after the startup failure');
});

test('an already occupied temp Redis remains untouched and receives no startup protocol reads', async (t) => {
  const f = await storageFixture(t);
  // This isolated Redis is deliberately not spawned by the launcher session.
  mkdirSync(f.directory, { recursive: true });
  execFileSync(
    'redis-server',
    [
      '--port',
      String(f.port),
      '--bind',
      '127.0.0.1',
      '--dir',
      f.directory,
      '--save',
      '',
      '--appendonly',
      'yes',
      '--daemonize',
      'yes',
      '--pidfile',
      f.pidFile,
      '--logfile',
      join(f.directory, 'fixture-foreign.log'),
    ],
    { env: f.env, timeout: 5_000 },
  );
  const before = captureNamedAlphaRedisIdentity(f.raw);
  f.redis('set', 'fixture-foreign-marker', 'preserved');
  const result = f.storage();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /occupied; refusing replacement or protocol reads/);
  assert.equal(verifyNamedAlphaRedisIdentity(f.raw, before), true);
  assert.equal(f.redis('get', 'fixture-foreign-marker'), 'preserved');
});

test('actual replacement PID is preserved when failed startup cleanup holds an older owned identity', async (t) => {
  const f = await storageFixture(t);
  const original = f.seedRdb();
  execFileSync(
    'redis-server',
    [
      '--port',
      String(f.port),
      '--bind',
      '127.0.0.1',
      '--dir',
      f.directory,
      '--save',
      '',
      '--appendonly',
      'yes',
      '--daemonize',
      'yes',
      '--pidfile',
      f.pidFile,
      '--logfile',
      join(f.directory, 'fixture-replacement.log'),
    ],
    { env: f.env, timeout: 5_000 },
  );
  const replacement = captureNamedAlphaRedisIdentity(f.raw);
  assert.notEqual(replacement.pid, original.pid);
  f.redis('set', 'fixture-replacement-marker', 'preserved');
  const result = f.storage('STARTED_REDIS=true\nNAMED_ALPHA_REDIS_IDENTITY="$ALPHA_TEST_OLD_IDENTITY"', {
    ALPHA_TEST_OLD_IDENTITY: JSON.stringify(original),
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /preserving unproven or replaced named Alpha Redis/);
  assert.equal(verifyNamedAlphaRedisIdentity(f.raw, replacement), true);
  assert.equal(f.redis('get', 'fixture-replacement-marker'), 'preserved');
});

test('real storage startup sends PING only after a timely fresh identity or refuses a late observation', async (t) => {
  const f = await storageFixture(t, { unreadableAfterBoot: true });
  const trace = join(f.directory, 'readiness-observations.ndjson');
  const result = f.storage(
    `
eval "$(declare -f cat_cafe_redis_start_daemon | sed '1s/cat_cafe_redis_start_daemon/original_redis_start_daemon/')"
cat_cafe_redis_start_daemon() {
  original_redis_start_daemon "$@" || return 1
  : > "$ALPHA_TEST_READINESS_TRACE"
}
`,
    { ALPHA_TEST_READINESS_TRACE: trace },
  );
  const observations = readFileSync(trace, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  const budget = readFileSync(`${trace}.budget`, 'utf8').trim().split('\n').map(JSON.parse);
  t.diagnostic(JSON.stringify({ exit: result.status, observations, budget }));
  const samples = observations.filter((observation) => observation.invocation === 'ping-ready');
  const deadline = budget.find((event) => event.kind === 'deadline').value;
  const lastClock = budget.findLast((event) => event.kind === 'clock').value;
  const pings = budget.filter((event) => event.kind === 'protocol').length;
  assert.equal(observations[0].argvAvailable, false);
  assert.ok(samples.length <= 10);
  if (result.status === 0) {
    assert.equal(pings, 1);
    assert.ok(lastClock < deadline);
    assert.equal(samples.at(-1).argvAvailable, true);
    assert.equal(samples.at(-1).pid, samples[0].pid);
    assert.equal(samples.at(-1).startedAtEpochMs, samples[0].startedAtEpochMs);
    assert.match(result.stdout, /STORAGE_PROOF=/);
  } else {
    assert.equal(result.status, 1, result.stderr || result.stdout);
    assert.ok(lastClock >= deadline, result.stderr || result.stdout);
    assert.equal(pings, 0, 'late native identity cannot authorize any startup PING');
    assert.match(result.stderr, /Alpha Redis startup wait budget exhausted/);
    assert.doesNotMatch(result.stdout, /STORAGE_PROOF=/);
  }
  assert.equal(existsSync(f.pidFile), false, 'normal owned cleanup still stops the actual Redis process');
});

test('launcher timeouts cannot count as an expected storage refusal', async (t) => {
  const f = await storageFixture(t);
  assert.throws(() => f.storage('sleep 1', {}, { timeout: 1 }), /ETIMEDOUT/);
  assert.equal(existsSync(f.pidFile), false, 'an execution timeout before storage cannot claim Redis ownership');
});

test('launcher signals cannot count as an expected storage refusal', async (t) => {
  const f = await storageFixture(t);
  assert.throws(() => f.storage('kill -KILL "$$"'), /storage launcher was terminated/);
  assert.equal(existsSync(f.pidFile), false, 'a signal before storage cannot claim Redis ownership');
});
