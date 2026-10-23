import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, 'scripts/start-dev.sh'), 'utf8');
const captureFunction = source.match(/^named_alpha_capture_redis_identity\(\) \{\n[\s\S]*?^\}/m)?.[0];
assert.ok(captureFunction, 'exercise the actual launcher ownership-publication function');

test('launcher ownership refusal exposes the native cause without sending a protocol command', () => {
  const ownership = source.match(/^named_alpha_redis_is_owned\(\) \{\n[\s\S]*?^\}/m)?.[0];
  assert.ok(ownership);
  const result = spawnSync('bash', ['-eu'], {
    encoding: 'utf8',
    input: `
SCRIPT_DIR=/fixture/scripts
CAT_CAFE_ALPHA_COORDINATES=coordinates
NAMED_ALPHA_REDIS_IDENTITY=proof
node() { echo '[alpha-redis-process] Alpha Redis process identity unreadable (argv unavailable)' >&2; return 1; }
${ownership}
named_alpha_redis_is_owned
echo UNREACHABLE
`,
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /identity unreadable \(argv unavailable\)/);
  assert.doesNotMatch(result.stdout, /UNREACHABLE/);
});

test('named startup consumes the guarded readiness result instead of a second one-shot PING', () => {
  const setup = source.match(/^setup_storage\(\) \{\n[\s\S]*?^\}/m)?.[0];
  const readiness = source.match(/^redis_startup_ping\(\) \{\n[\s\S]*?^\}/m)?.[0] ?? '';
  assert.ok(setup);
  const result = spawnSync('bash', ['-eu'], {
    encoding: 'utf8',
    input: `
USE_REDIS=true
CAT_CAFE_ALPHA_COORDINATES=coordinates
NAMED_ALPHA_REDIS_IDENTITY=proof
SCRIPT_DIR=/fixture/scripts
REDIS_PORT=15397
REDIS_DATA_DIR=/fixture/redis
REDIS_DBFILE=dump.rdb
REDIS_PIDFILE=/fixture/redis/pid
REDIS_LOGFILE=/fixture/redis/log
GREEN= YELLOW= RED= NC=
port_is_listening() { return 1; }
ensure_redis_dirs() { :; }
archive_redis_snapshot() { :; }
redis_ping() { return 1; }
redis-server() { :; }
maybe_quarantine_stale_aof_dir() { :; }
cat_cafe_redis_start_daemon() { :; }
assert_alpha_redis_runtime_dir() { :; }
print_redis_runtime_info() { :; }
sleep() { echo BLIND_SLEEP; }
node() { echo "READINESS $2"; [ "$2" = ping-ready ]; }
${readiness}
${setup}
setup_storage
`,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /READINESS ping-ready/);
  assert.doesNotMatch(result.stdout, /BLIND_SLEEP/);
});

test('unnamed startup preserves the existing settling sleep and Redis PING', () => {
  const readiness = source.match(/^redis_startup_ping\(\) \{\n[\s\S]*?^\}/m)?.[0];
  assert.ok(readiness);
  const result = spawnSync('bash', ['-eu'], {
    encoding: 'utf8',
    input: `
CAT_CAFE_ALPHA_COORDINATES=
sleep() { echo "SLEEP $1"; }
redis_ping() { echo ORIGINAL_PING; }
node() { echo UNEXPECTED_NODE; return 1; }
${readiness}
redis_startup_ping
`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'SLEEP 1\nORIGINAL_PING\n');
});

test('unnamed startup cannot erase a failed daemon readiness with a later liveness check', () => {
  const setup = source.match(/^setup_storage\(\) \{\n[\s\S]*?^\}/m)?.[0];
  assert.ok(setup);
  const result = spawnSync('bash', ['-e'], {
    encoding: 'utf8',
    input: `
USE_REDIS=true
CAT_CAFE_ALPHA_COORDINATES=
REDIS_PORT=15397
REDIS_DATA_DIR=/fixture/redis
REDIS_DBFILE=dump.rdb
REDIS_PIDFILE=/fixture/redis/pid
REDIS_LOGFILE=/fixture/redis/log
GREEN= YELLOW= RED= NC=
ensure_redis_dirs() { :; }
archive_redis_snapshot() { :; }
redis_ping() { return 1; }
redis-server() { :; }
maybe_quarantine_stale_aof_dir() { :; }
cat_cafe_redis_start_daemon() { echo READINESS_REFUSED >&2; return 1; }
redis_startup_ping() { echo UNSAFE_LATER_CHECK; return 0; }
assert_alpha_redis_runtime_dir() { :; }
print_redis_runtime_info() { :; }
${setup}
setup_storage
echo APPLICATION_WOULD_START
`,
  });
  assert.equal(result.status, 1, result.stdout);
  assert.match(result.stderr, /READINESS_REFUSED/);
  assert.doesNotMatch(result.stdout, /UNSAFE_LATER_CHECK|APPLICATION_WOULD_START/);
});

test('capturing named Alpha Redis ownership publishes its lease before service startup', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'named-alpha-lease-wiring-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const lease = join(directory, 'lease.json');
  const result = spawnSync('bash', ['-eu'], {
    encoding: 'utf8',
    env: { ...process.env, TEST_LEASE: lease },
    input: `
SCRIPT_DIR=/fixture/scripts
CAT_CAFE_ALPHA_COORDINATES=validated-coordinate-fixture
REDIS_PORT=15397
REDIS_DATA_DIR=/fixture/alpha/.cat-cafe/redis
REDIS_PIDFILE=$REDIS_DATA_DIR/redis-15397.pid
STARTED_REDIS=false
NAMED_ALPHA_REDIS_IDENTITY=
NAMED_ALPHA_REDIS_LEASE_FILE=
CLI_PREVIEW_EXPIRES_AT_OVERRIDE=2026-10-02T07:07:30.775Z
node() {
  case "$2" in
    capture) printf '{"v":1,"pid":12001}\\n' ;;
    register) printf '%s\\n' "$4" > "$TEST_LEASE"; printf '%s\\n' "$TEST_LEASE" ;;
    *) return 91 ;;
  esac
}
${captureFunction}
named_alpha_capture_redis_identity "$REDIS_PORT" "$REDIS_DATA_DIR" "$REDIS_PIDFILE"
printf 'STARTED=%s\\nLEASE=%s\\n' "$STARTED_REDIS" "$NAMED_ALPHA_REDIS_LEASE_FILE"
`,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /STARTED=true/);
  assert.equal(existsSync(lease), true, 'a proved named Alpha must publish ownership for the gate consumer');
  assert.match(result.stdout, new RegExp(`LEASE=${lease}`));
  assert.deepEqual(JSON.parse(readFileSync(lease, 'utf8')), { v: 1, pid: 12001 });
});

test('the preview runner propagates its own expiry, overriding an inherited expiry', () => {
  const expiry = new Date(Date.now() + 30_000).toISOString();
  const result = spawnSync(
    process.execPath,
    [
      join(root, 'scripts/preview-process-lease-runner.mjs'),
      '--expires-at',
      expiry,
      '--',
      process.execPath,
      '-e',
      'console.log(process.env.CAT_CAFE_PREVIEW_EXPIRES_AT ?? "missing")',
    ],
    { encoding: 'utf8', timeout: 5_000, env: { ...process.env, CAT_CAFE_PREVIEW_EXPIRES_AT: 'forged' } },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), expiry);
});
