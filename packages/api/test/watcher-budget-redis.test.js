import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { watcherSessionChainKey } from '../dist/domains/cats/services/session/session-scope.js';
import { RedisSessionChainStore } from '../dist/domains/cats/services/stores/redis/RedisSessionChainStore.js';
import { clearAuthTestNamespace, createAuthTestNamespace } from './helpers/redis-auth-namespace.js';
import { assertRedisIsolationOrThrow, redisIsolationSkipReason } from './helpers/redis-test-helpers.js';

test(
  'a fresh process reads the reduced window, skipped count and same-wake directory receipts from Redis',
  { skip: redisIsolationSkipReason(process.env.REDIS_URL) },
  async () => {
    assertRedisIsolationOrThrow(process.env.REDIS_URL, 'F335 budget progress');
    const namespace = createAuthTestNamespace('watcher-budget');
    const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: namespace });
    try {
      const sessions = new RedisSessionChainStore(redis);
      const session = await sessions.create({
        userId: 'owner',
        catId: 'codex',
        threadId: 'line',
        sessionPurpose: 'watcher',
        chainKey: watcherSessionChainKey('owner', 'codex', 'line'),
      });
      const next = {
        revision: 1,
        afterSequence: 42,
        notes: 'unchanged original notes',
        rawWindowTokens: 625,
        skippedWindows: 1,
        wakeInvocationId: 'wake',
        attempt: {
          invocationId: 'wake',
          sourceInvocationId: 'source',
          sourceSequence: 43,
          startedAt: 100,
          phase: 'failed',
          failure: 'watcher_context_recovery_deadline_exceeded',
          nativeTurnId: 'turn',
          window: { frontier: 'original', offset: 0, messageIds: ['original'], tokenBudget: 625 },
        },
        directoryReads: [
          {
            key: 'args-hash',
            hash: 'page-hash',
            callId: 'original-call',
            page: JSON.stringify({
              content: [{ type: 'text', text: '{"items":[{"matterId":"original","revision":7}]}' }],
            }),
          },
        ],
      };
      assert.ok(await sessions.compareAndSetWatcherState(session.id, 0, next));
      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
      import { createRedisClient } from '@cat-cafe/shared/utils';
      import { RedisSessionChainStore } from './dist/domains/cats/services/stores/redis/RedisSessionChainStore.js';
      import { watcherBudgetFailure } from './dist/domains/concierge/watcher/context/watcher-budget-progress.js';
      const client = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: process.env.F335_TEST_NAMESPACE });
      try {
        const state = (await new RedisSessionChainStore(client).get(process.env.F335_TEST_SESSION)).watcherState;
        if (!watcherBudgetFailure(state.attempt.failure)) throw new Error('recovery classification lost after restart');
        console.log('F335_STATE=' + JSON.stringify(state));
      }
      finally { await client.quit(); }
    `,
        ],
        {
          encoding: 'utf8',
          timeout: 15000,
          env: { ...process.env, F335_TEST_NAMESPACE: namespace, F335_TEST_SESSION: session.id },
        },
      );
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(
        JSON.parse(
          child.stdout
            .split('\n')
            .find((line) => line.startsWith('F335_STATE='))
            .slice('F335_STATE='.length),
        ),
        next,
      );
    } finally {
      await clearAuthTestNamespace(redis, namespace);
      await redis.quit();
    }
  },
);
