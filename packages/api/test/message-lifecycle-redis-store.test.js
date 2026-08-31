import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';
import {
  assertRedisIsolationOrThrow,
  cleanupPrefixedRedisKeys,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

const REDIS_URL = process.env.REDIS_URL;

function canonicalFixture(input) {
  return canonicalTestMessageInput(input);
}

describe(
  'RedisMessageStore lifecycle pre-admission failure transaction',
  {
    skip: redisIsolationSkipReason(REDIS_URL),
  },
  () => {
    let redis;
    let store;
    let connected = false;

    before(async () => {
      assertRedisIsolationOrThrow(REDIS_URL, 'RedisMessageStore lifecycle pre-admission failure transaction');
      const [{ createRedisClient }, { RedisMessageStore }] = await Promise.all([
        import('@cat-cafe/shared/utils'),
        import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'),
      ]);
      redis = createRedisClient({ url: REDIS_URL });
      try {
        await redis.ping();
        connected = true;
        store = new RedisMessageStore(redis, { ttlSeconds: 0 });
      } catch {
        await redis.quit().catch(() => {});
      }
    });

    beforeEach(async (t) => {
      if (!connected) return t.skip('Redis not connected');
      await cleanupPrefixedRedisKeys(redis, ['msg:*']);
    });

    after(async () => {
      if (!connected) return;
      await cleanupPrefixedRedisKeys(redis, ['msg:*']);
      await redis.quit();
    });

    test('publishes agent speech and durable wake admission in one Redis append', async () => {
      let observedAppend;
      store.onAppend = (message) => {
        observedAppend = structuredClone(message);
      };
      const source = await store.appendWithQueueCustodyAdmission(
        canonicalFixture({
          userId: 'owner-redis',
          threadId: 'thread-redis-atomic-wake',
          catId: 'opus',
          content: '@codex please review',
          mentions: ['codex'],
          timestamp: 90,
          origin: 'callback',
        }),
        (messageId) => ({
          version: 1,
          admissionId: `fanout:${messageId}`,
          ownerUserId: 'owner-redis',
          ownerAuthProvenance: 'strict',
          intent: 'execute',
          targetCats: ['codex'],
          requestedTargetCats: ['codex'],
          callerCatId: 'opus',
          priority: 'normal',
          createdAt: 90,
        }),
      );

      assert.equal(source.queueCustodyAdmission.admissionId, `fanout:${source.id}`);
      assert.deepEqual(source.lifecycle.dispatchRefs, [{ targetId: 'codex', phase: 'assigned' }]);
      assert.deepEqual(observedAppend, source, 'append listeners must never observe speech without its wake admission');
      const hydrated = await store.getById(source.id);
      assert.deepEqual(hydrated.queueCustodyAdmission, source.queueCustodyAdmission);
      assert.deepEqual(hydrated.lifecycle, source.lifecycle);
      store.onAppend = undefined;
    });

    test('atomically attaches one Queue input to every Redis-backed processing Active Run', async () => {
      const input = await store.append(
        canonicalFixture({
          userId: 'owner-redis',
          threadId: 'thread-redis-append',
          catId: null,
          content: 'append this',
          mentions: ['opus', 'codex'],
          timestamp: 90,
        }),
      );
      const response = (targetId, invocationId) =>
        store.append(
          canonicalFixture({
            userId: 'owner-redis',
            threadId: 'thread-redis-append',
            catId: targetId,
            content: '',
            mentions: [],
            timestamp: 100,
            lifecycle: {
              kind: 'response',
              orderKey: `100:${invocationId}`,
              from: { kind: 'agent', catId: targetId },
              invocationId,
              targetId,
              inputEntryIds: ['entry-old'],
              inputMessageIds: ['message-old'],
              status: 'processing',
              startedAt: 100,
            },
          }),
        );
      const [opus, codex] = await Promise.all([response('opus', 'turn-opus'), response('codex', 'turn-codex')]);
      const admission = {
        threadId: 'thread-redis-append',
        entryId: 'entry-append',
        inputMessageIds: [input.id],
        runs: [
          { targetId: 'opus', invocationId: 'turn-opus', responseMessageId: opus.id },
          { targetId: 'codex', invocationId: 'turn-codex', responseMessageId: codex.id },
        ],
      };

      assert.equal((await store.commitLifecycleAppendAdmission(admission)).kind, 'applied');
      assert.deepEqual((await store.getById(input.id)).lifecycle.dispatchRefs, [
        { targetId: 'opus', phase: 'dispatched', statusMessageId: opus.id },
        { targetId: 'codex', phase: 'dispatched', statusMessageId: codex.id },
      ]);
      assert.deepEqual((await store.getById(opus.id)).lifecycle.inputEntryIds, ['entry-old', 'entry-append']);
      assert.deepEqual((await store.getById(codex.id)).lifecycle.inputMessageIds, ['message-old', input.id]);
      assert.equal((await store.commitLifecycleAppendAdmission(admission)).kind, 'replayed');

      const failure = await store.append(
        canonicalFixture({
          userId: 'owner-redis',
          threadId: 'thread-redis-append',
          catId: null,
          content: 'codex carrier closed',
          mentions: [],
          timestamp: 110,
          lifecycle: {
            kind: 'delivery_failure',
            orderKey: '110:failure-codex',
            from: { kind: 'system', service: 'message_delivery' },
            status: 'failed',
            sourceEntryId: 'entry-append',
            inputMessageId: input.id,
            requestedTargets: ['codex'],
            reason: 'control_carrier_replaced',
            createdAt: 110,
          },
        }),
      );
      const rejection = {
        threadId: 'thread-redis-append',
        entryId: 'entry-append',
        inputMessageIds: [input.id],
        failureMessageIds: [failure.id],
        run: { targetId: 'codex', invocationId: 'turn-codex', responseMessageId: codex.id },
      };
      assert.equal((await store.commitLifecycleAppendRejection(rejection)).kind, 'applied');
      assert.deepEqual((await store.getById(input.id)).lifecycle.dispatchRefs, [
        { targetId: 'opus', phase: 'dispatched', statusMessageId: opus.id },
        { targetId: 'codex', phase: 'settled', statusMessageId: failure.id },
      ]);
      assert.deepEqual((await store.getById(codex.id)).lifecycle.inputMessageIds, ['message-old']);
      assert.equal((await store.commitLifecycleAppendRejection(rejection)).kind, 'replayed');
    });

    test('atomically completes one response bubble with its outbound wake admission', async () => {
      const processing = await store.append(
        canonicalFixture({
          userId: 'owner-redis',
          threadId: 'thread-redis-terminal-wake',
          catId: 'opus',
          content: '',
          mentions: [],
          timestamp: 100,
          lifecycle: {
            kind: 'response',
            orderKey: '0000000000100:response-redis',
            from: { kind: 'agent', catId: 'opus' },
            invocationId: 'invocation-redis',
            targetId: 'opus',
            inputEntryIds: ['entry-redis'],
            inputMessageIds: ['message-redis'],
            status: 'processing',
            startedAt: 100,
          },
        }),
      );
      const terminal = {
        invocationId: 'invocation-redis',
        status: 'completed',
        completedAt: 200,
        content: '@codex review',
        mentions: ['codex'],
        origin: 'stream',
      };
      const buildAdmission = (messageId) => ({
        version: 1,
        admissionId: `fanout:${messageId}`,
        ownerUserId: 'owner-redis',
        ownerAuthProvenance: 'strict',
        intent: 'execute',
        targetCats: ['codex'],
        requestedTargetCats: ['codex'],
        callerCatId: 'opus',
        priority: 'normal',
        createdAt: 200,
      });

      const applied = await store.commitLifecycleResponseTerminalWithQueueCustodyAdmission(
        processing.id,
        terminal,
        buildAdmission,
      );

      assert.equal(applied.kind, 'applied');
      assert.equal(applied.message.id, processing.id);
      assert.deepEqual(applied.message.lifecycle.dispatchRefs, [{ targetId: 'codex', phase: 'assigned' }]);
      assert.equal(applied.message.queueCustodyAdmission.admissionId, `fanout:${processing.id}`);
      const replayed = await store.commitLifecycleResponseTerminalWithQueueCustodyAdmission(
        processing.id,
        terminal,
        buildAdmission,
      );
      assert.equal(replayed.kind, 'replayed');
      assert.deepEqual(
        (await store.getById(processing.id)).queueCustodyAdmission,
        applied.message.queueCustodyAdmission,
      );
    });

    test('atomically publishes the exact targetless input followed by one replay-safe failure result', async () => {
      const source = await store.append(
        canonicalFixture({
          userId: 'owner-redis',
          threadId: 'thread-redis-lifecycle',
          catId: null,
          content: '请继续',
          mentions: [],
          timestamp: 90,
          deliveryStatus: 'queued',
          queueCustody: {
            version: 1,
            entryId: 'entry-redis-targetless',
            revision: 1,
            ownerUserId: 'owner-redis',
            ownerAuthProvenance: 'strict',
            intent: 'execute',
            status: 'queued',
            allTargetCats: [],
            pendingTargetCats: [],
            notifiedByCatIds: [],
            seenByCatIds: [],
            seenInvocationIdByCatId: {},
            targetAttempts: [],
            failedByCatIds: [],
            handledByCatIds: [],
            priority: 'normal',
            createdAt: 90,
            updatedAt: 90,
          },
        }),
      );
      const input = {
        sourceMessageId: source.id,
        expectedEntryId: 'entry-redis-targetless',
        expectedQueueCustodyRevision: 1,
        requestedTargets: [],
        reason: 'no_available_target',
        content: '没有可用成员可以处理这条消息。',
        contentBlocks: [{ type: 'text', text: '没有可用成员可以处理这条消息。' }],
        failedAt: 100,
      };

      const applied = await store.commitLifecyclePreAdmissionFailure(input);
      assert.equal(applied.kind, 'applied');
      assert.equal(applied.inputMessage.deliveryStatus, 'delivered');
      assert.equal(applied.inputMessage.queueCustody, undefined);
      assert.equal(applied.inputMessage.lifecycle.kind, 'input');
      assert.equal(applied.failureMessage.lifecycle.kind, 'delivery_failure');
      assert.equal(applied.failureMessage.lifecycle.inputMessageId, source.id);
      assert.deepEqual(
        (await store.getByThread(source.threadId)).map((message) => message.id),
        [source.id, applied.failureMessage.id],
      );

      const replayed = await store.commitLifecyclePreAdmissionFailure(input);
      assert.equal(replayed.kind, 'replayed');
      assert.equal(replayed.failureMessage.id, applied.failureMessage.id);
      assert.equal((await store.getByThread(source.threadId)).length, 2);
    });

    test('reports a lifecycle conflict when public-wake metadata changes between read and custody CAS', async () => {
      const source = await store.append(
        canonicalFixture({
          userId: 'owner-redis',
          threadId: 'thread-redis-wake-race',
          catId: 'opus',
          content: '@codex please review',
          mentions: ['codex'],
          timestamp: 90,
          origin: 'callback',
        }),
      );
      const originalGetById = store.getById.bind(store);
      let injectLifecycleRace = true;
      store.getById = async (messageId) => {
        const current = await originalGetById(messageId);
        if (injectLifecycleRace && messageId === source.id && current) {
          injectLifecycleRace = false;
          const racedLifecycle = current.lifecycle ?? {
            kind: 'input',
            orderKey: `${current.timestamp}:${current.id}`,
            from: { kind: 'agent', catId: 'opus' },
          };
          await redis.hset(
            `msg:${messageId}`,
            'lifecycle',
            JSON.stringify({
              ...racedLifecycle,
              dispatchRefs: [{ targetId: 'parallel-writer', phase: 'assigned' }],
            }),
          );
        }
        return current;
      };

      try {
        const initialized = await store.initializeQueueCustody(source.id, {
          version: 1,
          entryId: 'entry-redis-wake-race',
          revision: 1,
          ownerUserId: 'owner-redis',
          ownerAuthProvenance: 'strict',
          intent: 'execute',
          status: 'queued',
          allTargetCats: ['codex'],
          pendingTargetCats: ['codex'],
          notifiedByCatIds: [],
          seenByCatIds: [],
          seenInvocationIdByCatId: {},
          failedByCatIds: [],
          handledByCatIds: [],
          priority: 'normal',
          createdAt: 90,
          updatedAt: 90,
        });

        assert.equal(initialized.kind, 'lifecycle_conflict');
      } finally {
        store.getById = originalGetById;
      }
    });

    test('keeps public agent speech visible and atomically settles its assigned wake to the failure result', async () => {
      const source = await store.append(
        canonicalFixture({
          userId: 'owner-redis',
          threadId: 'thread-redis-wake-failure',
          catId: 'opus',
          content: '@codex please review',
          mentions: ['codex'],
          timestamp: 90,
          origin: 'callback',
        }),
      );
      const initialized = await store.initializeQueueCustody(source.id, {
        version: 1,
        entryId: 'entry-redis-wake',
        revision: 1,
        ownerUserId: 'owner-redis',
        ownerAuthProvenance: 'strict',
        intent: 'execute',
        status: 'queued',
        allTargetCats: ['codex'],
        pendingTargetCats: ['codex'],
        notifiedByCatIds: [],
        seenByCatIds: [],
        seenInvocationIdByCatId: {},
        targetAttempts: [
          {
            id: 'entry-redis-wake:codex:1',
            targetCatId: 'codex',
            sequence: 1,
            state: 'queued',
            createdAt: 90,
            updatedAt: 90,
          },
        ],
        failedByCatIds: [],
        handledByCatIds: [],
        priority: 'normal',
        createdAt: 90,
        updatedAt: 90,
      });
      assert.equal(initialized.kind, 'initialized');

      const input = {
        sourceMessageId: source.id,
        expectedEntryId: 'entry-redis-wake',
        expectedQueueCustodyRevision: 1,
        requestedTargets: ['codex'],
        reason: 'invalid_explicit_target',
        content: '消息未能送达：指定的接收对象当前无效。',
        failedAt: 100,
      };
      const applied = await store.commitLifecyclePreAdmissionFailure(input);

      assert.equal(applied.kind, 'applied');
      assert.equal(applied.inputMessage.deliveryStatus, undefined);
      assert.equal(applied.inputMessage.deliveredAt, undefined);
      assert.equal(applied.inputMessage.queueCustody, undefined);
      assert.deepEqual(applied.inputMessage.lifecycle.dispatchRefs, [
        { targetId: 'codex', phase: 'settled', statusMessageId: applied.failureMessage.id },
      ]);
      assert.deepEqual(
        (await store.getByThread(source.threadId)).map((message) => message.id),
        [source.id, applied.failureMessage.id],
      );

      const replayed = await store.commitLifecyclePreAdmissionFailure(input);
      assert.equal(replayed.kind, 'replayed');
      assert.equal(replayed.failureMessage.id, applied.failureMessage.id);
    });

    test('rejects an invalid failure timestamp without mutating the queued source', async () => {
      const source = await store.append(
        canonicalFixture({
          userId: 'owner-redis',
          threadId: 'thread-redis-invalid',
          catId: null,
          content: 'invalid terminal time',
          mentions: [],
          timestamp: 90,
          deliveryStatus: 'queued',
          queueCustody: {
            version: 1,
            entryId: 'entry-redis-invalid',
            revision: 1,
            ownerUserId: 'owner-redis',
            ownerAuthProvenance: 'strict',
            intent: 'execute',
            status: 'queued',
            allTargetCats: [],
            pendingTargetCats: [],
            notifiedByCatIds: [],
            seenByCatIds: [],
            seenInvocationIdByCatId: {},
            targetAttempts: [],
            failedByCatIds: [],
            handledByCatIds: [],
            priority: 'normal',
            createdAt: 90,
            updatedAt: 90,
          },
        }),
      );

      const result = await store.commitLifecyclePreAdmissionFailure({
        sourceMessageId: source.id,
        expectedEntryId: 'entry-redis-invalid',
        expectedQueueCustodyRevision: 1,
        requestedTargets: [],
        reason: 'no_available_target',
        content: 'invalid',
        failedAt: -1,
      });

      assert.deepEqual({ kind: result.kind, reason: result.reason }, { kind: 'conflict', reason: 'invalid_failure' });
      const unchanged = await store.getById(source.id);
      assert.equal(unchanged.deliveryStatus, 'queued');
      assert.equal(unchanged.lifecycle, undefined);
      assert.equal(unchanged.queueCustody.entryId, 'entry-redis-invalid');
    });
  },
);
