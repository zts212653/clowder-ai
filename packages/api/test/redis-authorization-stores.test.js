/**
 * Redis Authorization Stores tests (Rule + Pending + Audit)
 * 有 Redis → 测全量；无 Redis → skip
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;
const CLEANUP_PATTERNS = ['auth-rule:*', 'auth-rules:*', 'pending-req:*', 'pending-reqs:*', 'auth-audit:*'];

describe('RedisAuthorizationRuleStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisAuthorizationRuleStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisAuthorizationRuleStore');
    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisAuthorizationRuleStore.js');
    RedisAuthorizationRuleStore = storeModule.RedisAuthorizationRuleStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-auth-rule] Redis unreachable, skipping');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisAuthorizationRuleStore(redis);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, CLEANUP_PATTERNS);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, CLEANUP_PATTERNS);
  });

  it('add() creates rule with generated id', async () => {
    const rule = await store.add({
      catId: 'opus',
      action: 'git_commit',
      scope: 'global',
      decision: 'allow',
      createdBy: 'user-1',
    });
    assert.ok(rule.id.length > 0);
    assert.equal(rule.catId, 'opus');
    assert.equal(rule.action, 'git_commit');
    assert.equal(rule.scope, 'global');
    assert.equal(rule.decision, 'allow');
    assert.ok(rule.createdAt > 0);
  });

  it('list() returns all rules', async () => {
    await store.add({ catId: 'opus', action: 'a', scope: 'global', decision: 'allow', createdBy: 'u' });
    await store.add({ catId: 'codex', action: 'b', scope: 'global', decision: 'deny', createdBy: 'u' });

    const all = await store.list();
    assert.equal(all.length, 2);
  });

  it('list() filters by catId', async () => {
    await store.add({ catId: 'opus', action: 'a', scope: 'global', decision: 'allow', createdBy: 'u' });
    await store.add({ catId: 'codex', action: 'b', scope: 'global', decision: 'deny', createdBy: 'u' });

    const filtered = await store.list({ catId: 'opus' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].catId, 'opus');
  });

  it('remove() deletes a rule', async () => {
    const rule = await store.add({ catId: 'opus', action: 'x', scope: 'global', decision: 'allow', createdBy: 'u' });
    const removed = await store.remove(rule.id);
    assert.equal(removed, true);

    const all = await store.list();
    assert.equal(all.length, 0);
  });

  it('remove() returns false for nonexistent', async () => {
    const result = await store.remove('nonexistent');
    assert.equal(result, false);
  });

  it('match() returns exact action match', async () => {
    await store.add({ catId: 'opus', action: 'git_commit', scope: 'global', decision: 'allow', createdBy: 'u' });

    const matched = await store.match('opus', 'git_commit', 'thread-1');
    assert.ok(matched);
    assert.equal(matched.action, 'git_commit');
    assert.equal(matched.decision, 'allow');
  });

  it('match() supports glob wildcard', async () => {
    await store.add({ catId: 'opus', action: 'git_*', scope: 'global', decision: 'deny', createdBy: 'u' });

    const matched = await store.match('opus', 'git_push', 'thread-1');
    assert.ok(matched);
    assert.equal(matched.decision, 'deny');
  });

  it('match() prefers thread-scoped over global', async () => {
    await store.add({ catId: 'opus', action: 'deploy', scope: 'global', decision: 'allow', createdBy: 'u' });
    await store.add({
      catId: 'opus',
      action: 'deploy',
      scope: 'thread',
      decision: 'deny',
      createdBy: 'u',
      threadId: 'thread-1',
    });

    const matched = await store.match('opus', 'deploy', 'thread-1');
    assert.ok(matched);
    assert.equal(matched.scope, 'thread');
    assert.equal(matched.decision, 'deny');
  });

  it('match() returns null when no rule matches', async () => {
    await store.add({ catId: 'codex', action: 'test', scope: 'global', decision: 'allow', createdBy: 'u' });
    const matched = await store.match('opus', 'deploy', 'thread-1');
    assert.equal(matched, null);
  });

  it('match() supports wildcard catId', async () => {
    await store.add({ catId: '*', action: 'run_tests', scope: 'global', decision: 'allow', createdBy: 'u' });
    const matched = await store.match('gemini', 'run_tests', 'thread-1');
    assert.ok(matched);
    assert.equal(matched.decision, 'allow');
  });

  it('evicts oldest rule when maxRules reached', async () => {
    const smallStore = new RedisAuthorizationRuleStore(redis, { maxRules: 3 });
    // Clean before using smallStore
    await cleanupPrefixedRedisKeys(redis, CLEANUP_PATTERNS);

    const r1 = await smallStore.add({
      catId: 'opus',
      action: 'a1',
      scope: 'global',
      decision: 'allow',
      createdBy: 'u',
    });
    await smallStore.add({ catId: 'opus', action: 'a2', scope: 'global', decision: 'allow', createdBy: 'u' });
    await smallStore.add({ catId: 'opus', action: 'a3', scope: 'global', decision: 'allow', createdBy: 'u' });
    // Should evict r1
    await smallStore.add({ catId: 'opus', action: 'a4', scope: 'global', decision: 'allow', createdBy: 'u' });

    const all = await smallStore.list();
    assert.equal(all.length, 3);
    assert.ok(!all.find((r) => r.id === r1.id), 'oldest rule should be evicted');
  });
});

describe('RedisPendingRequestStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisPendingRequestStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisPendingRequestStore');
    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisPendingRequestStore.js');
    RedisPendingRequestStore = storeModule.RedisPendingRequestStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-pending-req] Redis unreachable, skipping');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisPendingRequestStore(redis);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, CLEANUP_PATTERNS);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, CLEANUP_PATTERNS);
  });

  it('create() returns record with waiting status', async () => {
    const record = await store.create({
      invocationId: 'inv-1',
      catId: 'opus',
      threadId: 'thread-1',
      action: 'git_commit',
      reason: 'Need to commit code',
    });
    assert.ok(record.requestId.length > 0);
    assert.equal(record.status, 'waiting');
    assert.equal(record.catId, 'opus');
    assert.equal(record.action, 'git_commit');
    assert.ok(record.createdAt > 0);
  });

  it('get() returns created record', async () => {
    const created = await store.create({
      invocationId: 'inv-1',
      catId: 'opus',
      threadId: 'thread-1',
      action: 'test',
      reason: 'testing',
    });
    const fetched = await store.get(created.requestId);
    assert.ok(fetched);
    assert.equal(fetched.requestId, created.requestId);
    assert.equal(fetched.status, 'waiting');
  });

  it('get() returns null for nonexistent', async () => {
    const result = await store.get('nonexistent');
    assert.equal(result, null);
  });

  it('respond() updates status to granted', async () => {
    const record = await store.create({
      invocationId: 'inv-1',
      catId: 'opus',
      threadId: 'thread-1',
      action: 'deploy',
      reason: 'need deploy',
    });

    const updated = await store.respond(record.requestId, 'granted', 'thread', 'approved by admin');
    assert.ok(updated);
    assert.equal(updated.status, 'granted');
    assert.equal(updated.respondScope, 'thread');
    assert.equal(updated.respondReason, 'approved by admin');
    assert.ok(updated.respondedAt > 0);
  });

  it('respond() returns null for already-responded', async () => {
    const record = await store.create({
      invocationId: 'inv-1',
      catId: 'opus',
      threadId: 'thread-1',
      action: 'deploy',
      reason: 'need deploy',
    });
    await store.respond(record.requestId, 'denied', 'once');
    const second = await store.respond(record.requestId, 'granted', 'global');
    assert.equal(second, null);
  });

  it('respond() returns null for nonexistent', async () => {
    const result = await store.respond('nonexistent', 'granted', 'once');
    assert.equal(result, null);
  });

  it('listWaiting() returns only waiting records', async () => {
    await store.create({ invocationId: 'i1', catId: 'opus', threadId: 't1', action: 'a', reason: 'r' });
    const rec2 = await store.create({ invocationId: 'i2', catId: 'opus', threadId: 't1', action: 'b', reason: 'r' });
    await store.create({ invocationId: 'i3', catId: 'opus', threadId: 't1', action: 'c', reason: 'r' });

    // Respond to one
    await store.respond(rec2.requestId, 'denied', 'once');

    const waiting = await store.listWaiting();
    assert.equal(waiting.length, 2);
    assert.ok(waiting.every((r) => r.status === 'waiting'));
  });

  it('listWaiting() filters by threadId', async () => {
    await store.create({ invocationId: 'i1', catId: 'opus', threadId: 't1', action: 'a', reason: 'r' });
    await store.create({ invocationId: 'i2', catId: 'opus', threadId: 't2', action: 'b', reason: 'r' });

    const t1 = await store.listWaiting('t1');
    assert.equal(t1.length, 1);
    assert.equal(t1[0].threadId, 't1');
  });

  it('context field persists through create/get', async () => {
    const record = await store.create({
      invocationId: 'i1',
      catId: 'opus',
      threadId: 't1',
      action: 'deploy',
      reason: 'need deploy',
      context: 'production environment',
    });

    const fetched = await store.get(record.requestId);
    assert.equal(fetched.context, 'production environment');
  });

  it('concurrent respond(): only one wins (Lua CAS atomic)', async () => {
    const record = await store.create({
      invocationId: 'i-race',
      catId: 'opus',
      threadId: 't-race',
      action: 'deploy',
      reason: 'concurrent test',
    });

    // Fire N concurrent responds on the same requestId
    const N = 20;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        store.respond(record.requestId, i % 2 === 0 ? 'granted' : 'denied', 'once', `reason-${i}`),
      ),
    );

    const winners = results.filter((r) => r !== null);
    const losers = results.filter((r) => r === null);
    assert.equal(winners.length, 1, `Expected exactly 1 winner, got ${winners.length}`);
    assert.equal(losers.length, N - 1);

    // Final state in Redis must match the single winner
    const final = await store.get(record.requestId);
    assert.equal(final.status, winners[0].status);
    assert.equal(final.respondReason, winners[0].respondReason);
    assert.notEqual(final.status, 'waiting');
  });

  it('verified get() after respond() reads updated state from Redis', async () => {
    const record = await store.create({
      invocationId: 'i1',
      catId: 'opus',
      threadId: 't1',
      action: 'a',
      reason: 'r',
    });
    await store.respond(record.requestId, 'granted', 'global', 'ok');

    // Re-read from Redis
    const fromRedis = await store.get(record.requestId);
    assert.equal(fromRedis.status, 'granted');
    assert.equal(fromRedis.respondScope, 'global');
    assert.equal(fromRedis.respondReason, 'ok');
    assert.ok(fromRedis.respondedAt > 0);
  });
});

describe('RedisAuthorizationAuditStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisAuthorizationAuditStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'RedisAuthorizationAuditStore');
    const storeModule = await import('../dist/domains/cats/services/stores/redis/RedisAuthorizationAuditStore.js');
    RedisAuthorizationAuditStore = storeModule.RedisAuthorizationAuditStore;
    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[redis-auth-audit] Redis unreachable, skipping');
      await redis.quit().catch(() => {});
      return;
    }
    store = new RedisAuthorizationAuditStore(redis);
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, CLEANUP_PATTERNS);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, CLEANUP_PATTERNS);
  });

  it('append() creates audit entry with generated id', async () => {
    const entry = await store.append({
      requestId: 'req-1',
      invocationId: 'inv-1',
      catId: 'opus',
      threadId: 'thread-1',
      action: 'git_commit',
      reason: 'need commit',
      decision: 'allow',
      decidedBy: 'user-1',
    });
    assert.ok(entry.id.length > 0);
    assert.equal(entry.catId, 'opus');
    assert.equal(entry.decision, 'allow');
    assert.ok(entry.createdAt > 0);
    assert.ok(entry.decidedAt > 0);
  });

  it('list() returns entries newest-first', async () => {
    await store.append({
      requestId: 'r1',
      invocationId: 'i1',
      catId: 'opus',
      threadId: 't1',
      action: 'a',
      reason: 'r',
      decision: 'allow',
    });
    await store.append({
      requestId: 'r2',
      invocationId: 'i2',
      catId: 'codex',
      threadId: 't1',
      action: 'b',
      reason: 'r',
      decision: 'deny',
    });

    const all = await store.list();
    assert.equal(all.length, 2);
    // Newest first
    assert.ok(all[0].createdAt >= all[1].createdAt);
  });

  it('list() filters by catId', async () => {
    await store.append({
      requestId: 'r1',
      invocationId: 'i1',
      catId: 'opus',
      threadId: 't1',
      action: 'a',
      reason: 'r',
      decision: 'allow',
    });
    await store.append({
      requestId: 'r2',
      invocationId: 'i2',
      catId: 'codex',
      threadId: 't1',
      action: 'b',
      reason: 'r',
      decision: 'deny',
    });

    const filtered = await store.list({ catId: 'opus' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].catId, 'opus');
  });

  it('list() filters by threadId', async () => {
    await store.append({
      requestId: 'r1',
      invocationId: 'i1',
      catId: 'opus',
      threadId: 't1',
      action: 'a',
      reason: 'r',
      decision: 'allow',
    });
    await store.append({
      requestId: 'r2',
      invocationId: 'i2',
      catId: 'opus',
      threadId: 't2',
      action: 'b',
      reason: 'r',
      decision: 'deny',
    });

    const filtered = await store.list({ threadId: 't2' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].threadId, 't2');
  });

  it('list() respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await store.append({
        requestId: `r${i}`,
        invocationId: `i${i}`,
        catId: 'opus',
        threadId: 't1',
        action: `a${i}`,
        reason: 'r',
        decision: 'allow',
      });
    }

    const limited = await store.list({ limit: 3 });
    assert.equal(limited.length, 3);
  });

  it('evicts oldest entries when maxEntries reached', async () => {
    const smallStore = new RedisAuthorizationAuditStore(redis, { maxEntries: 5 });
    await cleanupPrefixedRedisKeys(redis, CLEANUP_PATTERNS);

    for (let i = 0; i < 5; i++) {
      await smallStore.append({
        requestId: `r${i}`,
        invocationId: `i${i}`,
        catId: 'opus',
        threadId: 't1',
        action: `a${i}`,
        reason: 'r',
        decision: 'allow',
      });
    }

    // Adding one more should evict oldest 20%
    await smallStore.append({
      requestId: 'r5',
      invocationId: 'i5',
      catId: 'opus',
      threadId: 't1',
      action: 'a5',
      reason: 'r',
      decision: 'allow',
    });

    const all = await smallStore.list({ limit: 100 });
    assert.ok(all.length <= 5, `Expected at most 5 entries after eviction, got ${all.length}`);
  });

  it('scope and matchedRuleId persist', async () => {
    const entry = await store.append({
      requestId: 'r1',
      invocationId: 'i1',
      catId: 'opus',
      threadId: 't1',
      action: 'deploy',
      reason: 'need deploy',
      decision: 'allow',
      scope: 'thread',
      matchedRuleId: 'rule-xyz',
    });

    const [fetched] = await store.list();
    assert.equal(fetched.id, entry.id);
    assert.equal(fetched.scope, 'thread');
    assert.equal(fetched.matchedRuleId, 'rule-xyz');
  });
});
