import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { describe, test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import Fastify from 'fastify';
import { RedisThreadStore } from '../dist/domains/cats/services/stores/redis/RedisThreadStore.js';
import { registerActiveExecutionRoutes } from '../dist/routes/active-execution-routes.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

describe('isolated Redis projection liveness', { skip: redisIsolationSkipReason(process.env.REDIS_URL) }, () => {
  test('sparse active projection avoids hydrating idle histories in a large unrelated Redis keyspace', async (t) => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'projection scale health');
    const redis = createRedisClient({ url: process.env.REDIS_URL });
    const app = Fastify();
    try {
      for (let offset = 0; offset < 20000; offset += 500) {
        const writes = redis.pipeline();
        for (let i = offset; i < offset + 500; i++) writes.set(`scale-noise:${i}`, 'unrelated');
        await writes.exec();
      }
      const threads = new RedisThreadStore(redis);
      const live = await threads.create('scale-owner', 'live', '/scale-project');
      for (let offset = 0; offset < 5000; offset += 100) {
        const writes = redis.pipeline();
        for (let i = offset; i < offset + 100; i++) {
          const id = `idle-scale-${i}`;
          writes.hset(`thread:${id}`, {
            id,
            createdBy: 'scale-owner',
            projectPath: '/scale-project',
            title: 'idle',
            threadMemory: 'x'.repeat(1000),
            createdAt: '1',
            lastActiveAt: '1',
          });
          writes.zadd('threads:user:scale-owner', 1, id);
        }
        await writes.exec();
      }
      app.get('/health', async () => ({ ok: (await redis.ping()) === 'PONG' }));
      threads.listByProject = async () => {
        assert.fail('sparse active projection must not hydrate idle project history');
      };
      registerActiveExecutionRoutes(app, {
        threadStore: threads,
        invocationTracker: { getUserId: () => 'scale-owner', getExecutionId: () => 'execution-scale' },
        dynamicTaskStore: {
          getAll: () => {
            assert.fail('history enumeration');
          },
          listManagedCommandCandidates: () => [],
        },
        buildLiveCandidateSnapshot: async () => ({ complete: true, threadIds: [live.id] }),
        resolveLiveExecutions: async () => [
          {
            catId: 'codex-astra',
            executionId: 'execution-scale',
            startedAt: 1,
            ownerUserId: 'scale-owner',
            controlSource: 'tracker',
          },
        ],
        cancelExactLiveInvocation: () => ({ cancelled: true }),
      });
      await app.ready();
      const healthStart = performance.now();
      const health = await app.inject('/health');
      const healthMs = performance.now() - healthStart;
      assert.equal(health.statusCode, 200);
      assert.equal(health.json().ok, true);
      const start = performance.now();
      const active = await app.inject({
        url: '/api/executions/active?projectPath=%2Fscale-project',
        headers: { 'x-cat-cafe-user': 'scale-owner' },
      });
      const activeMs = performance.now() - start;
      assert.equal(active.statusCode, 200, active.body);
      assert.deepEqual(
        active.json().executions.map((row) => row.threadId),
        [live.id],
      );
      t.diagnostic(JSON.stringify({ unrelatedKeys: 20000, idleThreads: 5000, healthMs, activeMs }));
    } finally {
      await app.close();
      await redis.quit();
    }
  });
});
