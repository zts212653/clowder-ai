import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { describe, test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import Fastify from 'fastify';
import { RedisGameStore } from '../dist/domains/cats/services/stores/redis/RedisGameStore.js';
import { RedisThreadStore } from '../dist/domains/cats/services/stores/redis/RedisThreadStore.js';
import { registerActiveExecutionRoutes } from '../dist/routes/active-execution-routes.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

describe('isolated Redis projection liveness', { skip: redisIsolationSkipReason(process.env.REDIS_URL) }, () => {
  test('large unrelated Redis keyspace and idle thread history leave health responsive and sparse active reads complete', async (t) => {
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
      const { GameKeys } = await import('../dist/domains/cats/services/stores/redis-keys/game-keys.js');
      for (let i = 0; i < 10; i++)
        await redis
          .multi()
          .set(GameKeys.threadActive(`scale-${i}`), `scale-${i}`)
          .set(GameKeys.detail(`scale-${i}`), JSON.stringify({ gameId: `scale-${i}`, status: 'playing' }))
          .exec();
      redis.keys = () => assert.fail('startup recovery must never issue KEYS');
      const games = new RedisGameStore(redis);
      let recoveryFinished = false;
      app.get('/health', async () => ({ ok: (await redis.ping()) === 'PONG' }));
      app.get('/fixture/recover', async () => {
        const result = await games.listActiveGames();
        recoveryFinished = true;
        return result;
      });
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
      const recovery = app.inject('/fixture/recover');
      const healthStart = performance.now();
      const health = await app.inject('/health');
      const healthMs = performance.now() - healthStart;
      assert.equal(health.statusCode, 200);
      assert.equal(health.json().ok, true);
      assert.equal(recoveryFinished, false, 'health completes during the long SCAN cycle');
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
      assert.equal((await recovery).json().length, 10);
      t.diagnostic(JSON.stringify({ unrelatedKeys: 20000, idleThreads: 5000, healthMs, activeMs, recoveredGames: 10 }));
    } finally {
      await app.close();
      await redis.quit();
    }
  });
});
