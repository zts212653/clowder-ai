/**
 * Shared helpers for Redis integration tests.
 * Enforces isolated test Redis and provides keyPrefix-safe cleanup.
 */

const ISOLATION_FLAG = 'CAT_CAFE_REDIS_TEST_ISOLATED';

function parseRedisUrl(redisUrl) {
  try {
    return new URL(redisUrl);
  } catch {
    return null;
  }
}

/**
 * Guardrail: Redis integration tests must run against isolated local Redis.
 */
export function assertRedisIsolationOrThrow(redisUrl, suiteName) {
  if (!redisUrl) return;

  if (process.env[ISOLATION_FLAG] !== '1') {
    throw new Error(
      `[${suiteName}] REDIS_URL is set without ${ISOLATION_FLAG}=1. ` +
        'Run via: pnpm --filter @cat-cafe/api test:redis',
    );
  }

  const parsed = parseRedisUrl(redisUrl);
  if (!parsed) {
    throw new Error(`[${suiteName}] Invalid REDIS_URL: ${redisUrl}`);
  }

  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    throw new Error(`[${suiteName}] REDIS_URL must point to localhost for tests, got hostname=${parsed.hostname}`);
  }

  const db = parsed.pathname.replace('/', '') || '0';
  if (db !== '15') {
    throw new Error(`[${suiteName}] REDIS_URL must use /15 test DB for isolation, got /${db}`);
  }
}

/**
 * Shared skip reason for Redis integration suites in the default test run.
 * These suites should only execute when the isolated Redis guard is explicitly enabled.
 */
export function redisIsolationSkipReason(redisUrl) {
  if (!redisUrl) return 'REDIS_URL not set';
  if (process.env[ISOLATION_FLAG] !== '1') return 'Redis isolation flag not set';
  return false;
}

function normalizePattern(pattern) {
  return pattern.replace(/^cat-cafe:/, '');
}

/**
 * Cleanup helper that works with ioredis keyPrefix and legacy double-prefix leftovers.
 */
export async function cleanupPrefixedRedisKeys(redis, patterns) {
  const normalized = patterns.map(normalizePattern);
  const expandedPatterns = normalized.flatMap((pattern) => [`cat-cafe:${pattern}`, `cat-cafe:cat-cafe:${pattern}`]);

  const grouped = await Promise.all(expandedPatterns.map((pattern) => redis.keys(pattern)));
  const prefixedKeys = [...new Set(grouped.flat())];
  if (prefixedKeys.length === 0) return 0;

  const stripped = prefixedKeys.map((key) => key.replace(/^cat-cafe:/, ''));
  return redis.del(...stripped);
}

/**
 * Cleanup all keys under the client's OWN keyPrefix namespace.
 *
 * Use with a per-file unique keyPrefix to isolate concurrent test files. Fixes the
 * cross-file wildcard cleanup race (plan:237): event-log-redis cleans `ballcustody:events:*`
 * while projector-redis cleans `ballcustody:*` — under `node --test` file-level concurrency
 * the projector's wildcard wipes event-log's keys mid-test → 6 fail.
 *
 * ioredis caveat (redis-pitfalls.md): `keys(pattern)` does NOT auto-prepend keyPrefix and
 * returns raw keys (with prefix). So match raw `{prefix}*`, then strip the prefix before
 * `del()` (which DOES re-prepend keyPrefix).
 *
 * Guard: requires a non-empty keyPrefix — refuses to run on a bare client to avoid wiping
 * the whole DB.
 */
export async function cleanupClientKeyspace(redis) {
  const prefix = redis.options?.keyPrefix ?? '';
  if (!prefix) {
    throw new Error('cleanupClientKeyspace requires a non-empty client keyPrefix (isolation guard)');
  }
  const found = await redis.keys(`${prefix}*`);
  if (found.length === 0) return 0;
  const stripped = found.map((key) => key.slice(prefix.length));
  return redis.del(...stripped);
}
