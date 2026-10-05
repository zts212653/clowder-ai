import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { RedisThreadStore } from '../dist/domains/cats/services/stores/redis/RedisThreadStore.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

describe('isolated Redis projection liveness', { skip: redisIsolationSkipReason(process.env.REDIS_URL) }, () => {
  test('project reads hydrate matching members only and remain fresh across moves, creation, deletion and restart', async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'projection read liveness');
    const redis = createRedisClient({ url: process.env.REDIS_URL });
    try {
      const store = new RedisThreadStore(redis);
      const owner = `projection-${Date.now()}`;
      const desired = await store.create(owner, 'wanted', '/wanted');
      const unrelated = await store.create(owner, 'other', '/other');
      const stranger = await store.create(`${owner}-stranger`, 'private', '/wanted');
      // A legacy record not created through the new index writer must be backfilled.
      await redis.hset('thread:legacy-budget', {
        id: 'legacy-budget',
        createdBy: owner,
        projectPath: '/wanted',
        lastActiveAt: '1',
        createdAt: '1',
      });
      await redis.zadd(`threads:user:${owner}`, 1, 'legacy-budget');
      const first = await store.listByProject(owner, '/wanted');
      assert.deepEqual(first.map((t) => t.id).sort(), [desired.id, 'legacy-budget'].sort());
      const fullReads = [];
      const originalMulti = redis.multi.bind(redis);
      redis.multi = (...args) => {
        const transaction = originalMulti(...args);
        const original = transaction.hgetall.bind(transaction);
        transaction.hgetall = (key) => {
          fullReads.push(key);
          return original(key);
        };
        return transaction;
      };
      await new RedisThreadStore(redis).listByProject(owner, '/wanted');
      assert(!fullReads.includes(`thread:${unrelated.id}`), 'unrelated history must not be hydrated');
      assert(!fullReads.includes(`thread:${stranger.id}`), 'other owners remain invisible');
      await store.updateProjectPath(desired.id, '/other');
      assert.deepEqual(
        (await store.listByProject(owner, '/wanted')).map((t) => t.id),
        ['legacy-budget'],
      );
      const fresh = await store.create(owner, 'fresh', '/wanted');
      assert((await store.listByProject(owner, '/wanted')).some((t) => t.id === fresh.id));
      await store.delete(fresh.id);
      assert(!(await store.listByProject(owner, '/wanted')).some((t) => t.id === fresh.id));
    } finally {
      await redis.quit();
    }
  });
  test('project membership preserves explicitly visible system threads and excludes unindexed system records', async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'project system visibility');
    const redis = createRedisClient({ url: process.env.REDIS_URL });
    try {
      const store = new RedisThreadStore(redis);
      const owner = `system-projection-${Date.now()}`;
      const shared = await store.ensureThread(`shared-${owner}`, 'shared');
      await store.ensureThread(`private-${owner}`, 'unindexed');
      await store.indexForUser(shared.id, owner);
      assert((await store.listByProject(owner, 'default')).some((t) => t.id === shared.id));
      await store.updateProjectPath(shared.id, '/system-project');
      assert((await store.listByProject(owner, '/system-project')).some((t) => t.id === shared.id));
      assert(!(await store.listByProject(owner, 'default')).some((t) => t.id === `private-${owner}`));
      assert.equal(await store.hasByProject(owner, '/system-project'), true);
      assert.equal(await store.hasByProject(`${owner}-other`, '/system-project'), false);
    } finally {
      await redis.quit();
    }
  });
  test('deployment wait projection indexes legacy and newly armed work without hydrating settled history', async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'deployment projection liveness');
    const { RedisTaskStore } = await import('../dist/domains/cats/services/stores/redis/RedisTaskStore.js');
    const redis = createRedisClient({ url: process.env.REDIS_URL });
    try {
      const store = new RedisTaskStore(redis);
      const create = () =>
        store.create({
          kind: 'work',
          threadId: 'wait-budget-thread',
          title: 'wait',
          ownerCatId: 'codex-astra',
          why: 'test',
          createdBy: 'codex-astra',
          userId: 'u',
        });
      const first = await create();
      const unrelated = await create();
      // Canonical legacy payload is intentionally installed before index initialization.
      await redis.hset(`task:${first.id}`, 'deploymentWait', JSON.stringify({ await: { generation: 1 } }));
      assert.equal((await store.listDeploymentWaitProjectionCandidates()).length, 1);
      let historicalRead = false;
      const original = redis.pipeline.bind(redis);
      redis.pipeline = (...args) => {
        const pipeline = original(...args);
        const hgetall = pipeline.hgetall.bind(pipeline);
        pipeline.hgetall = (key) => {
          if (key === `task:${unrelated.id}`) historicalRead = true;
          return hgetall(key);
        };
        return pipeline;
      };
      assert.equal((await new RedisTaskStore(redis).listDeploymentWaitProjectionCandidates()).length, 1);
      assert.equal(historicalRead, false);
      await redis.hset(`task:${first.id}`, 'status', 'done');
      assert.equal((await store.listDeploymentWaitProjectionCandidates()).length, 0);
      assert.equal(await redis.sismember('tasks:deployment-wait:projection', first.id), 0);
      const active = {
        v: 1,
        generation: 1,
        subjectRef: 'deployment:test:runtime',
        ownerFence: { kind: 'containing_task', generation: 1 },
        baseline: { bootSequence: 1, bootId: 'boot', capturedAt: 1 },
        // biome-ignore lint/suspicious/noThenProperty: F280 continuation contract field.
        continuation: { when: [{ kind: 'new_ready_boot', services: ['api'] }], then: 'continue' },
        autoRenew: false,
        createdAt: 1,
      };
      await store.replaceDeploymentWaitIfGeneration(unrelated.id, {
        expectedGeneration: null,
        deploymentWait: { await: active },
      });
      assert.deepEqual(
        (await store.listDeploymentWaitProjectionCandidates()).map((t) => t.id),
        [unrelated.id],
      );
    } finally {
      await redis.quit();
    }
  });
  test('paw-feel projection validates log revision without replay and advances only the appended suffix', async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'paw-feel incremental projection');
    const { RedisPawFeelDispositionEventLog } = await import(
      '../dist/infrastructure/harness-eval/paw-feel-disposition/event-log.js'
    );
    const redis = createRedisClient({ url: process.env.REDIS_URL });
    try {
      const log = new RedisPawFeelDispositionEventLog(redis);
      const sourceMessageId = `incremental-${Date.now()}`;
      const signalId = `${sourceMessageId}:${'a'.repeat(64)}:0`;
      await log.append(
        {
          eventId: `${signalId}:discovered`,
          signalId,
          type: 'discovered',
          actor: { kind: 'automation', id: 'collector' },
          occurredAt: '2026-10-03T00:00:00Z',
          source: {
            sourceMessageId,
            sourceThreadId: 't',
            sourceCatId: 'codex-astra',
            markerDigest: 'a'.repeat(64),
            sameDigestOrdinal: 0,
            markerIndex: 0,
          },
          backfilled: false,
          captureMethod: 'legacy_parser',
          captureAssessment: 'confirmed',
        },
        0,
      );
      const ranges = [];
      const lrange = redis.lrange.bind(redis);
      redis.lrange = (key, from, to) => {
        ranges.push([from, to]);
        return lrange(key, from, to);
      };
      const first = await log.readProjections([signalId]);
      assert.equal(first.get(signalId)?.sequence, 1);
      first.get(signalId).state = 'closed';
      assert.equal(
        (await log.readProjections([signalId])).get(signalId)?.state,
        'new',
        'returned snapshots cannot mutate the cache',
      );
      assert.equal(ranges.length, 1, 'unchanged log reads only LLEN');
      await log.append(
        {
          eventId: `${signalId}:seen`,
          signalId,
          type: 'seen',
          actor: { kind: 'cat', id: 'opus' },
          occurredAt: '2026-10-03T00:01:00Z',
        },
        1,
      );
      const next = await log.readProjections([signalId]);
      assert.equal(next.get(signalId)?.state, 'seen');
      assert.deepEqual(ranges, [
        [0, 0],
        [1, 1],
      ]);
      assert.deepEqual(
        (await new RedisPawFeelDispositionEventLog(redis).readProjections([signalId])).get(signalId),
        next.get(signalId),
      );
    } finally {
      await redis.quit();
    }
  });
});
