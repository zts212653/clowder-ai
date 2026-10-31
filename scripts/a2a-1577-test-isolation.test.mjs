import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { test } from 'node:test';

const wrapper = resolve('packages/api/scripts/with-test-home.sh');
function projectedEnv(overrides = {}) {
  const result = spawnSync(
    'bash',
    [
      wrapper,
      process.execPath,
      '-e',
      'process.stdout.write(JSON.stringify({url:process.env.REDIS_URL,port:process.env.REDIS_PORT,data:process.env.REDIS_DATA_DIR,backup:process.env.REDIS_BACKUP_DIR,prefix:process.env.REDIS_KEY_PREFIX}))',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        CAT_CAFE_REDIS_TEST_ISOLATED: '',
        REDIS_URL: 'redis://127.0.0.1:6399',
        REDIS_PORT: '6399',
        REDIS_DATA_DIR: '/never-open-runtime-data',
        REDIS_BACKUP_DIR: '/never-open-runtime-backups',
        REDIS_KEY_PREFIX: 'runtime:',
        ...overrides,
      },
    },
  );
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('test wrapper defaults to a non-connectable Redis endpoint, not a shared dev port or sanctuary fallback', () => {
  assert.deepEqual(projectedEnv(), { url: 'redis://127.0.0.1:0' });
});

test('explicit owned-isolated Redis test retains its supplied binding', () => {
  assert.deepEqual(
    projectedEnv({
      CAT_CAFE_REDIS_TEST_ISOLATED: '1',
      REDIS_URL: 'redis://127.0.0.1:65432/15',
      REDIS_PORT: '65432',
      REDIS_DATA_DIR: '/never-open-owned-test-data',
      REDIS_BACKUP_DIR: '/never-open-owned-test-backups',
      REDIS_KEY_PREFIX: 'test-owned:',
    }),
    {
      url: 'redis://127.0.0.1:65432/15',
      port: '65432',
      data: '/never-open-owned-test-data',
      backup: '/never-open-owned-test-backups',
      prefix: 'test-owned:',
    },
  );
});
