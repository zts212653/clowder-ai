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
