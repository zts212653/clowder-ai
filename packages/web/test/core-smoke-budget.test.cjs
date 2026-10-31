const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const test = require('node:test');

const webRoot = resolve(__dirname, '..');
const runner = join(webRoot, 'scripts/run-with-node-env-test.mjs');
const homeOnly = { skip: !existsSync(resolve(webRoot, '../../scripts/run-with-gate-resource-permit.mjs')) };

function probe(t, held = false) {
  const root = mkdtempSync(join(tmpdir(), 'core-smoke-budget-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pressure = join(root, 'pressure.json');
  writeFileSync(pressure, JSON.stringify({ pressure: 'normal' }));
  const env = { ...process.env };
  for (const key of [
    'CAT_CAFE_MANAGED_JOB_ID',
    'CAT_CAFE_FULL_GATE_RESOURCE_PERMIT_HELD',
    'CAT_CAFE_FULL_GATE_RESOURCE_MODE',
    'CAT_CAFE_FULL_GATE_RESOURCE_STAGE',
  ])
    delete env[key];
  Object.assign(env, {
    NODE_ENV: 'production',
    CAT_CAFE_GATE_EXECUTION_SLA_MS: '9000000',
    CAT_CAFE_FULL_GATE_LOCK_PATH: join(root, 'legacy.lock'),
    CAT_CAFE_FULL_GATE_RESOURCE_DB_PATH: join(root, 'pool.sqlite'),
    CAT_CAFE_FULL_GATE_PRESSURE_FIXTURE: pressure,
    CAT_CAFE_FULL_GATE_RESOURCE_POLL_MS: '10',
    CAT_CAFE_FULL_GATE_RESOURCE_WAIT_MS: '3000',
  });
  if (held)
    Object.assign(env, {
      CAT_CAFE_FULL_GATE_RESOURCE_PERMIT_HELD: '1',
      CAT_CAFE_FULL_GATE_RESOURCE_MODE: 'exclusive',
      CAT_CAFE_FULL_GATE_RESOURCE_STAGE: 'test-web-browser',
    });
  const result = spawnSync(
    process.execPath,
    [
      runner,
      '--core-smoke',
      process.execPath,
      '-e',
      'console.log("SMOKE_PROBE:" + JSON.stringify({env:process.env.NODE_ENV, sla:process.env.CAT_CAFE_GATE_EXECUTION_SLA_MS}))',
      'test/browser/probe.mjs',
    ],
    { cwd: root, env, encoding: 'utf8', timeout: 10_000 },
  );
  assert.ifError(result.error);
  return { root, ...result };
}

test(
  'standalone smoke always admits a 5-minute execution budget, without requiring a committed checkout',
  homeOnly,
  (t) => {
    const result = probe(t);
    assert.equal(result.status, 0, result.stderr + result.stdout);
    const output = result.stdout.split('\n').find((line) => line.startsWith('SMOKE_PROBE:'));
    assert.deepEqual(JSON.parse(output.slice('SMOKE_PROBE:'.length)), { env: 'test', sla: '300000' });
    const receipts = join(result.root, 'pool.sqlite.receipts');
    const files = readdirSync(receipts).filter((file) => file.endsWith('.json'));
    assert.equal(files.length, 1, 'the smoke command acquires once');
    const receipt = JSON.parse(readFileSync(join(receipts, files[0]), 'utf8'));
    assert.equal(receipt.executionSlaMs, 300000);
    assert.equal(receipt.executionTimedOut, false);
  },
);

test('standalone smoke refuses an inherited permit that would bypass its own execution timer', homeOnly, (t) => {
  const result = probe(t, true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /core smoke requires its own resource admission/i);
  assert.doesNotMatch(result.stdout, /SMOKE_PROBE:/);
  assert.equal(existsSync(join(result.root, 'pool.sqlite')), false);
});
