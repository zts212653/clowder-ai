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
    let RedisMessageStore;
    let connected = false;

    before(async () => {
      assertRedisIsolationOrThrow(REDIS_URL, 'RedisMessageStore lifecycle pre-admission failure transaction');
      const [{ createRedisClient }, messageStoreModule] = await Promise.all([
        import('@cat-cafe/shared/utils'),
        import('../dist/domains/cats/services/stores/redis/RedisMessageStore.js'),
      ]);
      ({ RedisMessageStore } = messageStoreModule);
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
          { targetId: 'opus', invocationId: 'turn-opus', responseMessageId: opus.id, dispatchedAt: 101 },
          { targetId: 'codex', invocationId: 'turn-codex', responseMessageId: codex.id, dispatchedAt: 102 },
        ],
      };

      assert.equal((await store.commitLifecycleAppendAdmission(admission)).kind, 'applied');
      assert.deepEqual((await store.getById(input.id)).lifecycle.dispatchRefs, [
        { targetId: 'opus', phase: 'dispatched', statusMessageId: opus.id, dispatchedAt: 101 },
        { targetId: 'codex', phase: 'dispatched', statusMessageId: codex.id, dispatchedAt: 102 },
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
        { targetId: 'opus', phase: 'dispatched', statusMessageId: opus.id, dispatchedAt: 101 },
        { targetId: 'codex', phase: 'settled', statusMessageId: failure.id, dispatchedAt: 102 },
      ]);
      assert.deepEqual((await store.getById(codex.id)).lifecycle.inputMessageIds, ['message-old']);
      assert.equal((await store.commitLifecycleAppendRejection(rejection)).kind, 'replayed');
    });

    test('publishes a lifecycle response to cursor reads only with its terminal body', async () => {
      const threadId = 'thread-redis-terminal-visibility';
      const processing = (
        await store.appendAndObservePriorFrontier(
          canonicalFixture({
            userId: 'owner-redis',
            threadId,
            catId: 'opus',
            content: '',
            mentions: [],
            timestamp: 100,
            lifecycle: {
              kind: 'response',
              orderKey: '100:terminal-visibility',
              from: { kind: 'agent', catId: 'opus' },
              invocationId: 'inv-terminal-visibility',
              targetId: 'opus',
              inputEntryIds: ['entry-terminal-visibility'],
              inputMessageIds: ['message-terminal-visibility'],
              status: 'processing',
              startedAt: 100,
            },
          }),
        )
      ).message;

      assert.equal((await redis.hget(`msg:${processing.id}`, 'visibilitySeq')) ?? null, null);
      assert.deepEqual(await store.getByThreadAfter(threadId, undefined, undefined, 'owner-redis'), []);

      const terminal = await store.commitLifecycleResponseTerminal(processing.id, {
        invocationId: 'inv-terminal-visibility',
        status: 'failed',
        completedAt: 200,
        reason: 'provider_error',
        content:
          '@opus 处理失败（provider_error）。\n\n来源消息：message-terminal-visibility。\n\nProvider quota exhausted.',
        mentions: [],
        origin: 'stream',
      });

      assert.equal(terminal.kind, 'applied');
      assert.equal(typeof terminal.message.visibilitySeq, 'number');
      assert.equal(
        await redis.zscore(`msg:visibility:${threadId}`, processing.id),
        String(terminal.message.visibilitySeq),
      );
      const visible = await store.getByThreadAfter(threadId, undefined, undefined, 'owner-redis');
      assert.deepEqual(
        visible.map((message) => message.id),
        [processing.id],
      );
      assert.match(visible[0].content, /@opus 处理失败/);
      assert.match(visible[0].content, /来源消息：message-terminal-visibility/);
      assert.match(visible[0].content, /Provider quota exhausted/);
    });

    test('repairs terminal lifecycle responses omitted by the first single-ledger rollout', async () => {
      const threadId = 'thread-redis-terminal-visibility-repair';
      const response = await store.append(
        canonicalFixture({
          userId: 'owner-redis',
          threadId,
          catId: 'opus',
          content: 'already terminal',
          mentions: [],
          timestamp: 100,
          lifecycle: {
            kind: 'response',
            orderKey: '100:terminal-repair',
            from: { kind: 'agent', catId: 'opus' },
            invocationId: 'inv-terminal-repair',
            targetId: 'opus',
            inputEntryIds: ['entry-terminal-repair'],
            inputMessageIds: ['message-terminal-repair'],
            status: 'completed',
            startedAt: 90,
            completedAt: 100,
          },
        }),
      );
      await redis.zrem(`msg:visibility:${threadId}`, response.id);
      await redis.hdel(`msg:${response.id}`, 'visibilitySeq');
      await redis.hdel(`msg:visibility-meta:${threadId}`, 'terminalResponseRepair');

      const visible = await store.getByThreadAfter(threadId, undefined, undefined, 'owner-redis');

      assert.deepEqual(
        visible.map((message) => message.id),
        [response.id],
      );
      assert.equal(typeof visible[0].visibilitySeq, 'number');
      assert.equal(await redis.hget(`msg:visibility-meta:${threadId}`, 'terminalResponseRepair'), '1');
    });

    test('preserves a child settle that races with parent response terminalization', async () => {
      const processing = await store.append(
        canonicalFixture({
          userId: 'owner-redis',
          threadId: 'thread-redis-parent-child-race',
          catId: 'opus',
          content: '',
          mentions: [],
          timestamp: 100,
          lifecycle: {
            kind: 'response',
            orderKey: '0000000000100:response-parent-child-race',
            from: { kind: 'agent', catId: 'opus' },
            invocationId: 'invocation-parent-child-race',
            targetId: 'opus',
            inputEntryIds: ['entry-parent'],
            inputMessageIds: ['message-parent'],
            status: 'processing',
            startedAt: 100,
            dispatchRefs: [{ targetId: 'codex', phase: 'dispatched', statusMessageId: 'child-response' }],
          },
        }),
      );
      let injectedChildSettle = false;
      const racingRedis = new Proxy(redis, {
        get(target, property) {
          if (property === 'eval') {
            return async (...args) => {
              const script = args[0];
              if (
                !injectedChildSettle &&
                typeof script === 'string' &&
                script.includes("existing.status == 'processing'") &&
                script.includes('existingRaw ~= ARGV[14]')
              ) {
                injectedChildSettle = true;
                const settled = await store.advanceLifecycleInputDispatch(processing.id, {
                  orderKey: processing.lifecycle.orderKey,
                  targetId: 'codex',
                  phase: 'settled',
                  statusMessageId: 'child-response',
                });
                assert.equal(settled.kind, 'applied');
              }
              return target.eval(...args);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      const racingStore = new RedisMessageStore(racingRedis, { ttlSeconds: 0 });

      const terminal = await racingStore.commitLifecycleResponseTerminal(processing.id, {
        invocationId: 'invocation-parent-child-race',
        status: 'completed',
        completedAt: 200,
        content: 'parent complete',
        mentions: [],
        origin: 'stream',
      });

      assert.equal(injectedChildSettle, true, 'test must settle the child after the parent read and before its write');
      assert.equal(terminal.kind, 'applied');
      assert.equal(terminal.message.lifecycle.status, 'completed');
      assert.deepEqual(terminal.message.lifecycle.dispatchRefs, [
        { targetId: 'codex', phase: 'settled', statusMessageId: 'child-response' },
      ]);
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
        }),
      );
      const input = {
        sourceMessageId: source.id,
        expectedEntryId: 'entry-redis-targetless',
        requestedTargets: [],
        reason: 'no_available_target',
        content: '没有可用成员可以处理这条消息。',
        contentBlocks: [{ type: 'text', text: '没有可用成员可以处理这条消息。' }],
        failedAt: 100,
      };

      const applied = await store.commitLifecyclePreAdmissionFailure(input);
      assert.equal(applied.kind, 'applied');
      assert.equal(applied.inputMessage.deliveryStatus, 'delivered');
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

    test('keeps public agent speech visible and atomically records its failed dispatch result', async () => {
      const source = await store.append(
        canonicalFixture({
          userId: 'owner-redis',
          threadId: 'thread-redis-wake-failure',
          catId: 'opus',
          content: '@codex please review',
          mentions: ['codex'],
          timestamp: 90,
          origin: 'callback',
          lifecycle: {
            kind: 'input',
            orderKey: '0000000000090:agent-wake',
            dispatchRefs: [],
          },
        }),
      );

      const input = {
        sourceMessageId: source.id,
        expectedEntryId: 'entry-redis-wake',
        requestedTargets: ['codex'],
        reason: 'invalid_explicit_target',
        content: '消息未能送达：指定的接收对象当前无效。',
        failedAt: 100,
      };
      const applied = await store.commitLifecyclePreAdmissionFailure(input);

      assert.equal(applied.kind, 'applied');
      assert.equal(applied.inputMessage.deliveryStatus, undefined);
      assert.equal(applied.inputMessage.deliveredAt, undefined);
      assert.deepEqual(applied.inputMessage.lifecycle.dispatchRefs, [
        { targetId: 'codex', phase: 'settled', statusMessageId: applied.failureMessage.id, dispatchedAt: 100 },
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
        }),
      );

      const result = await store.commitLifecyclePreAdmissionFailure({
        sourceMessageId: source.id,
        expectedEntryId: 'entry-redis-invalid',
        requestedTargets: [],
        reason: 'no_available_target',
        content: 'invalid',
        failedAt: -1,
      });

      assert.deepEqual({ kind: result.kind, reason: result.reason }, { kind: 'conflict', reason: 'invalid_failure' });
      const unchanged = await store.getById(source.id);
      assert.equal(unchanged.deliveryStatus, 'queued');
      assert.equal(unchanged.lifecycle, undefined);
    });
  },
);
