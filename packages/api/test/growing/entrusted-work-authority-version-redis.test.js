import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from '../helpers/redis-test-helpers.js';

describe(
  'Task authority version Redis persistence and CAS',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  () => {
    let redis;
    let Store;
    let Lifecycle;
    let seq = 0;
    before(async () => {
      assertRedisIsolationOrThrow(process.env.REDIS_URL, 'Task authority version');
      const { createRedisClient } = await import('@cat-cafe/shared/utils');
      ({ RedisTaskStore: Store } = await import('../../dist/domains/cats/services/stores/redis/RedisTaskStore.js'));
      ({ EntrustedWorkLifecycleService: Lifecycle } = await import(
        '../../dist/domains/growing/EntrustedWorkLifecycleService.js'
      ));
      redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: `authority-version:${process.pid}:` });
      await redis.ping();
    });
    after(async () => {
      await redis?.quit();
    });
    async function fixture() {
      const store = new Store(redis);
      const service = new Lifecycle(store);
      const result = await service.admitOrResume({
        task: {
          threadId: 'thread',
          title: 'Report',
          why: 'Entrusted',
          createdBy: 'codex',
          ownerCatId: 'codex',
          userId: 'owner',
        },
        admission: {
          basis: 'explicit_entrustment',
          sourceRefs: ['message:source'],
          intendedOutcome: 'Report',
          idempotencyKey: `source-${seq++}`,
        },
        closure: { condition: 'Report accepted', expectedSignal: 'artifact:accepted' },
      });
      const task = await store.get(result.ownerRef.replace('task:item:', ''));
      assert.equal(task.entrustedWork.executionAuthorityRevision, 1);
      return { store, task };
    }
    test('each ordinary mutation persists both revisions and survives store reconstruction', async () => {
      const { store, task } = await fixture();
      const steps = [
        () => store.updateEntrustedWork(task.id, { expectedRevision: 1, artifactRefs: ['artifact:first'] }),
        () => store.patchAutomationState(task.id, { closedAt: 10 }),
        () =>
          store.replaceAutomationStateIfGeneration(task.id, {
            expectedGeneration: null,
            automationState: { closedAt: 20 },
            status: 'doing',
          }),
        () =>
          store.replaceDeploymentWaitIfGeneration(task.id, {
            expectedGeneration: null,
            expectedDeploymentWait: undefined,
            deploymentWait: undefined,
            status: 'blocked',
          }),
        () =>
          store.closeEntrustedWork(task.id, {
            expectedRevision: 5,
            closure: { ...task.entrustedWork.closure, state: 'satisfied', evidenceRefs: ['message:accepted'] },
          }),
      ];
      for (let i = 0; i < steps.length; i++) {
        await steps[i]();
        const restored = await new Store(redis).get(task.id);
        assert.equal(restored.entrustedWork.revision, i + 2);
        assert.equal(restored.entrustedWork.executionAuthorityRevision, i + 2);
      }
      assert.equal(await redis.ttl(`task:${task.id}`), -1);
    });
    test('independent store instances racing on one revision produce exactly one authority transition', async () => {
      const { store, task } = await fixture();
      const results = await Promise.all([
        store.updateEntrustedWork(task.id, { expectedRevision: 1, artifactRefs: ['artifact:one'] }),
        new Store(redis).updateEntrustedWork(task.id, { expectedRevision: 1, status: 'doing' }),
      ]);
      assert.deepEqual(results.map((r) => r.kind).sort(), ['revision_conflict', 'updated']);
      const restored = await new Store(redis).get(task.id);
      assert.equal(restored.entrustedWork.revision, 2);
      assert.equal(restored.entrustedWork.executionAuthorityRevision, 2);
    });
    test('legacy persisted state is not promoted by codec or a generic artifact update', async () => {
      const { store, task } = await fixture();
      delete task.entrustedWork.executionAuthorityRevision;
      // Historical bytes in the private disposable test Redis, not a production migration.
      await redis.hset(`task:${task.id}`, 'entrustedWork', JSON.stringify(task.entrustedWork));
      const result = await store.updateEntrustedWork(task.id, {
        expectedRevision: 1,
        artifactRefs: ['artifact:legacy'],
      });
      assert.equal(result.kind, 'updated');
      const restored = await new Store(redis).get(task.id);
      assert.equal(restored.entrustedWork.revision, 2);
      assert.equal(Object.hasOwn(restored.entrustedWork, 'executionAuthorityRevision'), false);
    });
  },
);
