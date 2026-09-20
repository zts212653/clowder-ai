import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { createTypedWaitRegistration } from '../dist/domains/ball-custody/TypedWaitRegistration.js';
import { TaskStore } from '../dist/domains/cats/services/stores/ports/TaskStore.js';
import { RedisTaskStore } from '../dist/domains/cats/services/stores/redis/RedisTaskStore.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from './helpers/redis-test-helpers.js';
import { createTypedWaitCustodyFixture } from './helpers/typed-wait-custody-fixture.js';

for (const backend of ['memory', 'redis']) {
  describe(
    `tracking registration commits one aggregate (${backend})`,
    {
      skip: backend === 'redis' ? redisIsolationSkipReason(process.env.REDIS_URL) : false,
    },
    () => {
      async function fixture(t) {
        let taskStore = new TaskStore();
        if (backend === 'redis') {
          assertRedisIsolationOrThrow(process.env.REDIS_URL, 'tracking-registration-atomicity');
          const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `registration-${randomUUID()}:` });
          await redis.ping();
          t.after(async () => {
            await cleanupClientKeyspace(redis);
            await redis.quit();
          });
          taskStore = new RedisTaskStore(redis);
        }
        const h = await createTypedWaitCustodyFixture({ taskStore });
        const original = await taskStore.get(h.task.id);
        const candidate = (suffix) => {
          const active = { ...h.active, generation: 2, ownerFence: { kind: 'containing_task', generation: 2 } };
          const trackingRegistration = {
            threadId: `thread-${suffix}`,
            ownerCatId: 'codex',
            userId: original.userId,
            title: `Registration ${suffix}`,
            why: `Wait ${suffix}`,
            managedWorkBinding: { workId: `work-${suffix}`, attemptId: `attempt-${suffix}` },
          };
          return {
            expectedGeneration: 1,
            expectedUpdatedAt: original.updatedAt,
            automationState: { await: active },
            trackingRegistration,
            waitRegistration: createTypedWaitRegistration({
              task: { ...original, ...trackingRegistration },
              active,
              invocationId: `invocation-${suffix}`,
              source: h.receipt.source,
            }),
          };
        };
        const assertUnchanged = async (binding = null) => {
          assert.deepEqual(await taskStore.get(original.id), original);
          assert.deepEqual((await taskStore.getWaitRegistration(original.id)).receipt, h.receipt);
          assert.deepEqual(await taskStore.getManagedWorkBinding(original.id), binding);
          assert.deepEqual(
            (await taskStore.listByThread(original.threadId)).map((task) => task.id),
            [original.id],
          );
          assert.deepEqual(await taskStore.listByThread('thread-new'), []);
        };
        return { ...h, original, candidate, assertUnchanged };
      }

      for (const stale of ['generation', 'revision']) {
        it(`a stale ${stale} changes neither destination nor private receipts/binding`, async (t) => {
          const h = await fixture(t);
          const input = h.candidate('new');
          if (stale === 'generation') input.expectedGeneration = 0;
          else input.expectedUpdatedAt -= 1;
          assert.equal(await h.taskStore.replaceAutomationStateIfGeneration(h.task.id, input), null);
          await h.assertUnchanged();
        });
      }

      it('invalid private receipt cannot leave a managed-work binding or owner change', async (t) => {
        const h = await fixture(t);
        const input = h.candidate('new');
        input.waitRegistration.catId = 'wrong-owner';
        await assert.rejects(async () => h.taskStore.replaceAutomationStateIfGeneration(h.task.id, input));
        await h.assertUnchanged();
      });

      it('a conflicting managed-work binding rejects the whole registration', async (t) => {
        const h = await fixture(t);
        const binding = { workId: 'prior-work', attemptId: 'prior-attempt' };
        await h.taskStore.bindManagedWorkBinding(h.task.id, binding);
        await assert.rejects(
          async () => h.taskStore.replaceAutomationStateIfGeneration(h.task.id, h.candidate('new')),
          { code: 'TASK_MANAGED_WORK_BINDING_CONFLICT' },
        );
        await h.assertUnchanged(binding);
      });

      it('an expiry newly owed by supersession cannot migrate to a new owner', async (t) => {
        const h = await fixture(t);
        const input = h.candidate('new');
        input.automationState.waitOutcome = { generation: 1, reason: 'expired', delivery: 'pending' };
        await assert.rejects(async () => h.taskStore.replaceAutomationStateIfGeneration(h.task.id, input), {
          code: 'TASK_TRACKING_REGISTRATION_CONFLICT',
        });
        await h.assertUnchanged();
      });

      it('concurrent registrations publish exactly one coherent owner, index, wait and private binding', async (t) => {
        const h = await fixture(t);
        const candidates = [h.candidate('one'), h.candidate('two')];
        const results = await Promise.all(
          candidates.map((input) => h.taskStore.replaceAutomationStateIfGeneration(h.task.id, input)),
        );
        const winners = results.filter(Boolean);
        assert.equal(winners.length, 1);
        const winner = winners[0];
        const input = candidates[results.findIndex(Boolean)];
        assert.deepEqual(await h.taskStore.get(h.task.id), winner);
        assert.equal(winner.threadId, input.trackingRegistration.threadId);
        assert.equal(winner.ownerCatId, input.trackingRegistration.ownerCatId);
        assert.deepEqual(winner.automationState, input.automationState);
        assert.deepEqual((await h.taskStore.getWaitRegistration(h.task.id)).receipt, input.waitRegistration);
        assert.deepEqual(
          await h.taskStore.getManagedWorkBinding(h.task.id),
          input.trackingRegistration.managedWorkBinding,
        );
        assert.deepEqual(await h.taskStore.listByThread(h.original.threadId), []);
        for (const candidate of candidates) {
          const thread = candidate.trackingRegistration.threadId;
          assert.deepEqual(
            (await h.taskStore.listByThread(thread)).map((task) => task.id),
            thread === winner.threadId ? [winner.id] : [],
          );
        }
      });
    },
  );
}
