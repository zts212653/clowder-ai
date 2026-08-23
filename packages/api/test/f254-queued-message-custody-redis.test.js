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
  let rebindCrossThreadQueueCarrierActionFence;
  let connected = false;

  before(async () => {
    assertRedisIsolationOrThrow(REDIS_URL, 'F254 queued message custody Redis CAS');
    const [
      { createRedisClient },
      { RedisMessageStore },
      { RedisInvocationRecordStore },
      invocationQueueModule,
      startupReconcilerModule,
      custodyCoordinatorModule,
    ] = await Promise.all([
      import('@cat-cafe/shared/utils'),
      import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'),
      import('../dist/domains/cats/services/stores/redis/RedisInvocationRecordStore.js'),
      import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js'),
      import('../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyStartupReconciler.js'),
      import('../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js'),
    ]);
    InvocationQueue = invocationQueueModule.InvocationQueue;
    QueuedMessageCustodyStartupReconciler = startupReconcilerModule.QueuedMessageCustodyStartupReconciler;
    rebindCrossThreadQueueCarrierActionFence = custodyCoordinatorModule.rebindCrossThreadQueueCarrierActionFence;
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

  test('durably fences fan-out admission before custody and replaces the intent atomically', async () => {
    const message = await store.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'redis pre-CAS fan-out',
      mentions: ['codex', 'codex-terra'],
      timestamp: 1_000,
      threadId: 'thread-fanout-admission',
      deliveryStatus: 'queued',
    });
    const admission = {
      version: 1,
      admissionId: `queue-custody:${message.id}`,
      ownerUserId: 'user-1',
      ownerAuthProvenance: 'unknown',
      intent: 'execute',
      targetCats: ['codex'],
      requestedTargetCats: ['codex', 'codex-terra'],
      callerCatId: 'opus',
      a2aParentInvocationId: 'parent-1',
      priority: 'normal',
      createdAt: 1_000,
    };

    const results = await Promise.all([
      store.initializeQueueCustodyAdmission(message.id, admission),
      store.initializeQueueCustodyAdmission(message.id, structuredClone(admission)),
    ]);
    assert.deepEqual(results.map((result) => result.kind).sort(), ['existing', 'initialized']);
    assert.deepEqual((await store.getById(message.id)).queueCustodyAdmission, admission);
    assert.equal(await redis.ttl(`msg:${message.id}`), -1);
    assert.equal((await store.markDelivered(message.id, 1_001)).deliveryTransitioned, false);

    const custody = makeCustody({
      entryId: `fanout:${message.id}`,
      ownerUserId: 'user-1',
      ownerAuthProvenance: 'unknown',
      intent: 'execute',
      allTargetCats: ['codex', 'codex-terra'],
      carrierByTargetCatId: {
        codex: {
          entryId: 'carrier-codex',
          source: 'agent',
          sourceCategory: 'a2a',
          callerCatId: 'opus',
          a2aParentInvocationId: 'parent-1',
          a2aTriggerMessageId: message.id,
          autoExecute: true,
          createdAt: 1_000,
        },
      },
      carrierStateByTargetCatId: { codex: { status: 'queued' } },
      pendingTargetCats: ['codex'],
      failedByCatIds: ['codex-terra'],
    });
    assert.equal((await store.initializeQueueCustody(message.id, custody)).kind, 'initialized');

    const stored = await store.getById(message.id);
    assert.equal(stored.queueCustodyAdmission, undefined);
    assert.deepEqual(stored.queueCustody.allTargetCats, ['codex', 'codex-terra']);
    assert.equal(await redis.hget(`msg:${message.id}`, 'queueCustodyAdmission'), null);

    const canceled = await store.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'cancel redis pre-CAS fan-out',
      mentions: ['codex'],
      timestamp: 1_002,
      threadId: 'thread-fanout-admission',
      deliveryStatus: 'queued',
    });
    assert.equal(
      (
        await store.initializeQueueCustodyAdmission(canceled.id, {
          ...admission,
          admissionId: `queue-custody:${canceled.id}`,
          requestedTargetCats: ['codex'],
        })
      ).kind,
      'initialized',
    );
    assert.equal((await store.markCanceled(canceled.id)).deliveryStatus, 'canceled');
    assert.equal((await store.getById(canceled.id)).queueCustodyAdmission, undefined);
    assert.equal(await redis.hget(`msg:${canceled.id}`, 'queueCustodyAdmission'), null);
  });

  test('round-trips an action-successor carrier rebind and refuses generation rewind', async () => {
    const message = await store.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'redis action carrier',
      mentions: ['codex'],
      timestamp: 1_000,
      threadId: 'thread-action-carrier-redis',
      deliveryStatus: 'queued',
      queueCustody: makeCustody({
        entryId: 'cross-thread:action-redis',
        ownerUserId: 'user-1',
        receiptScope: 'cross_thread_delivery',
        allTargetCats: ['codex'],
        pendingTargetCats: ['codex'],
        carrierByTargetCatId: {
          codex: {
            entryId: 'carrier-action-codex',
            source: 'agent',
            sourceCategory: 'a2a',
            callerCatId: 'opus',
            a2aTriggerMessageId: 'source-action-redis',
            autoExecute: true,
            createdAt: 1_000,
          },
        },
        carrierStateByTargetCatId: { codex: { status: 'queued' } },
      }),
    });
    const fence = {
      leaseId: 'lease-action-redis',
      generation: 7,
      dispatchId: 'cross-post:action-redis',
      terminalPredicateDigest: 'predicate-action-redis',
    };

    const [rebound] = await rebindCrossThreadQueueCarrierActionFence(
      store,
      [message],
      'carrier-action-codex',
      fence,
      () => 1_100,
    );

    assert.equal(rebound.queueCustody.revision, 2);
    assert.deepEqual(rebound.queueCustody.carrierByTargetCatId.codex.actionSuccessorFence, fence);
    assert.equal(rebound.queueCustody.carrierByTargetCatId.codex.idempotencyKey, 'action:lease-action-redis:7:codex');
    assert.equal(await redis.ttl(`msg:${message.id}`), -1);

    const [idempotent] = await rebindCrossThreadQueueCarrierActionFence(
      store,
      [rebound],
      'carrier-action-codex',
      fence,
      () => 1_200,
    );
    assert.equal(idempotent.queueCustody.revision, 2, 'exact replay must not write a second custody revision');

    await assert.rejects(
      rebindCrossThreadQueueCarrierActionFence(
        store,
        [idempotent],
        'carrier-action-codex',
        { ...fence, generation: 6 },
        () => 1_300,
      ),
      /cannot replace or rewind authority/,
    );
    assert.equal((await store.getById(message.id)).queueCustody.revision, 2);
  });

  test('atomically adopts one legacy-visible carrier before Queue custody admission', async () => {
    const legacy = await store.append({
      userId: 'user-1',
      catId: 'codex-sol',
      content: 'approved carrier persisted before Queue admission',
      mentions: ['codex-terra'],
      timestamp: 1_000,
      threadId: 'thread-approved-carrier',
    });

    const results = await Promise.all([store.prepareQueueAdmission(legacy.id), store.prepareQueueAdmission(legacy.id)]);
    assert.deepEqual(results.map((result) => result.kind).sort(), ['existing', 'prepared']);
    const prepared = await store.getById(legacy.id);
    assert.equal(prepared.deliveryStatus, 'queued');
    assert.equal(prepared.queueCustody, undefined);
    assert.equal(await redis.ttl(`msg:${legacy.id}`), -1);

    const custody = makeCustody({
      entryId: 'carrier-codex-terra',
      receiptScope: 'cross_thread_delivery',
      ownerUserId: 'user-1',
      allTargetCats: ['codex-terra'],
      pendingTargetCats: ['codex-terra'],
      carrierByTargetCatId: {
        'codex-terra': {
          entryId: 'carrier-codex-terra',
          source: 'agent',
          sourceCategory: 'a2a',
          callerCatId: 'codex-sol',
          a2aTriggerMessageId: legacy.id,
          autoExecute: true,
          createdAt: 1_000,
        },
      },
      carrierStateByTargetCatId: { 'codex-terra': { status: 'queued' } },
    });
    assert.equal((await store.initializeQueueCustody(legacy.id, custody)).kind, 'initialized');
    assert.equal((await store.prepareQueueAdmission(legacy.id)).kind, 'existing');

    const delivered = await store.append({
      userId: 'user-1',
      catId: 'codex-sol',
      content: 'terminal carrier',
      mentions: ['codex-terra'],
      timestamp: 1_001,
      threadId: 'thread-approved-carrier',
      deliveryStatus: 'queued',
    });
    await store.markDelivered(delivered.id, 1_002);
    assert.deepEqual(await store.prepareQueueAdmission(delivered.id), { kind: 'conflict' });
  });

  test('forward queued-inclusive reads preserve raw thread order across an exposed queued cursor', async () => {
    const threadId = 'thread-queued-inclusive-forward-redis';
    const before = await store.append({
      userId: 'user-1',
      catId: null,
      content: 'before',
      mentions: [],
      timestamp: 1_000,
      threadId,
    });
    const exposed = await store.append({
      userId: 'user-1',
      catId: null,
      content: 'exposed queued body',
      mentions: ['opus'],
      timestamp: 2_000,
      threadId,
      deliveryStatus: 'queued',
      queueCustody: makeCustody({
        allTargetCats: ['opus'],
        pendingTargetCats: ['opus'],
        seenByCatIds: ['opus'],
        seenInvocationIdByCatId: { opus: 'sealed-child' },
        bodyExposures: [{ targetCatId: 'opus', invocationId: 'sealed-child', seenAt: 2_100 }],
      }),
    });
    const after = await store.append({
      userId: 'user-1',
      catId: 'codex',
      content: 'after',
      mentions: [],
      timestamp: 2_000,
      threadId,
    });
    const options = {
      includeQueuedCatMessages: true,
      includeExposedQueuedUserMessagesForCatId: 'opus',
    };

    assert.deepEqual(
      (await store.getByThreadAfter(threadId, before.id, 20, 'user-1', options)).map((message) => message.id),
      [exposed.id, after.id],
    );
    assert.deepEqual(
      (await store.getByThreadAfter(threadId, exposed.id, 20, 'user-1', options)).map((message) => message.id),
      [after.id],
    );
    assert.deepEqual(
      (
        await store.getByThreadAfter(threadId, before.id, 20, 'user-1', {
          ...options,
          includeExposedQueuedUserMessagesForCatId: 'codex-sol',
        })
      ).map((message) => message.id),
      [after.id],
    );
  });

  test('CAS-rebinds one exact source to its verified replacement without persisting the proof', async () => {
    const initial = makeCustody({
      entryId: 'entry-replaced',
      allTargetCats: ['opus'],
      pendingTargetCats: ['opus'],
    });
    const message = await store.append({
      userId: 'user-1',
      catId: null,
      content: 'recover this exact queued source',
      mentions: ['opus'],
      timestamp: 1_000,
      threadId: 'thread-replacement',
      deliveryStatus: 'queued',
      queueCustody: initial,
    });
    const next = { ...initial, entryId: 'entry-replacement', revision: 2, updatedAt: 1_100 };

    const result = await store.transitionQueueCustody(message.id, {
      expectedRevision: 1,
      next,
      replacement: {
        kind: 'verified',
        previousEntryId: initial.entryId,
        replacementEntryId: next.entryId,
        sourceMessageId: message.id,
      },
    });

    assert.equal(result.kind, 'updated');
    const stored = await store.getById(message.id);
    assert.deepEqual(stored.queueCustody, next);
    assert.equal('replacement' in stored.queueCustody, false);
    assert.equal(await redis.ttl(`msg:${message.id}`), -1);
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

  test('startup replacement preflight reads the durable queued A2A source group before restoring it', async () => {
    const threadId = 'thread-startup-replaced-a2a';
    const source = await store.append({
      userId: 'user-1',
      catId: 'codex',
      content: '@opus original handoff',
      mentions: ['opus'],
      timestamp: 1_000,
      threadId,
    });
    const message = await store.append({
      userId: 'user-1',
      catId: 'codex',
      content: '@opus old queued prompt',
      mentions: ['opus'],
      timestamp: 1_001,
      threadId,
      deliveryStatus: 'queued',
      queueCustody: makeCustody({
        entryId: 'cross-thread:startup-replaced-a2a',
        receiptScope: 'cross_thread_delivery',
        allTargetCats: ['opus'],
        pendingTargetCats: ['opus'],
        carrierByTargetCatId: {
          opus: {
            entryId: 'carrier-startup-replaced-a2a',
            source: 'agent',
            sourceCategory: 'a2a',
            callerCatId: 'codex',
            a2aParentInvocationId: 'parent-startup-replaced-a2a',
            a2aTriggerMessageId: source.id,
            autoExecute: true,
            createdAt: 1_001,
          },
        },
        carrierStateByTargetCatId: { opus: { status: 'queued' } },
        createdAt: 1_001,
        updatedAt: 1_001,
      }),
    });
    const inspected = [];
    const reconciler = new QueuedMessageCustodyStartupReconciler({
      messageStore: store,
      invocationRecordStore: invocationStore,
      invocationQueue: new InvocationQueue(),
      a2aDispatchDispositionService: {
        async inspectHandoff(input) {
          inspected.push(input);
          return {
            outcome: 'replaced',
            sourceMessageId: input.sourceMessageId,
            fromCatId: 'codex',
            handoffSourceEventId: `route:${input.sourceMessageId}:opus`,
            replacement: {
              kind: 'handed',
              sourceEventId: 'route:startup-successor:opus',
              sourceMessageId: 'message-startup-successor',
              fromCatId: 'codex',
              toCatId: 'opus',
            },
          };
        },
      },
      now: () => 2_000,
      log: { info() {}, warn() {} },
    });

    const result = await reconciler.reconcile();

    assert.equal(result.entriesRestored, 0);
    assert.equal(result.messagesTerminalized, 1);
    assert.deepEqual(
      inspected.map((input) => input.sourceMessageId),
      [source.id, message.id],
    );
    const stored = await store.getById(message.id);
    assert.equal(stored.deliveryStatus, 'delivered');
    assert.equal(stored.queueCustody.status, 'terminal');
    assert.deepEqual(stored.queueCustody.pendingTargetCats, []);
    assert.deepEqual(stored.queueCustody.withdrawnByCatIds, ['opus']);
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

  test('managed-hold history binds scheduler publication to the durable owner across terminal delivery', async () => {
    const threadId = 'thread-managed-hold-owner-visibility';
    const anchor = await store.append({
      userId: 'user-owner',
      catId: null,
      content: 'read anchor',
      mentions: [],
      timestamp: 900,
      threadId,
    });
    const source = {
      connector: 'hold-ball',
      label: '持球结果',
      icon: '🏓',
      meta: { taskId: 'task-managed-hold-owner', threadId, catId: 'opus', wakeWhen: true },
    };
    const ownerVisible = await store.append({
      userId: 'scheduler',
      catId: null,
      content: 'owner-visible command result',
      mentions: [],
      timestamp: 1_000,
      threadId,
      deliveryStatus: 'queued',
      queueCustody: makeCustody({ ownerUserId: 'user-owner' }),
      source,
    });
    const hidden = await store.append({
      userId: 'scheduler',
      catId: null,
      content: 'hidden command trigger',
      mentions: [],
      timestamp: 1_001,
      threadId,
      deliveryStatus: 'queued',
      queueCustody: makeCustody({ entryId: 'entry-hidden', ownerUserId: 'user-owner' }),
      extra: { scheduler: { hiddenTrigger: true } },
      source,
    });
    const ownerless = await store.append({
      userId: 'scheduler',
      catId: null,
      content: 'legacy ownerless result',
      mentions: [],
      timestamp: 1_002,
      threadId,
      deliveryStatus: 'queued',
      queueCustody: makeCustody({ entryId: 'entry-ownerless' }),
      source,
    });

    const options = { includeQueuedUserMessages: true };
    assert.deepEqual(
      (await store.getByThreadAfter(threadId, anchor.id, 20, 'user-owner', options)).map((message) => message.id),
      [ownerVisible.id],
    );
    assert.deepEqual(await store.getByThreadAfter(threadId, anchor.id, 20, 'user-foreign', options), []);

    const terminalize = async (message, deliveredAt) => {
      const result = await store.transitionQueueCustody(message.id, {
        expectedRevision: 1,
        next: makeCustody({
          ...message.queueCustody,
          revision: 2,
          status: 'terminal',
          pendingTargetCats: [],
          failedByCatIds: ['opus', 'codex'],
          updatedAt: deliveredAt,
        }),
        deliveredAt,
      });
      assert.equal(result.kind, 'updated');
    };
    await terminalize(ownerVisible, 1_100);
    await terminalize(hidden, 1_101);

    // Legacy ownerless custody is invalid for new writes but remains a valid
    // migration input. Simulate its historical terminal state directly.
    await redis.hset(`msg:${ownerless.id}`, 'deliveryStatus', 'delivered', 'deliveredAt', '1102');

    assert.deepEqual(
      (await store.getByThreadAfter(threadId, anchor.id, 20, 'user-owner')).map((message) => message.id),
      [ownerVisible.id],
    );
    assert.deepEqual(await store.getByThreadAfter(threadId, anchor.id, 20, 'user-foreign'), []);
    assert.deepEqual(
      (await store.getByThreadIncludingQueued(threadId, 20, 'user-foreign')).filter(
        (message) => message.id !== anchor.id,
      ),
      [],
    );
    assert.deepEqual(await store.getUnreadSummaryProjection([{ threadId, afterId: anchor.id }], 'user-owner'), [
      { threadId, unreadCount: 1, hasUserMention: false },
    ]);
    assert.deepEqual(await store.getUnreadSummaryProjection([{ threadId, afterId: anchor.id }], 'user-foreign'), [
      { threadId, unreadCount: 0, hasUserMention: false },
    ]);
    assert.equal(
      (
        await store.getLatestVisibleCursor(threadId, {
          evidence: 'durable_owner_read',
          viewerUserId: 'user-owner',
        })
      ).messageId,
      ownerVisible.id,
    );
    assert.equal(
      (
        await store.getLatestVisibleCursor(threadId, {
          evidence: 'durable_owner_read',
          viewerUserId: 'user-foreign',
        })
      ).messageId,
      anchor.id,
    );
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

  test('restart terminalizes a failed historical exposure with an exact durable source response', async () => {
    const threadId = 'thread-managed-command-historical-response';
    const invocationId = 'inv-managed-command-historical-response';
    const message = await store.append({
      userId: 'scheduler',
      catId: null,
      content: 'managed command completed',
      mentions: ['opus'],
      timestamp: 1_000,
      threadId,
      deliveryStatus: 'queued',
      source: {
        connector: 'hold-ball',
        label: '持球通知',
        meta: { taskId: 'task-managed-command', threadId, catId: 'opus', wakeWhen: true },
      },
      queueCustody: makeCustody({
        allTargetCats: ['opus'],
        pendingTargetCats: ['opus'],
        revision: 3,
        status: 'queued',
        seenByCatIds: ['opus'],
        seenInvocationIdByCatId: {},
        bodyExposures: [{ targetCatId: 'opus', invocationId, seenAt: 1_075 }],
        failedByCatIds: ['opus'],
        updatedAt: 1_600,
      }),
    });
    const response = await store.append({
      userId: 'default-user',
      catId: 'opus',
      content: 'the command result was consumed before the stop gate failed',
      mentions: [],
      timestamp: 1_500,
      threadId,
      extra: {
        stream: {
          invocationId: 'parent-managed-command-historical-response',
          turnInvocationId: invocationId,
        },
        causal: { kind: 'invocation_reply', triggerMessageId: message.id },
      },
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

    assert.equal(result.messagesTerminalized, 1);
    assert.equal(result.handledTargets, 1);
    assert.equal(freshQueue.getEntrySnapshot(threadId, 'scheduler', 'entry-1'), null);
    const stored = await store.getById(message.id);
    assert.equal(stored.deliveryStatus, 'delivered');
    assert.equal(await redis.ttl(`msg:${message.id}`), -1);
    assert.deepEqual(stored.queueCustody.targetOutcomeByCatId.opus, {
      invocationId,
      disposition: 'responded',
      evidenceRef: { kind: 'invocation_lineage', invocationId },
      handledAt: 2_000,
      consumption: {
        kind: 'source_response',
        outputMessageIds: [response.id],
      },
    });
  });
});
