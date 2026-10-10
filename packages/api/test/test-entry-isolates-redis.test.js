// A test run must never reach the running instance's Redis. On 09-25 a public test run launched from a
// cat's shell inherited the instance's REDIS_URL, and five suites that trusted any address but 6399 wrote
// their test keys into live Redis. Two guards keep that from coming back:
// 1. the test entry (with-test-home.sh) drops inherited Redis settings unless the caller set up an
//    isolated test Redis and said so with CAT_CAFE_REDIS_TEST_ISOLATED=1;
// 2. every test file that reads REDIS_URL gates on that isolation (or is one of the listed exceptions),
//    and none falls back to a fixed address.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const API_DIR = dirname(TEST_DIR);

function childRedisEnv(extraEnv) {
  const env = { ...process.env, ...extraEnv };
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key];
  const out = execFileSync(
    'bash',
    [
      join(API_DIR, 'scripts/with-test-home.sh'),
      process.execPath,
      '-e',
      'console.log(JSON.stringify(Object.fromEntries(["REDIS_URL","REDIS_PORT","REDIS_KEY_PREFIX"].map((k) => [k, process.env[k] ?? null]))))',
    ],
    { env, encoding: 'utf8' },
  );
  return JSON.parse(out.trim().split('\n').at(-1));
}

describe('test entry Redis isolation', () => {
  it('drops an inherited runtime Redis address', () => {
    const seen = childRedisEnv({
      REDIS_URL: 'redis://localhost:6099',
      REDIS_PORT: '6099',
      REDIS_KEY_PREFIX: 'cat-cafe:',
      CAT_CAFE_REDIS_TEST_ISOLATED: undefined,
    });
    assert.deepEqual(seen, { REDIS_URL: 'redis://127.0.0.1:0', REDIS_PORT: null, REDIS_KEY_PREFIX: null });
  });

  it('passes an isolated test Redis through when the caller vouches for it', () => {
    const seen = childRedisEnv({ REDIS_URL: 'redis://127.0.0.1:6583/15', CAT_CAFE_REDIS_TEST_ISOLATED: '1' });
    assert.equal(seen.REDIS_URL, 'redis://127.0.0.1:6583/15');
  });
});

/** Files that read REDIS_URL or open a Redis client without the isolation gate, and why that is safe. */
const EXCEPTIONS = {
  'with-test-home.test.js': 'probes child environment only; never creates or connects a Redis client',
  'a2a-1577-turn-redis-seam.test.mjs':
    'owns its random-directory Unix socket child with port 0; SAVE and retains all artifacts',
  'plugin-external-runtime-package.test.js': 'sets a fake REDIS_URL to prove it does not leak; never connects',
  'auth-invocation-restart.test.js': 'connects only when REDIS_URL names the dedicated :6398 dev Redis',
  'harness-eval/eval-domain-trigger-store-redis.test.js':
    'connects only when REDIS_URL names the dedicated :6398 dev Redis',
};

function testFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : testFiles(path);
    return /\.test\.(js|mjs|cjs|ts)$/.test(name) ? [path] : [];
  });
}

describe('Redis-backed test files', () => {
  // A file is in scope when it reads REDIS_URL or opens a Redis client at all: a hard-coded address
  // reaches live data just as surely as an inherited one.
  const readers = testFiles(TEST_DIR)
    .map((path) => ({ file: relative(TEST_DIR, path), source: readFileSync(path, 'utf8') }))
    .filter(({ source }) => /process\.env\.REDIS_URL|new Redis\(|createRedisClient\(/.test(source));

  it('never fall back to a fixed Redis address', () => {
    const fallbacks = readers
      .filter(({ source }) => /process\.env\.REDIS_URL\s*(\|\||\?\?)\s*['"`]redis:/.test(source))
      .map(({ file }) => file);
    assert.deepEqual(fallbacks, []);
  });

  it('only run against an isolated test Redis', () => {
    const ungated = readers
      .filter(({ file, source }) => {
        if (EXCEPTIONS[file]) return false;
        return !/redisIsolationSkipReason|assertRedisIsolationOrThrow|CAT_CAFE_REDIS_TEST_ISOLATED/.test(source);
      })
      .map(({ file }) => file);
    assert.deepEqual(ungated, []);
  });
});
