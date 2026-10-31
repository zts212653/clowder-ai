import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { readRedisTestLeases } from '../../../scripts/lib/redis-test-leases.mjs';

const api = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wrapper = join(api, 'scripts/with-test-home.sh');
const run = (changes = {}) =>
  spawnSync('bash', [wrapper, process.execPath, '-p', 'process.env.REDIS_URL'], {
    cwd: api,
    env: { ...process.env, ...changes },
    encoding: 'utf8',
    timeout: 10_000,
  });
const isolated = process.env.CAT_CAFE_REDIS_TEST_ISOLATED === '1';

test('sandbox reentry preserves this live runner endpoint and per-file DB', { skip: !isolated }, () => {
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), process.env.REDIS_URL);
  assert.ok(Number(new URL(result.stdout.trim()).pathname.slice(1)) >= 15);
});

test('sandbox reentry rejects an endpoint outside its manifest DB allocation', { skip: !isolated }, () => {
  const url = new URL(process.env.REDIS_URL);
  url.pathname = '/999999';
  const result = run({ REDIS_URL: url.href });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /outside the issued manifest/);
});

test('sandbox reentry refuses a copied manifest without its exact lease', { skip: !isolated }, (t) => {
  const root = mkdtempSync(join(tmpdir(), 'redis-reentry-manifest-'));
  const manifest = join(root, 'test-files.txt');
  writeFileSync(manifest, readFileSync(process.env.CAT_CAFE_REDIS_TEST_DB_MANIFEST));
  const result = run({ CAT_CAFE_REDIS_TEST_DB_MANIFEST: manifest });
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /no unique matching manifest lease/);
  t.diagnostic(`Owned fixture retained at ${root}`);
});

test(
  'sandbox reentry rejects a stale owner birth token even with matching endpoint and manifest',
  { skip: !isolated },
  (t) => {
    const { leases } = readRedisTestLeases();
    const lease = leases.find((item) => item.port === Number(new URL(process.env.REDIS_URL).port));
    assert.ok(lease);
    const root = mkdtempSync(join(tmpdir(), 'redis-reentry-stale-'));
    mkdirSync(join(root, 'leases'));
    writeFileSync(
      join(root, 'leases/owned.json'),
      JSON.stringify({ ...lease, owner: { ...lease.owner, startedAt: 'stale-test-birth-token' } }),
    );
    const result = run({ CAT_CAFE_REDIS_TEST_REGISTRY_DIR: root });
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /not held by this live runner/);
    t.diagnostic(`Owned fixture retained at ${root}`);
  },
);
