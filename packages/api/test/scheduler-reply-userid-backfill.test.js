import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('scheduler reply userid backfill', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let RedisMessageStore;
  let RedisInvocationRecordStore;
  let RedisThreadStore;
  let createRedisClient;
  let runSchedulerReplyUserIdBackfill;
  let redis;
  let messageStore;
  let invocationRecordStore;
  let threadStore;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'scheduler-reply-userid-backfill');

    const messageModule = await import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js');
    const invocationModule = await import('../dist/domains/cats/services/stores/redis/RedisInvocationRecordStore.js');
    const threadModule = await import('../dist/domains/cats/services/stores/redis/RedisThreadStore.js');
    const backfillModule = await import('../dist/infrastructure/scheduler/scheduler-reply-userid-backfill.js');
    const redisModule = await import('@cat-cafe/shared/utils');

    RedisMessageStore = messageModule.RedisMessageStore;
    RedisInvocationRecordStore = invocationModule.RedisInvocationRecordStore;
    RedisThreadStore = threadModule.RedisThreadStore;
    runSchedulerReplyUserIdBackfill = backfillModule.runSchedulerReplyUserIdBackfill;
    createRedisClient = redisModule.createRedisClient;

    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
    } catch {
      console.warn('[scheduler-reply-userid-backfill.test] Redis unreachable, skipping tests');
      await redis.quit().catch(() => {});
      return;
    }

    messageStore = new RedisMessageStore(redis, { ttlSeconds: 600 });
    invocationRecordStore = new RedisInvocationRecordStore(redis);
    threadStore = new RedisThreadStore(redis, { ttlSeconds: 600 });
  });

  after(async () => {
    if (redis && connected) {
      await cleanupPrefixedRedisKeys(redis, ['msg:*', 'invoc:*', 'idemp:*', 'threads:*', 'migration:*']);
      await redis.quit();
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['msg:*', 'invoc:*', 'idemp:*', 'threads:*', 'migration:*']);
  });

  it('backfills historical scheduler-triggered cat replies to the real thread owner', async () => {
    const thread = await threadStore.create('real-user-123', 'scheduler backfill');
    const now = Date.now();

    const triggerMessage = await messageStore.append({
      userId: 'scheduler',
      catId: 'system',
      content: '[定时任务] 发今天的 AI 新闻',
      mentions: [],
      timestamp: now,
      threadId: thread.id,
      origin: 'callback',
    });

    const createResult = await invocationRecordStore.create({
      threadId: thread.id,
      userId: 'scheduler',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'scheduler-trigger-1',
    });
    const running = await invocationRecordStore.update(createResult.invocationId, {
      status: 'running',
    });
    assert.ok(running, 'invocation should transition to running before success');

    const completed = await invocationRecordStore.update(createResult.invocationId, {
      status: 'succeeded',
      userMessageId: triggerMessage.id,
    });
    assert.ok(completed, 'invocation should persist trigger message id');

    const hiddenReply = await messageStore.append({
      userId: 'scheduler',
      catId: 'opus',
      content: '这是旧的猫回复',
      mentions: [],
      timestamp: now + 1,
      threadId: thread.id,
      origin: 'callback',
    });

    const before = await messageStore.getByThread(thread.id, 50, 'real-user-123');
    assert.equal(before.length, 1, 'before backfill only system trigger message is visible');
    assert.equal(before[0].id, triggerMessage.id);

    const result = await runSchedulerReplyUserIdBackfill({
      redis,
      messageStore,
      invocationRecordStore,
      threadStore,
    });

    assert.equal(result.repairedMessages, 1);
    assert.equal(result.repairedInvocations, 1);

    const after = await messageStore.getByThread(thread.id, 50, 'real-user-123');
    assert.equal(after.length, 2, 'after backfill both trigger and cat reply are visible');
    assert.equal(after[1].id, hiddenReply.id);
    assert.equal(after[1].userId, 'real-user-123');

    const repairedInvocation = await invocationRecordStore.get(createResult.invocationId);
    assert.equal(repairedInvocation.userId, 'real-user-123');
  });
});
