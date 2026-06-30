/**
 * F254 FreshnessInvocationStateStore Tests (Phase B — B0b)
 *
 * Tests the per-invocation operational state (hot path) for freshness decisions.
 * This is the counter layer that B1 (notice frequency) and B3 (re-invoke trigger)
 * read on every tool call — must be fast (Redis HASH, not full event log query).
 *
 * Spec interface:
 *   toolCallCount: number          — tool calls this invocation
 *   noticeDeliveredCount: number   — notices delivered this invocation
 *   lastNoticeToolCallNum: number  — tool call # when last notice was delivered
 *   ackedNoticeIds: string[]       — notice IDs acked via seenCursor advance
 *   reinvokeTriggered: boolean     — whether re-invoke has been triggered
 *
 * Redis key: freshness:state:{invocationId}
 * TTL: 30 min (invocation timeout, auto-cleanup)
 *
 * Redis-backed: uses test:redis infrastructure (port 6398, DB 15).
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('F254 FreshnessInvocationStateStore', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let FreshnessInvocationStateStore;
  let createRedisClient;
  let redis;
  let store;
  let connected = false;

  const KEY_PATTERNS = ['freshness:state:*'];
  const INV_ID = 'inv-state-001';

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F254 InvocationState');

    const stateModule = await import('../dist/domains/cats/services/freshness/FreshnessInvocationStateStore.js');
    FreshnessInvocationStateStore = stateModule.FreshnessInvocationStateStore;

    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    // ioredis auto-connects; verify with ping
    await redis.ping();
    connected = true;

    store = new FreshnessInvocationStateStore(redis);
  });

  beforeEach(async () => {
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
  });

  after(async () => {
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, KEY_PATTERNS);
    await redis.quit();
  });

  // --- get ---

  it('get returns null for non-existent invocation', async () => {
    const state = await store.get('inv-nonexistent');
    assert.equal(state, null);
  });

  // --- incrementToolCallCount ---

  it('incrementToolCallCount creates state and returns 1 on first call', async () => {
    const count = await store.incrementToolCallCount(INV_ID);
    assert.equal(count, 1);

    const state = await store.get(INV_ID);
    assert.equal(state.toolCallCount, 1);
    assert.equal(state.noticeDeliveredCount, 0);
    assert.equal(state.lastNoticeToolCallNum, 0);
    assert.deepEqual(state.ackedNoticeIds, []);
    assert.equal(state.reinvokeTriggered, false);
  });

  it('incrementToolCallCount returns monotonically increasing count', async () => {
    const c1 = await store.incrementToolCallCount(INV_ID);
    const c2 = await store.incrementToolCallCount(INV_ID);
    const c3 = await store.incrementToolCallCount(INV_ID);
    assert.equal(c1, 1);
    assert.equal(c2, 2);
    assert.equal(c3, 3);
  });

  // --- recordNoticeDelivered ---

  it('recordNoticeDelivered increments noticeDeliveredCount and sets lastNoticeToolCallNum', async () => {
    // Simulate 5 tool calls then deliver notice
    for (let i = 0; i < 5; i++) await store.incrementToolCallCount(INV_ID);

    await store.recordNoticeDelivered(INV_ID, 5);

    const state = await store.get(INV_ID);
    assert.equal(state.noticeDeliveredCount, 1);
    assert.equal(state.lastNoticeToolCallNum, 5);
  });

  it('recordNoticeDelivered tracks multiple deliveries', async () => {
    for (let i = 0; i < 5; i++) await store.incrementToolCallCount(INV_ID);
    await store.recordNoticeDelivered(INV_ID, 5);

    for (let i = 0; i < 5; i++) await store.incrementToolCallCount(INV_ID);
    await store.recordNoticeDelivered(INV_ID, 10);

    const state = await store.get(INV_ID);
    assert.equal(state.noticeDeliveredCount, 2);
    assert.equal(state.lastNoticeToolCallNum, 10);
  });

  // --- recordNoticeAcked ---

  it('recordNoticeAcked adds to ackedNoticeIds', async () => {
    await store.incrementToolCallCount(INV_ID); // ensure state exists

    await store.recordNoticeAcked(INV_ID, 'notice-001');
    let state = await store.get(INV_ID);
    assert.deepEqual(state.ackedNoticeIds, ['notice-001']);

    await store.recordNoticeAcked(INV_ID, 'notice-002');
    state = await store.get(INV_ID);
    assert.deepEqual(state.ackedNoticeIds, ['notice-001', 'notice-002']);
  });

  it('recordNoticeAcked is idempotent (no duplicates)', async () => {
    await store.incrementToolCallCount(INV_ID);

    await store.recordNoticeAcked(INV_ID, 'notice-001');
    await store.recordNoticeAcked(INV_ID, 'notice-001');

    const state = await store.get(INV_ID);
    assert.deepEqual(state.ackedNoticeIds, ['notice-001']);
  });

  // --- markReinvokeTriggered ---

  it('markReinvokeTriggered sets flag to true', async () => {
    await store.incrementToolCallCount(INV_ID);

    let state = await store.get(INV_ID);
    assert.equal(state.reinvokeTriggered, false);

    await store.markReinvokeTriggered(INV_ID);

    state = await store.get(INV_ID);
    assert.equal(state.reinvokeTriggered, true);
  });

  // --- invocation isolation ---

  it('state is isolated per invocationId', async () => {
    await store.incrementToolCallCount('inv-A');
    await store.incrementToolCallCount('inv-A');
    await store.incrementToolCallCount('inv-B');

    const stateA = await store.get('inv-A');
    const stateB = await store.get('inv-B');

    assert.equal(stateA.toolCallCount, 2);
    assert.equal(stateB.toolCallCount, 1);
  });

  // --- TTL ---

  it('state has TTL for automatic cleanup (not permanent)', async () => {
    await store.incrementToolCallCount(INV_ID);

    // ioredis: ttl() auto-prepends keyPrefix (redis-pitfalls.md)
    const ttl = await redis.ttl(`freshness:state:${INV_ID}`);
    assert.ok(ttl > 0, `Expected TTL > 0 but got ${ttl}`);
    // TTL should be ≤ 30 min = 1800s
    assert.ok(ttl <= 1800, `Expected TTL <= 1800 but got ${ttl}`);
  });
});
