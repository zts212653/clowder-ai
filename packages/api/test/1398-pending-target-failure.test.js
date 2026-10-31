import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';

async function createStore(t, kind) {
  if (kind !== 'redis') return { store: new MessageStore() };
  assertRedisIsolationOrThrow(process.env.REDIS_URL, 'PR1398 remaining Queue recipient failure');
  const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `test-pr1398-failure:${randomUUID()}:` });
  t.after(async () => {
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });
  return { store: new RedisMessageStore(redis, { ttlSeconds: 0 }), redis };
}

for (const kind of ['memory', 'redis']) {
  test(
    `${kind}: remaining target failure preserves the successful sibling and original publication`,
    {
      skip: kind === 'redis' ? redisIsolationSkipReason(process.env.REDIS_URL) : false,
    },
    async (t) => {
      const { store } = await createStore(t, kind);
      const sibling = { targetId: 'opus', phase: 'settled', statusMessageId: 'successful-response', dispatchedAt: 100 };
      const source = await store.append({
        from: { kind: 'user', userId: 'owner' },
        userId: 'owner',
        threadId: 'thread',
        content: 'original input',
        mentions: ['opus', 'codex'],
        timestamp: 90,
        deliveryStatus: 'queued',
        lifecycle: { kind: 'input', orderKey: '90:source', dispatchRefs: [] },
      });
      await store.advanceLifecycleInputDispatch(source.id, {
        orderKey: '90:source',
        targetId: 'opus',
        statusMessageId: 'successful-response',
        phase: 'dispatched',
        dispatchedAt: 100,
      });
      await store.advanceLifecycleInputDispatch(source.id, {
        orderKey: '90:source',
        targetId: 'opus',
        statusMessageId: 'successful-response',
        phase: 'settled',
      });
      const published = await store.markDelivered(source.id, 100);
      const appendObservations = [];
      if (kind === 'memory')
        store.onAppend = (message) => {
          appendObservations.push({ messageId: message.id, source: structuredClone(store.getById(source.id)) });
        };
      const input = {
        sourceMessageId: source.id,
        expectedEntryId: 'entry',
        requestedTargets: ['codex'],
        reason: 'invalid_explicit_target',
        content: 'The pending recipient is unavailable',
        failedAt: 200,
      };
      const [first, second] = await Promise.all([
        store.commitLifecyclePreAdmissionFailure(input),
        store.commitLifecyclePreAdmissionFailure(input),
      ]);
      assert.deepEqual([first.kind, second.kind].sort(), ['applied', 'replayed']);
      const current = await store.getById(source.id);
      assert.equal(current.deliveredAt, 100);
      assert.equal(current.timelineOrderAt, 100);
      assert.equal(current.visibilitySeq, published.visibilitySeq);
      assert.deepEqual(current.lifecycle.dispatchRefs[0], sibling);
      assert.equal(current.lifecycle.dispatchRefs[1].targetId, 'codex');
      assert.equal(current.lifecycle.dispatchRefs[1].statusMessageId, first.failureMessage.id);
      assert.equal((await store.getByThread('thread')).length, 2);
      const changed = await store.commitLifecyclePreAdmissionFailure({
        ...input,
        expectedEntryId: 'another-entry',
        requestedTargets: ['opus'],
      });
      assert.equal(changed.kind, 'conflict', 'an already delivered sibling cannot be relabeled as undelivered');
      assert.deepEqual((await store.getById(source.id)).lifecycle.dispatchRefs[0], sibling);
      if (kind === 'memory') {
        assert.equal(appendObservations.length, 1, 'a rejected failure must not notify downstream append consumers');
        assert.equal(appendObservations[0].messageId, first.failureMessage.id);
        assert.deepEqual(
          appendObservations[0].source.lifecycle.dispatchRefs,
          current.lifecycle.dispatchRefs,
          'a successful failure notification observes the fully settled source',
        );
        assert.equal(appendObservations[0].source.deliveredAt, 100);
      }
    },
  );
}

