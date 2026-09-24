import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { resolveTypedWaitContinuation } from '../dist/domains/ball-custody/TypedWaitContinuation.js';
import { createTypedWaitRegistration } from '../dist/domains/ball-custody/TypedWaitRegistration.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { RedisTaskStore } from '../dist/domains/cats/services/stores/redis/RedisTaskStore.js';
import { TaskKeys } from '../dist/domains/cats/services/stores/redis-keys/task-keys.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';
import { createTypedWaitCustodyFixture } from './helpers/typed-wait-custody-fixture.js';

describe(
  'typed wait registration keeps exact private Redis authority',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  () => {
    async function harness(t) {
      assertRedisIsolationOrThrow(process.env.REDIS_URL, 'typed-wait-registration');
      const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `typed-wait-${randomUUID()}:` });
      await redis.ping();
      t.after(async () => {
        await cleanupClientKeyspace(redis);
        await redis.quit();
      });
      const taskStore = new RedisTaskStore(redis);
      const h = await createTypedWaitCustodyFixture({ messageStore: new RedisMessageStore(redis), taskStore });
      const identity = {
        invocationId: 'child-1',
        userId: 'user-1',
        catId: 'opus',
        threadId: 'thread-wait',
        sourceMessageId: h.message.id,
        holdTaskId: 'hold-1',
      };
      return { ...h, redis, identity };
    }

    test('private receipt survives a new store instance and public hydration stays clean', async (t) => {
      const h = await harness(t);
      const cold = new RedisTaskStore(h.redis);
      assert.deepEqual((await cold.getWaitRegistration(h.task.id)).receipt, h.receipt);
      assert.equal(JSON.stringify(await cold.get(h.task.id)).includes('typedWaitRegistration'), false);
      assert.equal((await resolveTypedWaitContinuation({ taskStore: cold, ...h.identity })).kind, 'bypass');
    });

    test('a losing Task CAS cannot overwrite the winning generation receipt', async (t) => {
      const h = await harness(t);
      const active = { ...h.active, generation: 2, ownerFence: { kind: 'containing_task', generation: 2 } };
      const nextReceipt = createTypedWaitRegistration({
        task: h.task,
        active,
        invocationId: 'child-2',
        source: h.receipt.source,
      });
      assert.equal(
        await h.taskStore.replaceAutomationStateIfGeneration(h.task.id, {
          expectedGeneration: 0,
          automationState: { await: active },
          waitRegistration: nextReceipt,
        }),
        null,
      );
      assert.deepEqual((await h.taskStore.getWaitRegistration(h.task.id)).receipt, h.receipt);
    });

    test('collector-only updates retain the same active registration', async (t) => {
      const h = await harness(t);
      await h.taskStore.patchAutomationState(h.task.id, {
        ci: { headSha: 'head-1', lastNotificationBucket: 'pending' },
      });
      assert.equal((await resolveTypedWaitContinuation({ taskStore: h.taskStore, ...h.identity })).kind, 'bypass');
    });

    test('expiry and generation replacement fail closed on a fresh canonical read', async (t) => {
      const h = await harness(t);
      assert.equal(
        (await resolveTypedWaitContinuation({ taskStore: h.taskStore, ...h.identity, now: h.active.expiresAt + 1 }))
          .kind,
        'reject',
      );
      const active = { ...h.active, generation: 2, ownerFence: { kind: 'containing_task', generation: 2 } };
      await h.taskStore.replaceAutomationStateIfGeneration(h.task.id, {
        expectedGeneration: 1,
        automationState: { await: active },
      });
      assert.equal((await resolveTypedWaitContinuation({ taskStore: h.taskStore, ...h.identity })).kind, 'reject');
    });

    test('a failed canonical Task read reports query_failed', async (t) => {
      const h = await harness(t);
      const read = h.redis.hgetall.bind(h.redis);
      h.redis.hgetall = async (key) => {
        if (key === TaskKeys.detail(h.task.id)) throw new Error('Task connection unavailable');
        return read(key);
      };
      assert.deepEqual(await resolveTypedWaitContinuation({ taskStore: h.taskStore, ...h.identity }), {
        kind: 'reject',
        reason: 'query_failed',
      });
    });
  },
);
