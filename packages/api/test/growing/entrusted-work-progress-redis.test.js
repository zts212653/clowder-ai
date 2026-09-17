import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import '../helpers/setup-cat-registry.js';
import {
  assertRedisIsolationOrThrow,
  cleanupClientKeyspace,
  redisIsolationSkipReason,
} from '../helpers/redis-test-helpers.js';

const redisUrl = process.env.REDIS_URL;
const closure = { condition: 'Presentation approved', expectedSignal: 'artifact:approved' };
const { withBallCustodyTaskEvents } = await import('../../dist/domains/ball-custody/BallCustodyTaskStore.js');

describe('F310 typed progress Redis atomicity', { skip: redisIsolationSkipReason(redisUrl) }, () => {
  let redis;
  let RedisTaskStore;
  let Lifecycle;
  before(async () => {
    assertRedisIsolationOrThrow(redisUrl, 'F310 typed progress Redis atomicity');
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    ({ RedisTaskStore } = await import('../../dist/domains/cats/services/stores/redis/RedisTaskStore.js'));
    ({ EntrustedWorkLifecycleService: Lifecycle } = await import(
      '../../dist/domains/growing/EntrustedWorkLifecycleService.js'
    ));
    redis = createRedisClient({ url: redisUrl, keyPrefix: 'f310-progress:' });
    await redis.ping();
  });
  after(async () => {
    if (!redis) return;
    await cleanupClientKeyspace(redis);
    await redis.quit();
  });
  function createLifecycle(events) {
    return new Lifecycle(
      withBallCustodyTaskEvents(new RedisTaskStore(redis), {
        async record(event) {
          events.push(event);
        },
      }),
    );
  }
  async function admit(key) {
    const events = [];
    const service = createLifecycle(events);
    const admission = await service.admitOrResume({
      task: {
        threadId: key,
        title: 'Prepare presentation',
        why: 'Source entrustment',
        createdBy: 'codex-sol',
        ownerCatId: 'codex-sol',
        userId: 'owner-progress',
      },
      admission: {
        basis: 'explicit_entrustment',
        sourceRefs: [`message:${key}`],
        intendedOutcome: 'Reviewable presentation',
        idempotencyKey: key,
      },
      closure,
    });
    return { service, events, taskId: admission.ownerRef.replace('task:item:', '') };
  }

  for (const [from, to, expectedKinds] of [
    ['todo', 'todo', []],
    ['todo', 'doing', []],
    ['todo', 'blocked', ['task.blocked']],
    ['doing', 'todo', []],
    ['doing', 'doing', []],
    ['doing', 'blocked', ['task.blocked']],
    ['blocked', 'todo', ['task.unblocked']],
    ['blocked', 'doing', ['task.unblocked']],
    ['blocked', 'blocked', []],
  ]) {
    test(`${from} → ${to} preserves atomic state and custody events after reconstruction`, async () => {
      const { service, taskId, events } = await admit(`${from}-${to}`);
      let revision = 1;
      if (from !== 'todo') await service.update({ taskId, expectedRevision: revision++, status: from });
      events.length = 0;
      if (from === to) {
        const before = await redis.hgetall(`task:${taskId}`);
        await assert.rejects(
          service.update({ taskId, expectedRevision: revision, status: to }),
          (error) => error.code === 'ENTRUSTED_WORK_NO_OP',
        );
        assert.deepEqual(await redis.hgetall(`task:${taskId}`), before);
        assert.deepEqual(events, []);
        return;
      }
      await service.update({ taskId, expectedRevision: revision, status: to, artifactRefs: ['artifact:published'] });
      const restored = await new RedisTaskStore(redis).get(taskId);
      assert.equal(restored.status, to);
      assert.equal(restored.entrustedWork.revision, revision + 1);
      assert.deepEqual(restored.entrustedWork.artifactRefs, ['artifact:published']);
      assert.equal(restored.entrustedWork.closure.state, 'open');
      assert.equal(await redis.ttl(`task:${taskId}`), -1);
      assert.deepEqual(
        events.map((event) => event.kind),
        expectedKinds,
      );
      if (events.length) {
        assert.equal(events[0].subjectKey, `ball:task:${taskId}`);
        assert.equal(events[0].at, restored.updatedAt);
      }
    });
  }

  test('competing processes at one revision produce one progress winner', async () => {
    const { service, taskId, events } = await admit('competing-progress');
    const other = createLifecycle(events);
    const results = await Promise.allSettled([
      service.update({ taskId, expectedRevision: 1, status: 'doing' }),
      other.update({ taskId, expectedRevision: 1, status: 'blocked' }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(
      results.find((result) => result.status === 'rejected').reason.code,
      'ENTRUSTED_WORK_REVISION_CONFLICT',
    );
    const stored = await new RedisTaskStore(redis).get(taskId);
    assert.equal(stored.entrustedWork.revision, 2);
    assert.equal(stored.status, results.find((result) => result.status === 'fulfilled').value.status);
    assert.deepEqual(
      events.map((event) => event.kind),
      stored.status === 'blocked' ? ['task.blocked'] : [],
    );
  });

  test('progress racing closure never overwrites a terminal snapshot or revives it after restart', async () => {
    const { service, taskId, events } = await admit('progress-close');
    const other = createLifecycle(events);
    const results = await Promise.allSettled([
      service.update({ taskId, expectedRevision: 1, status: 'blocked' }),
      other.close({
        taskId,
        expectedRevision: 1,
        closure: { ...closure, state: 'satisfied', evidenceRefs: ['artifact:approved'] },
      }),
    ]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    let task = await new RedisTaskStore(redis).get(taskId);
    assert.equal(task.entrustedWork.revision, 2);
    assert.equal(task.status === 'done', task.entrustedWork.closure.state === 'satisfied');
    const progressWon = task.status !== 'done';
    if (task.status !== 'done') {
      task = await other.close({
        taskId,
        expectedRevision: 2,
        closure: { ...closure, state: 'satisfied', evidenceRefs: ['artifact:approved'] },
      });
    }
    const restarted = createLifecycle(events);
    await assert.rejects(
      restarted.update({ taskId, expectedRevision: task.entrustedWork.revision, status: 'doing' }),
      (error) => error.code === 'ENTRUSTED_WORK_ALREADY_CLOSED',
    );
    assert.deepEqual(await new RedisTaskStore(redis).get(taskId), task);
    assert.deepEqual(
      events.map((event) => event.kind),
      progressWon ? ['task.blocked', 'task.done'] : ['task.done'],
    );
  });

  test('rejected and non-status updates do not invent another blocked episode', async () => {
    const { service, taskId, events } = await admit('blocked-non-status');
    await service.update({ taskId, expectedRevision: 1, status: 'blocked' });
    assert.deepEqual(
      events.map((event) => event.kind),
      ['task.blocked'],
    );
    events.length = 0;
    await assert.rejects(
      service.update({ taskId, expectedRevision: 1, status: 'doing' }),
      (error) => error.code === 'ENTRUSTED_WORK_REVISION_CONFLICT',
    );
    await assert.rejects(
      service.update({ taskId, expectedRevision: 2, status: 'blocked' }),
      (error) => error.code === 'ENTRUSTED_WORK_NO_OP',
    );
    await service.update({ taskId, expectedRevision: 2, artifactRefs: ['artifact:prepared'] });
    await service.update({
      taskId,
      expectedRevision: 3,
      time: {
        reviewBy: { value: 1_789_000_000_000, sourceRef: 'message:blocked-non-status' },
      },
    });
    assert.deepEqual(events, []);
    assert.equal((await new RedisTaskStore(redis).get(taskId)).status, 'blocked');
  });
});
