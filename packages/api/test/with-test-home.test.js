import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const withTestHome = resolve(__dirname, '../scripts/with-test-home.sh');

test('with-test-home forces NODE_ENV=test even when outer shell is production', () => {
  const result = spawnSync('bash', [withTestHome, 'node', '-p', 'process.env.NODE_ENV'], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'test');
});

test('with-test-home strips runtime default cat override from outer shell', () => {
  const result = spawnSync('bash', [withTestHome, 'node', '-p', 'process.env.DEFAULT_CAT_ID ?? ""'], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      DEFAULT_CAT_ID: 'codex',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

/**
 * P2-9: the global config root is a persistence coordinate exactly like the
 * runtime/workspace roots the wrapper already strips. Leaving it inherited made
 * the same suite READ different accounts depending on whether it was launched
 * from a cat's shell or a clean one — the write guard can refuse a write, but
 * it cannot stop a test from reading the operator's real config.
 */
test('with-test-home strips the inherited global config root from outer shell', () => {
  const result = spawnSync('bash', [withTestHome, 'node', '-p', 'process.env.CAT_CAFE_GLOBAL_CONFIG_ROOT ?? ""'], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      CAT_CAFE_GLOBAL_CONFIG_ROOT: '/some/inherited/store/root',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('with-test-home strips runtime API host binding from outer shell', () => {
  const result = spawnSync('bash', [withTestHome, 'node', '-p', 'process.env.API_SERVER_HOST ?? ""'], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      API_SERVER_HOST: '0.0.0.0',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('with-test-home strips the runtime Codex carrier from outer shell', () => {
  const result = spawnSync('bash', [withTestHome, 'node', '-p', 'process.env.CAT_CAFE_CODEX_CARRIER ?? ""'], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      CAT_CAFE_CODEX_CARRIER: 'app_server',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('with-test-home strips the runtime Claude carrier from outer shell', () => {
  const result = spawnSync('bash', [withTestHome, 'node', '-p', 'process.env.CAT_CAFE_CLAUDE_CARRIER ?? ""'], {
    cwd: resolve(__dirname, '..'),
    env: {
      ...process.env,
      CAT_CAFE_CLAUDE_CARRIER: 'bg_daemon',
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '');
});

test('with-test-home does not pass the live DSH installation or composition into API children', () => {
  const result = spawnSync(
    'bash',
    [
      withTestHome,
      'node',
      '-p',
      'JSON.stringify([process.env.CAT_CAFE_DSH_ROOT, process.env.CAT_CAFE_DSH_ACP_CONFIG])',
    ],
    {
      cwd: resolve(__dirname, '..'),
      env: {
        ...process.env,
        CAT_CAFE_DSH_ROOT: '/fixture/live-dsh',
        CAT_CAFE_DSH_ACP_CONFIG: '/fixture/live-cordis.yml',
      },
      encoding: 'utf8',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [null, null]);
});

/**
 * P1-13: the wrapper must own BOTH home coordinates.
 *
 * os.homedir() reads USERPROFILE on Windows and HOME everywhere else, so a
 * wrapper that exports only HOME isolates the platform it happens to run on and
 * leaves the other one pointing at the operator's real profile. The installer's
 * migrateAllLegacySources() calls homedir() directly and reads legacy
 * provider-profiles out of whatever comes back — so on Windows a wrapped test
 * run would consume the real profile as a migration source.
 *
 * The Windows resolution order cannot be executed here, but the property that
 * guarantees it — one owned directory, both names — is platform-independent and
 * asserted directly (R13 ruling 2).
 */
test('with-test-home points both home coordinates at the same wrapper-owned temp home', () => {
  const result = spawnSync(
    'bash',
    [withTestHome, 'node', '-p', 'JSON.stringify([process.env.HOME, process.env.USERPROFILE])'],
    {
      cwd: resolve(__dirname, '..'),
      env: { ...process.env, HOME: '/outer/operator/home', USERPROFILE: '/outer/operator/profile' },
      encoding: 'utf8',
    },
  );

  assert.equal(result.status, 0, result.stderr);
  const [home, userProfile] = JSON.parse(result.stdout);
  assert.match(home, /cat-cafe-test-home-/, 'HOME must be the wrapper-owned temp dir');
  assert.equal(userProfile, home, 'a split pair means one of the two home coordinates is still the operator’s own');
  assert.notEqual(userProfile, '/outer/operator/profile');
});
