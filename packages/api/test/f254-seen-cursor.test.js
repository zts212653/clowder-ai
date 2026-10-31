/**
 * F254 SeenCursor Tests (Phase A — Layer 1)
 *
 * Tests the independent seenCursor namespace in DeliveryCursorStore.
 * seenCursor tracks "what the cat actually READ mid-turn", independent from
 * deliveryCursor (which tracks "what the harness DELIVERED at invoke-time").
 *
 * AC-A9 (CRITICAL): pushing seenCursor must NOT affect deliveryCursor or
 * incremental message injection — the two cursors are independent.
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

describe('F254 SeenCursor', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let DeliveryCursorStore;
  let SessionStore;
  let createRedisClient;
  let redis;
  let sessionStore;
  let store;
  let connected = false;

  const SEEN_PATTERNS = ['seen-cursor:*', 'delivery-cursor:*', 'mention-ack:*'];

  const userId = 'test-user-f254';
  const catId = 'opus';
  const threadId = 'thread-f254-test';

  // Lexicographically sortable message IDs (timestamp-seq-uuid)
  const msgId1 = '0000000000000001-000001-aaaaaaaa';
  const msgId2 = '0000000000000002-000001-bbbbbbbb';
  const msgId3 = '0000000000000003-000001-cccccccc';

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F254 SeenCursor');

    const storeModule = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
    DeliveryCursorStore = storeModule.DeliveryCursorStore;

    const redisModule = await import('@cat-cafe/shared/utils');
    createRedisClient = redisModule.createRedisClient;
    SessionStore = redisModule.SessionStore;

    redis = createRedisClient({ url: REDIS_URL });
    await redis.ping();
    connected = true;
    sessionStore = new SessionStore(redis);
    store = new DeliveryCursorStore(sessionStore);
  });

  beforeEach(async () => {
    if (connected) {
      await cleanupPrefixedRedisKeys(redis, SEEN_PATTERNS);
      // Fresh store instance to reset in-memory cursor caches
      // (DeliveryCursorStore caches seenCursors/deliveryCursors in Maps
      // that persist across tests if the instance is reused)
      store = new DeliveryCursorStore(sessionStore);
    }
  });

  after(async () => {
    if (connected) {
      await cleanupPrefixedRedisKeys(redis, SEEN_PATTERNS);
      await redis.quit();
    }
  });

  // --- Basic seenCursor operations ---

  it('getSeenCursor returns undefined when no cursor exists', async () => {
    const cursor = await store.getSeenCursor(userId, catId, threadId);
    assert.equal(cursor, undefined);
  });

  it('ackSeenCursor sets cursor, getSeenCursor returns it', async () => {
    await store.ackSeenCursor(userId, catId, threadId, msgId1);
    const cursor = await store.getSeenCursor(userId, catId, threadId);
    assert.equal(cursor, msgId1);
  });

  it('ackSeenCursor is monotonic — only moves forward', async () => {
    await store.ackSeenCursor(userId, catId, threadId, msgId2);
    // Try to regress to msgId1 (earlier)
    await store.ackSeenCursor(userId, catId, threadId, msgId1);
    const cursor = await store.getSeenCursor(userId, catId, threadId);
    assert.equal(cursor, msgId2, 'cursor should not regress to earlier message');
  });

  it('ackSeenCursor advances forward', async () => {
    await store.ackSeenCursor(userId, catId, threadId, msgId1);
    await store.ackSeenCursor(userId, catId, threadId, msgId3);
    const cursor = await store.getSeenCursor(userId, catId, threadId);
    assert.equal(cursor, msgId3, 'cursor should advance to later message');
  });

  // --- AC-A9: seenCursor isolation from deliveryCursor (CRITICAL) ---

  it('AC-A9: pushing seenCursor does NOT affect deliveryCursor', async () => {
    // Set delivery cursor to msgId1
    await store.ackCursor(userId, catId, threadId, msgId1);
    const deliveryBefore = await store.getCursor(userId, catId, threadId);
    assert.equal(deliveryBefore, msgId1, 'delivery cursor should be set');

    // Push seen cursor to msgId3 (ahead of delivery)
    await store.ackSeenCursor(userId, catId, threadId, msgId3);

    // Verify delivery cursor is UNCHANGED
    const deliveryAfter = await store.getCursor(userId, catId, threadId);
    assert.equal(
      deliveryAfter,
      msgId1,
      'CRITICAL: delivery cursor must NOT move when seenCursor is pushed — ' +
        'this would cause incremental injection to skip messages',
    );
  });

  it('AC-A9: pushing deliveryCursor does NOT affect seenCursor', async () => {
    // Set seen cursor to msgId1
    await store.ackSeenCursor(userId, catId, threadId, msgId1);
    const seenBefore = await store.getSeenCursor(userId, catId, threadId);
    assert.equal(seenBefore, msgId1, 'seen cursor should be set');

    // Push delivery cursor to msgId3 (ahead of seen)
    await store.ackCursor(userId, catId, threadId, msgId3);

    // Verify seen cursor is UNCHANGED
    const seenAfter = await store.getSeenCursor(userId, catId, threadId);
    assert.equal(
      seenAfter,
      msgId1,
      'CRITICAL: seen cursor must NOT move when deliveryCursor is pushed — ' + 'they are independent namespaces',
    );
  });

  it('AC-A9: Redis keys are truly separate (direct key inspection)', async () => {
    await store.ackCursor(userId, catId, threadId, msgId1);
    await store.ackSeenCursor(userId, catId, threadId, msgId2);

    // Directly inspect Redis keys to verify separate namespaces
    const deliveryKey = `delivery-cursor:${userId}:${catId}:${threadId}`;
    const seenKey = `seen-cursor:${userId}:${catId}:${threadId}`;

    const deliveryVal = await redis.get(deliveryKey);
    const seenVal = await redis.get(seenKey);

    assert.equal(deliveryVal, msgId1, 'delivery key should hold msgId1');
    assert.equal(seenVal, msgId2, 'seen key should hold msgId2');
    assert.notEqual(deliveryVal, seenVal, 'keys must hold different values');
  });

  // --- Cleanup ---

  it('deleteByThreadForUser cleans up seenCursors too', async () => {
    await store.ackSeenCursor(userId, catId, threadId, msgId2);
    const before = await store.getSeenCursor(userId, catId, threadId);
    assert.equal(before, msgId2);

    await store.deleteByThreadForUser(userId, threadId);

    const after = await store.getSeenCursor(userId, catId, threadId);
    assert.equal(after, undefined, 'seenCursor should be cleaned up on thread delete');
  });
});
