import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
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
import { createTypedWaitMetricReader } from './helpers/typed-wait-metrics.js';

const telemetry = createTypedWaitMetricReader();
after(() => telemetry.close());

describe(
  'typed wait registration and Queue share atomic Redis authority',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  () => {
    async function harness(t) {
      assertRedisIsolationOrThrow(process.env.REDIS_URL, 'typed-wait-queue');
      const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `typed-wait-${randomUUID()}:` });
      await redis.ping();
      t.after(async () => {
        await cleanupClientKeyspace(redis);
        await redis.quit();
      });
      const taskStore = new RedisTaskStore(redis);
      const h = await createTypedWaitCustodyFixture({ messageStore: new RedisMessageStore(redis), taskStore });
      return { ...h, redis };
    }

    test('private receipt survives a new store instance; public hydration and replay stay clean', async (t) => {
      const h = await harness(t);
      const cold = new RedisTaskStore(h.redis);
      assert.deepEqual((await cold.getWaitRegistration(h.task.id)).receipt, h.receipt);
      assert.equal(JSON.stringify(await cold.get(h.task.id)).includes('typedWaitRegistration'), false);
      const before = await telemetry.read();
      await h.commit();
      await h.taskStore.update(h.task.id, { status: 'done' });
      await h.commit();
      const source = await h.store.getById(h.message.id);
      assert.equal(source.deliveryStatus, 'delivered');
      assert.deepEqual(source.queueCustody.handledByCatIds, ['opus']);
      assert.equal((await telemetry.read()).falseBypass, before.falseBypass);
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
      assert.ok(
        await h.taskStore.replaceAutomationStateIfGeneration(h.task.id, {
          expectedGeneration: 1,
          automationState: { await: active },
          waitRegistration: nextReceipt,
        }),
      );
      const next = await new RedisTaskStore(h.redis).getWaitRegistration(h.task.id);
      assert.equal(next.task.automationState.await.generation, 2);
      assert.equal(next.receipt.invocationId, 'child-2');
      const before = await telemetry.read();
      await assert.rejects(h.commit, /typed wait/);
      const after = await telemetry.read();
      assert.equal(after.falseBypass, before.falseBypass + 1);
      assert.equal(after['event_wait.rejected_stale_total'], before['event_wait.rejected_stale_total'] + 1);
    });

    test('Lua checks expiry against server time even when the Task hash is unchanged', async (t) => {
      const h = await harness(t);
      const active = { ...h.active, expiresAt: Date.now() + 100 };
      const receipt = createTypedWaitRegistration({
        task: h.task,
        active,
        invocationId: 'child-1',
        source: h.receipt.source,
      });

      await h.taskStore.replaceAutomationStateIfGeneration(h.task.id, {
        expectedGeneration: 1,
        automationState: { await: active },
        waitRegistration: receipt,
      });
      const evaluate = h.redis.eval.bind(h.redis);
      h.redis.eval = async (script, ...args) => {
        if (script.includes('local waitGuards ='))
          await new Promise((resolve) => setTimeout(resolve, Math.max(0, active.expiresAt - Date.now()) + 10));
        return evaluate(script, ...args);
      };
      const before = await telemetry.read();
      await assert.rejects(h.commit, /typed wait/);
      assert.deepEqual((await h.store.getById(h.message.id)).queueCustody.handledByCatIds, []);
      const after = await telemetry.read();
      assert.equal(after.falseBypass, before.falseBypass + 1);
      assert.equal(after['event_wait.rejected_stale_total'], before['event_wait.rejected_stale_total'] + 1);
    });

    test('a collector-only update during Queue CAS leaves the same active registration valid', async (t) => {
      const h = await harness(t);
      const evaluate = h.redis.eval.bind(h.redis);
      let injected = false;
      h.redis.eval = async (script, ...args) => {
        if (!injected && script.includes('local waitGuards =')) {
          injected = true;
          await h.taskStore.patchAutomationState(h.task.id, {
            ci: { headSha: 'head-1', lastNotificationBucket: 'pending' },
          });
        }
        return evaluate(script, ...args);
      };
      const before = await telemetry.read();
      await h.commit();
      assert.equal(injected, true);
      assert.deepEqual((await h.store.getById(h.message.id)).queueCustody.handledByCatIds, ['opus']);
      assert.equal((await telemetry.read()).falseBypass, before.falseBypass);
    });

    test('a failed canonical Task read reports one bounded rejection', async (t) => {
      const h = await harness(t);
      const read = h.redis.hgetall.bind(h.redis);
      h.redis.hgetall = async (key) => {
        if (key === TaskKeys.detail(h.task.id)) throw new Error('Task connection unavailable');
        return read(key);
      };
      const before = await telemetry.read();
      await assert.rejects(h.commit);
      const after = await telemetry.read();
      assert.equal(after.falseBypass, before.falseBypass + 1);
      assert.equal(
        after['event_wait.rejected_query_failed_total'],
        before['event_wait.rejected_query_failed_total'] + 1,
      );
      assert.equal((await h.store.getById(h.message.id)).deliveryStatus, 'queued');
    });

    for (const race of ['matched', 'expired', 'superseded', 'owner', 'deleted']) {
      test(`Lua rejects ${race} between proof read and Queue mutation`, async (t) => {
        const h = await harness(t);
        const evaluate = h.redis.eval.bind(h.redis);
        let injected = false;
        h.redis.eval = async (script, ...args) => {
          if (!injected && script.includes('local waitGuards =')) {
            injected = true;
            if (race === 'deleted') await h.taskStore.delete(h.task.id);
            else if (race === 'owner') await h.redis.hset(TaskKeys.detail(h.task.id), 'ownerCatId', 'foreign-cat');
            else {
              const active = structuredClone(h.active);
              if (race === 'expired') active.expiresAt = Date.now() - 1;
              if (race === 'superseded') {
                active.generation = 2;
                active.ownerFence.generation = 2;
              }
              await h.taskStore.replaceAutomationStateIfGeneration(h.task.id, {
                expectedGeneration: 1,
                automationState:
                  race === 'matched' ? { waitOutcome: { generation: 1, reason: 'matched' } } : { await: active },
              });
            }
          }
          return evaluate(script, ...args);
        };
        const before = await telemetry.read();
        await assert.rejects(h.commit, /typed wait/);
        assert.equal(injected, true);
        const source = await h.store.getById(h.message.id);
        assert.equal(source.deliveryStatus, 'queued');
        assert.deepEqual(source.queueCustody.handledByCatIds, []);
        const after = await telemetry.read();
        assert.equal(after.falseBypass, before.falseBypass + 1);
        assert.equal(after['event_wait.rejected_stale_total'], before['event_wait.rejected_stale_total'] + 1);
        assert.match(after.text, /routing_event_wait_reason="authority_changed"/);
      });
    }
  },
);
