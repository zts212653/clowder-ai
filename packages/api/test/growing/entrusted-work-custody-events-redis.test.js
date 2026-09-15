import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import '../helpers/setup-cat-registry.js';
import { RedisBallCustodyEventLog } from '../../dist/domains/ball-custody/BallCustodyEventLog.js';
import { BallCustodyIngest } from '../../dist/domains/ball-custody/BallCustodyIngest.js';
import { RedisBallCustodyProjectionStore } from '../../dist/domains/ball-custody/BallCustodyProjectionStore.js';
import { BallCustodyProjector } from '../../dist/domains/ball-custody/BallCustodyProjector.js';
import { withBallCustodyTaskEvents } from '../../dist/domains/ball-custody/BallCustodyTaskStore.js';
import { TaskStore } from '../../dist/domains/cats/services/stores/ports/TaskStore.js';
import { RedisTaskStore } from '../../dist/domains/cats/services/stores/redis/RedisTaskStore.js';
import { EntrustedWorkLifecycleService } from '../../dist/domains/growing/EntrustedWorkLifecycleService.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from '../helpers/redis-test-helpers.js';

const redisUrl = process.env.REDIS_URL;

describe(
  'F310 progress through the real deduplicating custody consumer',
  {
    skip: redisIsolationSkipReason(redisUrl),
  },
  () => {
    let redis;
    before(async () => {
      assertRedisIsolationOrThrow(redisUrl, 'F310 custody event identity');
      const { createRedisClient } = await import('@cat-cafe/shared/utils');
      redis = createRedisClient({ url: redisUrl, keyPrefix: 'f310-custody-events:' });
      await redis.ping();
    });
    after(async () => {
      if (redis) await redis.quit();
    });

    function makeRuntime(tasks) {
      const log = new RedisBallCustodyEventLog(redis);
      const projections = new RedisBallCustodyProjectionStore(redis);
      const projector = new BallCustodyProjector(log, projections);
      const ingest = new BallCustodyIngest(log, projector);
      const pending = [];
      const store = withBallCustodyTaskEvents(tasks, {
        record(event) {
          const recorded = ingest.record(event);
          pending.push(recorded);
          return recorded;
        },
      });
      return {
        tasks,
        log,
        projections,
        projector,
        ingest,
        lifecycle: new EntrustedWorkLifecycleService(store),
        drain: () => Promise.all(pending.splice(0)),
      };
    }

    async function admit(runtime, key) {
      const admitted = await runtime.lifecycle.admitOrResume({
        task: {
          threadId: key,
          title: 'Prepare reviewable work',
          why: 'Explicit source request',
          createdBy: 'codex-sol',
          ownerCatId: 'codex-sol',
          userId: 'owner-progress',
        },
        admission: {
          basis: 'explicit_entrustment',
          sourceRefs: [`message:${key}`],
          intendedOutcome: 'Reviewable work',
          idempotencyKey: key,
        },
        closure: { condition: 'Work approved', expectedSignal: 'artifact:approved' },
      });
      return admitted.ownerRef.replace('task:item:', '');
    }

    for (const backend of ['memory', 'redis']) {
      test(`${backend}: repeated same-millisecond transitions survive dedup, retries and rebuild`, async (t) => {
        const runtime = makeRuntime(backend === 'memory' ? new TaskStore() : new RedisTaskStore(redis));
        const taskId = await admit(runtime, `same-ms-${backend}`);
        const at = Date.now();
        t.mock.method(Date, 'now', () => at);
        const statuses = ['blocked', 'doing', 'blocked', 'todo', 'blocked'];
        for (const [index, status] of statuses.entries()) {
          await runtime.lifecycle.update({ taskId, expectedRevision: index + 1, status });
        }
        await runtime.drain();
        const task = await runtime.tasks.get(taskId);
        assert.equal(task.status, 'blocked');
        assert.equal(task.entrustedWork.revision, 6);
        const subjectKey = `ball:task:${taskId}`;
        const projection = await runtime.projections.get(subjectKey);
        assert.equal(projection.state, task.status, 'dedup must not strand a blocked Task as active');
        assert.equal(projection.blockedSinceAt, at);
        assert.equal(projection.appliedEventCount, statuses.length);
        const events = await runtime.log.read(subjectKey);
        assert.equal(new Set(events.map((event) => event.at)).size, 1, 'one millisecond is deliberately shared');
        assert.equal(new Set(events.map((event) => event.sourceEventId)).size, statuses.length);
        assert.deepEqual(
          events.map((event) => event.kind),
          ['task.blocked', 'task.unblocked', 'task.blocked', 'task.unblocked', 'task.blocked'],
        );
        await Promise.all(events.map((event) => runtime.ingest.record(event)));
        assert.equal((await runtime.log.read(subjectKey)).length, statuses.length, 'exact retries remain idempotent');
        assert.deepEqual(await runtime.projections.get(subjectKey), projection);
        await runtime.projector.rebuild(subjectKey);
        assert.deepEqual(await runtime.projections.get(subjectKey), projection, 'replay preserves the live projection');
      });
    }

    test('reconstructed owners derive new event identities from durable revisions, not local memory', async (t) => {
      const first = makeRuntime(new RedisTaskStore(redis));
      const taskId = await admit(first, 'reconstructed-progress');
      const at = Date.now();
      t.mock.method(Date, 'now', () => at);
      await first.lifecycle.update({ taskId, expectedRevision: 1, status: 'blocked' });
      await first.drain();
      const restored = makeRuntime(new RedisTaskStore(redis));
      await restored.lifecycle.update({ taskId, expectedRevision: 2, status: 'doing' });
      await restored.lifecycle.update({ taskId, expectedRevision: 3, status: 'blocked' });
      await restored.drain();
      const subjectKey = `ball:task:${taskId}`;
      const projection = await restored.projections.get(subjectKey);
      assert.equal(projection.state, 'blocked');
      assert.equal(projection.appliedEventCount, 3);
      await assert.rejects(
        restored.lifecycle.update({ taskId, expectedRevision: 3, status: 'doing' }),
        (error) => error.code === 'ENTRUSTED_WORK_REVISION_CONFLICT',
      );
      await restored.lifecycle.update({ taskId, expectedRevision: 4, artifactRefs: ['artifact:prepared'] });
      await restored.drain();
      assert.equal((await restored.log.read(subjectKey)).length, 3);
      assert.deepEqual(await restored.projections.get(subjectKey), projection);
      assert.equal((await restored.tasks.get(taskId)).entrustedWork.revision, 5);
    });
  },
);
