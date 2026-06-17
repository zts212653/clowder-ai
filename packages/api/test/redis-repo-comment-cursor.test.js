/**
 * F168 Phase C — C0.3 RepoCommentCursorStore Redis tests
 *
 * Per-repo collection cursor for the repo-level comment poller. The cursor is the
 * max comment `updatedAt` (ISO-8601) observed per repo, used as the `since` lower
 * bound on the next poll. Validates:
 *   1. read returns undefined when no cursor stored (first poll)
 *   2. write → read round-trips the persisted cursor
 *   3. cursors are per-repo isolated (key carries repo)
 *   4. cursor is persisted WITHOUT TTL — an expiring cursor would reset the `since`
 *      bound and cause the poller to re-scan + re-dedup full history (polling churn)
 *
 * 有 Redis → 真实 Redis-backed 验证；无 Redis → skip
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('RepoCommentCursorStore (Redis)', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisRepoCommentCursorStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  const KEY_PATTERNS = ['community:repo-comment:cursor:*'];

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RepoCommentCursorStore');

    const mod = await import('../dist/infrastructure/connectors/github-repo-event/RepoCommentCursorStore.js');
    RedisRepoCommentCursorStore = mod.RedisRepoCommentCursorStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient(REDIS_URL);
    await redis.ping();
    connected = true;
    store = new RedisRepoCommentCursorStore(redis);
  });

  after(async () => {
    if (connected) await redis.quit();
  });

  beforeEach(async () => {
    await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
  });

  it('read returns undefined when no cursor stored (first poll)', async () => {
    assert.equal(await store.read('owner/repo'), undefined);
  });

  it('write then read round-trips the persisted cursor', async () => {
    await store.write('owner/repo', '2026-06-13T10:00:00Z');
    assert.equal(await store.read('owner/repo'), '2026-06-13T10:00:00Z');
  });

  it('cursors are per-repo isolated', async () => {
    await store.write('owner/repo-a', '2026-06-13T10:00:00Z');
    await store.write('owner/repo-b', '2026-06-13T20:00:00Z');
    assert.equal(await store.read('owner/repo-a'), '2026-06-13T10:00:00Z');
    assert.equal(await store.read('owner/repo-b'), '2026-06-13T20:00:00Z');
  });

  it('persists cursor WITHOUT TTL (an expiring cursor would cause re-scan churn)', async () => {
    await store.write('owner/repo', '2026-06-13T10:00:00Z');
    // store + this assertion use the same client → same ioredis keyPrefix → same key.
    const ttl = await redis.ttl('community:repo-comment:cursor:owner/repo');
    assert.equal(ttl, -1); // -1 = key exists, no expiry set
  });
});
