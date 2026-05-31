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

  it('backfills scheduler-triggered stream replies to the real thread owner (#796)', async () => {
    const thread = await threadStore.create('real-user-456', 'scheduler stream backfill');
    const now = Date.now();

    const triggerMessage = await messageStore.append({
      userId: 'scheduler',
      catId: 'system',
      content: '[定时任务] eval:a2a daily run',
      mentions: [],
      timestamp: now,
      threadId: thread.id,
      origin: 'callback',
    });

    const hiddenStreamReply = await messageStore.append({
      userId: 'scheduler',
      catId: 'codex',
      content: 'eval:a2a daily eval result from route-serial stream',
      mentions: [],
      timestamp: now + 1,
      threadId: thread.id,
      origin: 'stream',
    });

    const before = await messageStore.getByThread(thread.id, 50, 'real-user-456');
    assert.deepEqual(
      before.map((m) => m.id),
      [triggerMessage.id],
      'before backfill the default owner view only sees the scheduler trigger',
    );

    const result = await runSchedulerReplyUserIdBackfill({
      redis,
      messageStore,
      invocationRecordStore,
      threadStore,
    });

    assert.equal(result.repairedMessages, 1);

    const after = await messageStore.getByThread(thread.id, 50, 'real-user-456');
    assert.deepEqual(
      after.map((m) => m.id),
      [triggerMessage.id, hiddenStreamReply.id],
      'after backfill the owner view sees the stream-origin scheduler reply',
    );
    assert.equal(after[1].userId, 'real-user-456');
    assert.equal(after[1].origin, 'stream');
  });

  it('uses the configured owner for eval-domain system threads when backfilling stream replies', async () => {
    const threadId = 'thread_eval_a2a';
    const ownerUserId = 'real-user-789';
    await threadStore.ensureThread(threadId, 'A2A Eval');
    await threadStore.updateSystemKind(threadId, 'eval_domain');
    await threadStore.indexForUser(threadId, ownerUserId);

    const now = Date.now();
    const triggerMessage = await messageStore.append({
      userId: 'scheduler',
      catId: 'system',
      content: '[定时任务] eval:a2a daily run',
      mentions: [],
      timestamp: now,
      threadId,
      origin: 'callback',
    });

    const hiddenStreamReply = await messageStore.append({
      userId: 'scheduler',
      catId: 'codex',
      content: 'eval:a2a result persisted under scheduler scope',
      mentions: [],
      timestamp: now + 1,
      threadId,
      origin: 'stream',
    });

    const before = await messageStore.getByThread(threadId, 50, ownerUserId);
    assert.deepEqual(
      before.map((m) => m.id),
      [triggerMessage.id],
      'before backfill the configured owner cannot see the scheduler-scoped stream reply',
    );

    const result = await runSchedulerReplyUserIdBackfill({
      redis,
      messageStore,
      invocationRecordStore,
      threadStore,
      defaultUserId: ownerUserId,
    });

    assert.equal(result.repairedMessages, 1);

    const after = await messageStore.getByThread(threadId, 50, ownerUserId);
    assert.deepEqual(
      after.map((m) => m.id),
      [triggerMessage.id, hiddenStreamReply.id],
      'after backfill the configured owner sees the eval-domain stream reply',
    );
    assert.equal(after[1].userId, ownerUserId);
  });
});
