import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { RedisTaskStore } from '../dist/domains/cats/services/stores/redis/RedisTaskStore.js';
import { RedisThreadStore } from '../dist/domains/cats/services/stores/redis/RedisThreadStore.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

describe('isolated Redis projection liveness', { skip: redisIsolationSkipReason(process.env.REDIS_URL) }, () => {
  for (const kind of ['project', 'deployment-wait']) {
    test(`${kind} index rebuilds after old-writer rollback and client restart`, async () => {
      assertRedisIsolationOrThrow(process.env.REDIS_URL, 'derived index rollback');
      const redis = createRedisClient({ url: process.env.REDIS_URL });
      let restarted;
      try {
        if (kind === 'project') {
          const owner = 'rollback-project-owner';
          const store = new RedisThreadStore(redis);
          await store.create(owner, 'existing', '/rollback-project');
          await store.listByProject(owner, '/rollback-project');
          // Older binaries keep the original user-list/hash contract but do not publish the new set.
          await redis
            .multi()
            .hset('thread:rollback-legacy-thread', {
              id: 'rollback-legacy-thread',
              createdBy: owner,
              projectPath: '/rollback-project',
              createdAt: '1',
              lastActiveAt: '1',
            })
            .zadd(`threads:user:${owner}`, 1, 'rollback-legacy-thread')
            .exec();
          restarted = createRedisClient({ url: process.env.REDIS_URL });
          assert(
            (await new RedisThreadStore(restarted).listByProject(owner, '/rollback-project')).some(
              (thread) => thread.id === 'rollback-legacy-thread',
            ),
          );
        } else {
          const store = new RedisTaskStore(redis);
          await store.listDeploymentWaitProjectionCandidates();
          const task = await store.create({
            kind: 'work',
            threadId: 'rollback-wait',
            title: 'wait',
            ownerCatId: 'codex-astra',
            why: 'test',
            createdBy: 'codex-astra',
            userId: 'u',
          });
          await redis.hset(`task:${task.id}`, 'deploymentWait', JSON.stringify({ await: { generation: 1 } }));
          restarted = createRedisClient({ url: process.env.REDIS_URL });
          assert(
            (await new RedisTaskStore(restarted).listDeploymentWaitProjectionCandidates()).some(
              (candidate) => candidate.id === task.id,
            ),
          );
        }
      } finally {
        await restarted?.quit();
        await redis.quit();
      }
    });
  }
  test('idle project existence preserves the owner guard when a user index has a malformed foreign member', async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'project existence visibility');
    const redis = createRedisClient({ url: process.env.REDIS_URL });
    try {
      const store = new RedisThreadStore(redis);
      const foreign = await store.create('foreign-owner', 'foreign', '/private-foreign');
      await store.create('viewer-owner', 'own', '/viewer-own');
      await redis.zadd('threads:user:viewer-owner', '1', foreign.id);
      assert.equal(await store.hasByProject('viewer-owner', '/private-foreign'), false);
      await redis.hset('thread:default', 'createdBy', 'foreign-owner', 'projectPath', '/private-default');
      assert.equal(await store.hasByProject('viewer-owner', '/private-default'), false);
    } finally {
      await redis.hset('thread:default', 'createdBy', 'system', 'projectPath', 'default');
      await redis.quit();
    }
  });
  test('system visibility published during initial project backfill cannot be omitted by the ready marker', async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'project backfill race');
    const redis = createRedisClient({ url: process.env.REDIS_URL });
    try {
      const store = new RedisThreadStore(redis);
      await store.create('race-owner', 'existing', '/other');
      await redis.hset('thread:legacy-system-race', {
        id: 'legacy-system-race',
        createdBy: 'system',
        projectPath: '/legacy',
        lastActiveAt: '1',
        createdAt: '1',
      });
      const original = redis.pipeline.bind(redis);
      let raced = false;
      redis.pipeline = (...args) => {
        const pipeline = original(...args);
        let readingProject = false;
        const hmget = pipeline.hmget.bind(pipeline);
        pipeline.hmget = (...values) => {
          readingProject = true;
          return hmget(...values);
        };
        const exec = pipeline.exec.bind(pipeline);
        pipeline.exec = async () => {
          const replies = await exec();
          if (readingProject && !raced) {
            raced = true;
            await store.indexForUser('legacy-system-race', 'race-owner');
          }
          return replies;
        };
        return pipeline;
      };
      assert.deepEqual(
        (await store.listByProject('race-owner', '/legacy')).map((t) => t.id),
        ['legacy-system-race'],
      );
      assert.equal(raced, true);
      assert.deepEqual(
        (await new RedisThreadStore(redis).listByProject('race-owner', '/legacy')).map((t) => t.id),
        ['legacy-system-race'],
      );
    } finally {
      await redis.quit();
    }
  });
  test('a concurrent project move wins over the backfill snapshot and unknown visibility fails closed', async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'project move race');
    const redis = createRedisClient({ url: process.env.REDIS_URL });
    try {
      const store = new RedisThreadStore(redis);
      const thread = await store.create('move-owner', 'move', '/old');
      const original = redis.pipeline.bind(redis);
      let raced = false;
      redis.pipeline = (...args) => {
        const pipeline = original(...args);
        let projectRead = false;
        const hmget = pipeline.hmget.bind(pipeline);
        pipeline.hmget = (...values) => {
          projectRead = true;
          return hmget(...values);
        };
        const exec = pipeline.exec.bind(pipeline);
        pipeline.exec = async () => {
          const replies = await exec();
          if (projectRead && !raced) {
            raced = true;
            await store.updateProjectPath(thread.id, '/new');
          }
          return replies;
        };
        return pipeline;
      };
      assert.deepEqual(await store.listByProject('move-owner', '/old'), []);
      assert.deepEqual(
        (await store.listByProject('move-owner', '/new')).map((t) => t.id),
        [thread.id],
      );
      redis.pipeline = () => ({
        zscore() {
          return this;
        },
        async exec() {
          return [[null, undefined]];
        },
      });
      await assert.rejects(store.listProjectCandidates('move-owner', '/new', [thread.id]), /Invalid thread visibility/);
    } finally {
      await redis.quit();
    }
  });
  test('deployment-wait cleanup cannot remove a newer generation installed after its read', async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'wait index cleanup race');
    const redis = createRedisClient({ url: process.env.REDIS_URL });
    try {
      const store = new RedisTaskStore(redis);
      const task = await store.create({
        kind: 'work',
        threadId: 't',
        title: 'wait',
        ownerCatId: 'codex-astra',
        why: 'test',
        createdBy: 'codex-astra',
        userId: 'u',
      });
      const old = {
        waitOutcome: {
          v: 1,
          domain: 'deployment',
          outcomeId: 'old',
          subjectRef: 'deployment:test:runtime',
          generation: 1,
          ownerFence: { kind: 'containing_task', generation: 1 },
          reason: 'matched',
          at: 1,
          delivery: 'delivered',
        },
      };
      await redis
        .multi()
        .hset(`task:${task.id}`, 'deploymentWait', JSON.stringify(old))
        .sadd('tasks:deployment-wait:projection', task.id)
        .exec();
      const original = redis.pipeline.bind(redis);
      let raced = false;
      redis.pipeline = (...args) => {
        const pipeline = original(...args);
        let taskRead = false;
        const hgetall = pipeline.hgetall.bind(pipeline);
        pipeline.hgetall = (key) => {
          if (key === `task:${task.id}`) taskRead = true;
          return hgetall(key);
        };
        const exec = pipeline.exec.bind(pipeline);
        pipeline.exec = async () => {
          const replies = await exec();
          if (taskRead && !raced) {
            raced = true;
            const active = {
              v: 1,
              generation: 2,
              subjectRef: 'deployment:test:runtime',
              ownerFence: { kind: 'containing_task', generation: 2 },
              baseline: { bootSequence: 1, bootId: 'b', capturedAt: 1 },
              // biome-ignore lint/suspicious/noThenProperty: frozen continuation contract.
              continuation: { when: [{ kind: 'new_ready_boot', services: ['api'] }], then: 'continue' },
              autoRenew: false,
              createdAt: 1,
            };
            assert(
              await store.replaceDeploymentWaitIfGeneration(task.id, {
                expectedGeneration: 1,
                expectedDeploymentWait: old,
                deploymentWait: { await: active },
              }),
            );
          }
          return replies;
        };
        return pipeline;
      };
      assert.equal(
        (await store.listDeploymentWaitProjectionCandidates()).some((candidate) => candidate.id === task.id),
        false,
      );
      assert.equal(await redis.sismember('tasks:deployment-wait:projection', task.id), 1);
      assert.equal(
        (await store.listDeploymentWaitProjectionCandidates()).find((candidate) => candidate.id === task.id)
          ?.deploymentWait?.await?.generation,
        2,
      );
    } finally {
      await redis.quit();
    }
  });
});
