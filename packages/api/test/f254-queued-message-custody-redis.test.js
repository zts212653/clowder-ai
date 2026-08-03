import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { makeQueuedMessageCustody as makeCustody } from './helpers/queued-message-custody.js';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

describe('F254 queued message custody Redis CAS', { skip: redisIsolationSkipReason(REDIS_URL) }, () => {
  let redis;
  let store;
  let invocationStore;
  let InvocationQueue;
  let QueuedMessageCustodyStartupReconciler;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F254 queued message custody Redis CAS');
    const [
      { createRedisClient },
      { RedisMessageStore },
      { RedisInvocationRecordStore },
      invocationQueueModule,
      startupReconcilerModule,
    ] = await Promise.all([
      import('@cat-cafe/shared/utils'),
      import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'),
      import('../dist/domains/cats/services/stores/redis/RedisInvocationRecordStore.js'),
      import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js'),
      import('../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupReconciler.js'),
    ]);
    InvocationQueue = invocationQueueModule.InvocationQueue;
    QueuedMessageCustodyStartupReconciler = startupReconcilerModule.QueuedMessageCustodyStartupReconciler;
    redis = createRedisClient({ url: REDIS_URL });
    try {
      await redis.ping();
      connected = true;
      store = new RedisMessageStore(redis);
      invocationStore = new RedisInvocationRecordStore(redis);
    } catch {
      await redis.quit().catch(() => {});
    }
  });

  beforeEach(async (t) => {
    if (!connected) return t.skip('Redis not connected');
    await cleanupPrefixedRedisKeys(redis, ['msg:*', 'invoc:*', 'idemp:*']);
  });

  after(async () => {
    if (!connected) return;
    await cleanupPrefixedRedisKeys(redis, ['msg:*', 'invoc:*', 'idemp:*']);
    await redis.quit();
  });

  test('round-trips TTL-0 custody and lets only one concurrent revision win', async () => {
    const message = await store.append({
      userId: 'user-1',
      catId: null,
      content: 'redis queued work',
      mentions: ['opus', 'codex'],
      timestamp: 1_000,
      threadId: 'thread-redis',
      deliveryStatus: 'queued',
      queueCustody: makeCustody(),
    });

    assert.deepEqual((await store.getById(message.id)).queueCustody, makeCustody());
    assert.equal(await redis.ttl(`msg:${message.id}`), -1);

    const left = makeCustody({ revision: 2, status: 'processing', processingStartedAt: 1_100, updatedAt: 1_100 });
    const right = makeCustody({ revision: 2, seenByCatIds: ['codex'], updatedAt: 1_101 });
    const results = await Promise.all([
      store.transitionQueueCustody(message.id, { expectedRevision: 1, next: left }),
      store.transitionQueueCustody(message.id, { expectedRevision: 1, next: right }),
    ]);

    assert.deepEqual(results.map((result) => result.kind).sort(), ['revision_mismatch', 'updated']);
    const stored = await store.getById(message.id);
    assert.equal(stored.queueCustody.revision, 2);
  });

  test('round-trips a cross-thread exact-child awakening before body exposure', async () => {
    const custody = makeCustody({
      entryId: 'cross-thread:message-awakened',
      receiptScope: 'cross_thread_delivery',
      allTargetCats: ['opus'],
      pendingTargetCats: ['opus'],
      carrierByTargetCatId: {
        opus: {
          entryId: 'carrier-opus-awakened',
          source: 'agent',
          sourceCategory: 'a2a',
          callerCatId: 'codex',
          a2aParentInvocationId: 'parent-awakened',
          a2aTriggerMessageId: 'message-awakened',
          autoExecute: true,
          createdAt: 1_000,
        },
      },
      carrierStateByTargetCatId: {
        opus: { status: 'processing', processingStartedAt: 1_050 },
      },
      status: 'processing',
      awakenedInvocationIdByCatId: { opus: 'child-awakened' },
      awakenedAtByCatId: { opus: 1_075 },
      processingStartedAt: 1_050,
      updatedAt: 1_075,
    });
    const message = await store.append({
      userId: 'user-1',
      catId: 'codex',
      content: 'terminal coordination release',
      mentions: ['opus'],
      timestamp: 1_000,
      threadId: 'thread-cross-awakened',
      deliveryStatus: 'queued',
      queueCustody: custody,
    });

    const stored = await store.getById(message.id);

    assert.deepEqual(stored.queueCustody, custody);
    assert.equal(await redis.ttl(`msg:${message.id}`), -1);
  });

  test('browser timeline includes durable queued user work without exposing it to default reads', async () => {
    const ordinary = await store.append({
      userId: 'user-1',
      catId: null,
      content: 'ordinary queued user work',
      mentions: ['opus'],
      timestamp: 1_000,
      threadId: 'thread-browser-timeline',
      deliveryStatus: 'queued',
      queueCustody: makeCustody({
        entryId: 'entry-ordinary-user-work',
        allTargetCats: ['opus'],
        pendingTargetCats: ['opus'],
        createdAt: 1_000,
        updatedAt: 1_000,
      }),
    });
    const steered = await store.append({
      userId: 'user-1',
      catId: null,
      content: 'steered user work is already published',
      mentions: ['opus'],
      timestamp: 1_075,
      threadId: 'thread-browser-timeline',
      deliveryStatus: 'queued',
      queueCustody: makeCustody({
        entryId: 'entry-steered-user-work',
        allTargetCats: ['opus'],
        pendingTargetCats: ['opus'],
        steerRequestedByCatIds: ['opus'],
        createdAt: 1_075,
        updatedAt: 1_075,
      }),
    });
    await store.append({
      userId: 'system',
      catId: 'system',
      content: 'queued internal system work',
      mentions: [],
      timestamp: 1_050,
      threadId: 'thread-browser-timeline',
      deliveryStatus: 'queued',
    });
    const seed = await store.append({
      userId: 'user-1',
      catId: 'codex-sol',
      content: 'source-cat thread seed',
      mentions: ['opus'],
      timestamp: 1_100,
      threadId: 'thread-browser-timeline',
      deliveryStatus: 'queued',
      queueCustody: makeCustody({
        entryId: 'entry-browser-timeline',
        allTargetCats: ['opus'],
        pendingTargetCats: ['opus'],
        createdAt: 1_100,
        updatedAt: 1_100,
      }),
    });

    assert.deepEqual(await store.getByThread('thread-browser-timeline', 20, 'user-1'), []);
    assert.deepEqual(
      (await store.getByThread('thread-browser-timeline', 20, 'user-1', { includeQueuedCatMessages: true })).map(
        (message) => message.id,
      ),
      [seed.id],
    );
    const options = { includeQueuedCatMessages: true, includeQueuedUserMessages: true };
    const latest = await store.getByThread('thread-browser-timeline', 20, 'user-1', options);
    const before = await store.getByThreadBefore('thread-browser-timeline', 2_000, 20, undefined, 'user-1', options);
    const bounded = await store.getByThreadBeforeBounded(
      'thread-browser-timeline',
      2_000,
      20,
      undefined,
      'user-1',
      100,
      options,
    );

    assert.deepEqual(
      latest.map((message) => message.id),
      [ordinary.id, steered.id, seed.id],
    );
    assert.deepEqual(
      before.map((message) => message.id),
      [ordinary.id, steered.id, seed.id],
    );
    assert.deepEqual(
      bounded.messages.map((message) => message.id),
      [ordinary.id, steered.id, seed.id],
    );
    assert.equal(latest[0].catId, null);
    assert.deepEqual(latest[1].queueCustody.steerRequestedByCatIds, ['opus']);
    assert.equal(latest[2].catId, 'codex-sol');
    assert.equal(latest[2].queueCustody.status, 'queued');
  });

  test('forward cursor applies its limit after filtering unpublished queued work', async () => {
    const threadId = 'thread-forward-published';
    const anchor = await store.append({
      userId: 'user-1',
      catId: null,
      content: 'delivered anchor',
      mentions: [],
      timestamp: 1_000,
      threadId,
    });
    await store.append({
      userId: 'user-1',
      catId: null,
      content: 'queued user work before speech',
      mentions: ['opus'],
      timestamp: 1_100,
      threadId,
      deliveryStatus: 'queued',
    });
    const published = await store.append({
      userId: 'user-1',
      catId: 'codex-sol',
      content: 'published source-cat speech',
      mentions: ['opus'],
      timestamp: 1_200,
      threadId,
      deliveryStatus: 'queued',
    });

    const messages = await store.getByThreadAfter(threadId, anchor.id, 1, 'user-1', {
      includeQueuedCatMessages: true,
    });

    assert.deepEqual(
      messages.map((message) => message.id),
      [published.id],
    );
  });

  test('updates custody, delivery status, and timeline score in one terminal transition', async () => {
    const message = await store.append({
      userId: 'user-1',
      catId: null,
      content: 'finish me',
      mentions: ['opus'],
      timestamp: 1_000,
      threadId: 'thread-terminal',
      deliveryStatus: 'queued',
      queueCustody: makeCustody({
        allTargetCats: ['opus'],
        pendingTargetCats: ['opus'],
      }),
    });
    const terminal = makeCustody({
      revision: 2,
      status: 'terminal',
      allTargetCats: ['opus'],
      pendingTargetCats: [],
      seenByCatIds: ['opus'],
      bodyExposures: [{ targetCatId: 'opus', invocationId: 'inv-terminal', seenAt: 1_100 }],
      handledByCatIds: ['opus'],
      targetOutcomeByCatId: {
        opus: {
          invocationId: 'inv-terminal',
          disposition: 'completed_with_turn',
          evidenceRef: { kind: 'invocation_lineage', invocationId: 'inv-terminal' },
          handledAt: 1_200,
          consumption: {
            kind: 'terminal_silent',
            projectionState: 'covered_empty',
            wake: 'coordination_terminal',
          },
        },
      },
      reminderAttempts: [
        {
          id: 'reminder-terminal',
          targetCatId: 'opus',
          invocationId: 'inv-terminal',
          state: 'seen',
          requestedAt: 1_050,
          deliveredAt: 1_075,
          seenAt: 1_100,
        },
      ],
      updatedAt: 1_200,
    });

    const result = await store.transitionQueueCustody(message.id, {
      expectedRevision: 1,
      next: terminal,
      deliveredAt: 1_200,
    });

    assert.equal(result.kind, 'updated');
    assert.equal(result.deliveryTransitioned, true);
    const stored = await store.getById(message.id);
    assert.equal(stored.deliveryStatus, 'delivered');
    assert.equal(stored.deliveredAt, 1_200);
    assert.deepEqual(stored.queueCustody, terminal);
    assert.equal(stored.queueCustody.targetOutcomeByCatId.opus.disposition, 'completed_with_turn');
    assert.equal(stored.queueCustody.targetOutcomeByCatId.opus.consumption.kind, 'terminal_silent');
    assert.equal(stored.queueCustody.reminderAttempts[0].state, 'seen');
    assert.equal(await redis.ttl(`msg:${message.id}`), -1);
    assert.equal(await redis.zscore('msg:thread:thread-terminal', message.id), '1000');
    assert.equal(await redis.zscore('msg:timeline', message.id), '1000');
    assert.equal(await redis.zscore('msg:user:user-1', message.id), '1000');
  });

  test('rejects an unsafe custody deliveredAt before changing custody, status, or index scores', async () => {
    const message = await store.append({
      userId: 'user-1',
      catId: null,
      content: 'reject unsafe custody delivery time',
      mentions: ['opus'],
      timestamp: 1_000,
      threadId: 'thread-invalid-delivery-time',
      deliveryStatus: 'queued',
      queueCustody: makeCustody({ allTargetCats: ['opus'], pendingTargetCats: ['opus'] }),
    });
    const terminal = makeCustody({
      revision: 2,
      status: 'terminal',
      allTargetCats: ['opus'],
      pendingTargetCats: [],
      failedByCatIds: ['opus'],
      updatedAt: 1_200,
    });
    const before = {
      hash: await redis.hgetall(`msg:${message.id}`),
      thread: await redis.zscore('msg:thread:thread-invalid-delivery-time', message.id),
      timeline: await redis.zscore('msg:timeline', message.id),
      user: await redis.zscore('msg:user:user-1', message.id),
    };

    await assert.rejects(
      store.transitionQueueCustody(message.id, {
        expectedRevision: 1,
        next: terminal,
        deliveredAt: 1_200.5,
      }),
      { name: 'RangeError', message: /non-negative integer ECMAScript Date/ },
    );
    assert.deepEqual(await redis.hgetall(`msg:${message.id}`), before.hash);
    assert.equal(await redis.zscore('msg:thread:thread-invalid-delivery-time', message.id), before.thread);
    assert.equal(await redis.zscore('msg:timeline', message.id), before.timeline);
    assert.equal(await redis.zscore('msg:user:user-1', message.id), before.user);
  });

  test('refuses the legacy markDelivered escape hatch while custody is active', async () => {
    const message = await store.append({
      userId: 'user-1',
      catId: null,
      content: 'do not expose before success',
      mentions: ['opus'],
      timestamp: 1_000,
      threadId: 'thread-fenced',
      deliveryStatus: 'queued',
      queueCustody: makeCustody({ allTargetCats: ['opus'], pendingTargetCats: ['opus'] }),
    });

    const result = await store.markDelivered(message.id, 1_200);

    assert.equal(result.deliveryTransitioned, false);
    const stored = await store.getById(message.id);
    assert.equal(stored.deliveryStatus, 'queued');
    assert.equal(stored.queueCustody.status, 'queued');
    assert.equal(await redis.zscore('msg:thread:thread-fenced', message.id), '1000');
  });

  test('cancel atomically removes active custody fields from the canceled message', async () => {
    const message = await store.append({
      userId: 'user-1',
      catId: null,
      content: 'cancel me',
      mentions: ['opus'],
      timestamp: 1_000,
      threadId: 'thread-cancel',
      deliveryStatus: 'queued',
      queueCustody: makeCustody({ allTargetCats: ['opus'], pendingTargetCats: ['opus'] }),
    });

    const canceled = await store.markCanceled(message.id);

    assert.equal(canceled.deliveryStatus, 'canceled');
    assert.equal(canceled.queueCustody, undefined);
    assert.equal(await redis.hget(`msg:${message.id}`, 'queueCustody'), null);
    assert.equal(await redis.hget(`msg:${message.id}`, 'queueCustodyRevision'), null);
  });

  test('restart consumes only the witnessed target from one aggregate-succeeded invocation', async () => {
    const { invocationId } = await invocationStore.create({
      threadId: 'thread-shared-parent',
      userId: 'user-1',
      targetCats: ['opus', 'codex'],
      intent: 'execute',
      idempotencyKey: 'f254-shared-parent-restart',
      actionLeaseCarrier: { kind: 'none' },
    });
    await invocationStore.update(invocationId, { status: 'running' });
    await invocationStore.update(invocationId, {
      status: 'succeeded',
      successfulCatIds: ['opus'],
    });
    const message = await store.append({
      userId: 'user-1',
      catId: null,
      content: 'only one target finished before the crash',
      mentions: ['opus', 'codex'],
      timestamp: 1_000,
      threadId: 'thread-shared-parent',
      deliveryStatus: 'queued',
      queueCustody: makeCustody({
        ownerAuthProvenance: 'strict',
        revision: 2,
        status: 'processing',
        seenByCatIds: ['opus', 'codex'],
        seenInvocationIdByCatId: { opus: invocationId, codex: invocationId },
        processingStartedAt: 1_100,
        updatedAt: 1_100,
      }),
    });

    const freshQueue = new InvocationQueue();
    const reconciler = new QueuedMessageCustodyStartupReconciler({
      messageStore: store,
      invocationRecordStore: invocationStore,
      invocationQueue: freshQueue,
      now: () => 2_000,
      log: { info() {}, warn() {} },
    });

    const result = await reconciler.reconcile();

    assert.equal(result.handledTargets, 1);
    assert.equal(result.failedTargets, 1);
    const restored = freshQueue.getEntrySnapshot('thread-shared-parent', 'user-1', 'entry-1');
    assert.equal(restored.ownerAuthProvenance, 'strict');
    assert.deepEqual(restored.targetCats, ['codex']);
    assert.deepEqual(restored.queuedHandledByCatIds, ['opus']);
    assert.deepEqual(restored.queuedFailedByCatIds, ['codex']);
    const stored = await store.getById(message.id);
    assert.equal(stored.queueCustody.ownerAuthProvenance, 'strict');
    assert.equal(stored.deliveryStatus, 'queued');
    assert.deepEqual(stored.queueCustody.pendingTargetCats, ['codex']);
    assert.deepEqual(stored.queueCustody.handledByCatIds, ['opus']);
    assert.deepEqual(stored.queueCustody.failedByCatIds, ['codex']);
  });
});