for (const kind of ['memory', 'redis'])
  test(
    `${kind}: all unavailable queued recipients settle in one replay-safe transaction`,
    {
      skip: kind === 'redis' ? redisIsolationSkipReason(process.env.REDIS_URL) : false,
    },
    async (t) => {
      const { store } = await createStore(t, kind);
      const source = await store.append({
        from: { kind: 'user', userId: 'owner' },
        userId: 'owner',
        threadId: 'thread',
        content: 'two recipients',
        mentions: ['opus', 'codex'],
        timestamp: 90,
        deliveryStatus: 'queued',
      });
      const input = {
        sourceMessageId: source.id,
        expectedEntryId: 'entry',
        requestedTargets: ['opus', 'codex'],
        reason: 'invalid_explicit_target',
        content: 'Both recipients are unavailable',
        failedAt: 200,
      };
      const results = await Promise.all([
        store.commitLifecyclePreAdmissionFailure(input),
        store.commitLifecyclePreAdmissionFailure(input),
      ]);
      assert.deepEqual(results.map((result) => result.kind).sort(), ['applied', 'replayed']);
      const current = await store.getById(source.id);
      assert.ok(current);
      assert.equal(current.deliveryStatus, 'delivered');
      assert.deepEqual(
        current.lifecycle?.dispatchRefs?.map((ref) => ref.targetId),
        ['opus', 'codex'],
      );
      const history = await store.getByThread('thread');
      assert.equal(history.length, 2);
      assert.equal(
        current.lifecycle?.dispatchRefs?.every((ref) => ref.statusMessageId === history[1].id),
        true,
      );
    },
  );

test(
  'Redis failure CAS preserves a recipient that became dispatched after the source read',
  {
    skip: redisIsolationSkipReason(process.env.REDIS_URL),
  },
  async (t) => {
    const { store, redis } = await createStore(t, 'redis');
    assert.ok(redis);
    const source = await store.append({
      from: { kind: 'user', userId: 'owner' },
      userId: 'owner',
      threadId: 'thread',
      content: 'race',
      mentions: ['opus', 'codex'],
      timestamp: 90,
      deliveryStatus: 'queued',
      lifecycle: { kind: 'input', orderKey: '90:source', dispatchRefs: [] },
    });
    await store.advanceLifecycleInputDispatch(source.id, {
      orderKey: '90:source',
      targetId: 'opus',
      statusMessageId: 'opus-response',
      phase: 'dispatched',
      dispatchedAt: 100,
    });
    await store.markDelivered(source.id, 100);
    const originalEval = redis.eval.bind(redis);
    let injected = false;
    redis.eval = async (...args) => {
      if (!injected && typeof args[0] === 'string' && args[0].includes('local sourceHash = KEYS[1]')) {
        injected = true;
        assert.equal(
          (
            await store.advanceLifecycleInputDispatch(source.id, {
              orderKey: '90:source',
              targetId: 'codex',
              statusMessageId: 'codex-response',
              phase: 'dispatched',
              dispatchedAt: 150,
            })
          ).kind,
          'applied',
        );
      }
      return Reflect.apply(originalEval, redis, args);
    };
    t.after(() => {
      redis.eval = originalEval;
    });
    const result = await store.commitLifecyclePreAdmissionFailure({
      sourceMessageId: source.id,
      expectedEntryId: 'entry',
      requestedTargets: ['codex'],
      reason: 'invalid_explicit_target',
      content: 'stale failure',
      failedAt: 200,
    });
    assert.equal(injected, true);
    assert.equal(result.kind, 'conflict');
    const current = await store.getById(source.id);
    assert.deepEqual(
      current.lifecycle.dispatchRefs.map((ref) => ref.statusMessageId),
      ['opus-response', 'codex-response'],
    );
    assert.equal(current.deliveredAt, 100);
    assert.equal(
      (await store.getByThread('thread')).length,
      1,
      'CAS failure must leave no failure record or index entry',
    );
  },
);
