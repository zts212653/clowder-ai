/**
 * WT-5 Reliability: concurrent fault drills (4 scenarios x 2 levels).
 *
 * Scenarios:
 * 1) CAS race on InvocationRecord status update
 * 2) Update vs delete race (delete winner must not leave orphan/revive data)
 * 3) Delivery cursor ack vs message append race
 * 4) Idempotency key race on invocation create
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { DeliveryCursorStore } from '../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

function invocationCreateInput(idempotencyKey, threadId = 'thread-race') {
  return {
    threadId,
    userId: 'user-race',
    targetCats: ['opus'],
    intent: 'execute',
    idempotencyKey,
  };
}

describe('Concurrent fault drills - in-memory stores', () => {
  it('S1 CAS race: queued→running vs queued→canceled, only one wins', async () => {
    const store = new InvocationRecordStore();
    const { invocationId } = store.create(invocationCreateInput('mem-cas-race'));

    const results = await Promise.all([
      Promise.resolve().then(() => store.update(invocationId, { status: 'running', expectedStatus: 'queued' })),
      Promise.resolve().then(() => store.update(invocationId, { status: 'canceled', expectedStatus: 'queued' })),
    ]);

    const winners = results.filter((r) => r !== null);
    const losers = results.filter((r) => r === null);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);

    const finalRecord = store.get(invocationId);
    assert.ok(finalRecord);
    assert.ok(
      finalRecord.status === 'running' || finalRecord.status === 'canceled',
      `unexpected final status: ${finalRecord.status}`,
    );
  });

  it('S2 update vs delete race: delete winner is final (no revive)', async () => {
    const threadStore = new ThreadStore();
    const thread = threadStore.create('user-race', 'race-thread');

    const deletePromise = Promise.resolve().then(() => threadStore.delete(thread.id));
    const updatePromise = Promise.resolve().then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      threadStore.updateTitle(thread.id, 'revive-attempt');
    });

    await Promise.all([deletePromise, updatePromise]);
    assert.equal(threadStore.get(thread.id), null);
  });

  it('S3 ack vs append race: cursor does not skip or duplicate messages', async () => {
    const messageStore = new MessageStore();
    const deliveryCursorStore = new DeliveryCursorStore();
    const userId = 'user-race';
    const catId = 'opus';
    const threadId = 'thread-race-cursor';
    const baseTs = Date.now();

    const base = messageStore.append({
      userId,
      catId: null,
      content: 'base',
      mentions: [],
      timestamp: baseTs,
      threadId,
    });

    const appendPromise = Promise.resolve().then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return messageStore.append({
        userId,
        catId: null,
        content: 'new-after-ack',
        mentions: [],
        timestamp: baseTs + 1,
        threadId,
      });
    });
    const ackPromise = Promise.resolve().then(() => deliveryCursorStore.ackCursor(userId, catId, threadId, base.id));

    const [newMsg] = await Promise.all([appendPromise, ackPromise]);
    const cursor = await deliveryCursorStore.getCursor(userId, catId, threadId);
    assert.equal(cursor, base.id);

    const firstWindow = messageStore.getByThreadAfter(threadId, cursor, undefined, userId);
    assert.deepEqual(
      firstWindow.map((m) => m.id),
      [newMsg.id],
    );

    await deliveryCursorStore.ackCursor(userId, catId, threadId, newMsg.id);
    const secondCursor = await deliveryCursorStore.getCursor(userId, catId, threadId);
    assert.equal(secondCursor, newMsg.id);

    const secondWindow = messageStore.getByThreadAfter(threadId, secondCursor, undefined, userId);
    assert.equal(secondWindow.length, 0);
  });

  it('S4 idempotency key race: only one create succeeds', async () => {
    const store = new InvocationRecordStore();
    const N = 20;
    const idempotencyKey = 'mem-idemp-race';

    const results = await Promise.all(
      Array.from({ length: N }, () =>
        Promise.resolve().then(() => store.create(invocationCreateInput(idempotencyKey))),
      ),
    );

    const created = results.filter((r) => r.outcome === 'created');
    const duplicates = results.filter((r) => r.outcome === 'duplicate');
    const uniqueInvocationIds = new Set(results.map((r) => r.invocationId));

    assert.equal(created.length, 1);
    assert.equal(duplicates.length, N - 1);
    assert.equal(uniqueInvocationIds.size, 1);
  });
});

describe('Concurrent fault drills - Redis stores', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let createRedisClient;
  let SessionStore;
  let RedisInvocationRecordStore;
  let RedisThreadStore;
  let RedisMessageStore;
  let ThreadKeys;
  let redis;
  let connected = false;

  const cleanupPatterns = [
    'invoc:*',
    'idemp:*',
    'thread:*',
    'threads:user:*',
    'msg:*',
    'delivery-cursor:*',
    'mention-ack:*',
  ];

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'concurrent-fault-drill');

    const shared = await import('@cat-cafe/shared/utils');
    createRedisClient = shared.createRedisClient;
    SessionStore = shared.SessionStore;

    const invocMod = await import('../dist/domains/cats/services/stores/redis/RedisInvocationRecordStore.js');
    const threadMod = await import('../dist/domains/cats/services/stores/redis/RedisThreadStore.js');
    const messageMod = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    const threadKeyMod = await import('../dist/domains/cats/services/stores/redis-keys/thread-keys.js');

    RedisInvocationRecordStore = invocMod.RedisInvocationRecordStore;
    RedisThreadStore = threadMod.RedisThreadStore;
    RedisMessageStore = messageMod.RedisMessageStore;
    ThreadKeys = threadKeyMod.ThreadKeys;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[concurrent-fault-drill.test] Redis unreachable, skipping Redis drills');
      await redis.quit().catch(() => {});
    }
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, cleanupPatterns);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, cleanupPatterns);
  });

  it('S1 CAS race: queued→running vs queued→canceled, only one wins', async () => {
    const store = new RedisInvocationRecordStore(redis);
    const { invocationId } = await store.create(invocationCreateInput('redis-cas-race'));

    const results = await Promise.all([
      store.update(invocationId, { status: 'running', expectedStatus: 'queued' }),
      store.update(invocationId, { status: 'canceled', expectedStatus: 'queued' }),
    ]);

    const winners = results.filter((r) => r !== null);
    const losers = results.filter((r) => r === null);
    assert.equal(winners.length, 1);
    assert.equal(losers.length, 1);

    const finalRecord = await store.get(invocationId);
    assert.ok(finalRecord);
    assert.ok(
      finalRecord.status === 'running' || finalRecord.status === 'canceled',
      `unexpected final status: ${finalRecord.status}`,
    );
  });

  it('S2 update vs delete race: delete winner leaves no orphan key', async () => {
    const threadStore = new RedisThreadStore(redis);
    const thread = await threadStore.create('user-race', 'redis-race-thread');

    const deletePromise = threadStore.delete(thread.id);
    const updatePromise = Promise.resolve().then(async () => {
      await deletePromise;
      await threadStore.updateTitle(thread.id, 'revive-attempt');
    });

    await Promise.all([deletePromise, updatePromise]);

    const got = await threadStore.get(thread.id);
    assert.equal(got, null);

    const detailExists = await redis.exists(ThreadKeys.detail(thread.id));
    assert.equal(detailExists, 0, 'deleted thread must not be recreated by late update');
  });

  it('S3 ack vs append race: cursor does not skip or duplicate messages', async () => {
    const messageStore = new RedisMessageStore(redis);
    const sessionStore = new SessionStore(redis);
    const deliveryCursorStore = new DeliveryCursorStore(sessionStore);
    const userId = 'user-race';
    const catId = 'opus';
    const threadId = 'thread-race-cursor';
    const baseTs = Date.now();

    const base = await messageStore.append({
      userId,
      catId: null,
      content: 'base',
      mentions: [],
      timestamp: baseTs,
      threadId,
    });

    const appendPromise = Promise.resolve().then(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return messageStore.append({
        userId,
        catId: null,
        content: 'new-after-ack',
        mentions: [],
        timestamp: baseTs + 1,
        threadId,
      });
    });
    const ackPromise = Promise.resolve().then(() => deliveryCursorStore.ackCursor(userId, catId, threadId, base.id));

    const [newMsg] = await Promise.all([appendPromise, ackPromise]);
    const cursor = await deliveryCursorStore.getCursor(userId, catId, threadId);
    assert.equal(cursor, base.id);

    const firstWindow = await messageStore.getByThreadAfter(threadId, cursor, undefined, userId);
    assert.deepEqual(
      firstWindow.map((m) => m.id),
      [newMsg.id],
    );

    await deliveryCursorStore.ackCursor(userId, catId, threadId, newMsg.id);
    const secondCursor = await deliveryCursorStore.getCursor(userId, catId, threadId);
    assert.equal(secondCursor, newMsg.id);

    const secondWindow = await messageStore.getByThreadAfter(threadId, secondCursor, undefined, userId);
    assert.equal(secondWindow.length, 0);
  });

  it('S4 idempotency key race: only one create succeeds', async () => {
    const store = new RedisInvocationRecordStore(redis);
    const N = 20;
    const idempotencyKey = 'redis-idemp-race';

    const results = await Promise.all(
      Array.from({ length: N }, () => store.create(invocationCreateInput(idempotencyKey))),
    );

    const created = results.filter((r) => r.outcome === 'created');
    const duplicates = results.filter((r) => r.outcome === 'duplicate');
    const uniqueInvocationIds = new Set(results.map((r) => r.invocationId));

    assert.equal(created.length, 1);
    assert.equal(duplicates.length, N - 1);
    assert.equal(uniqueInvocationIds.size, 1);
  });
});
