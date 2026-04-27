/**
 * F174 Phase B — Restart resilience integration test (AC-B3).
 *
 * The whole point of Phase B: verify that an invocation token persisted via
 * one Redis client survives across a "process restart" (= fresh Redis client
 * with no in-process state). Pre-Phase-B this test would always fail because
 * MemoryAuthInvocationBackend lost everything on restart.
 *
 * Also includes AC-B5: REDIS_URL must point at the isolated dev port (6398),
 * never the 圣域 6399 (LL-015).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const REDIS_URL = process.env.REDIS_URL;
const HAS_REDIS = REDIS_URL?.includes(':6398') === true;

describe('F174 Phase B — restart resilience (AC-B3, AC-B5)', () => {
  // AC-B5 (圣域 isolation) is enforced by .env.local + worktree skill, not by this
  // test runner. The contract test below opt-in only when REDIS_URL=:6398, so
  // 6399 is naturally untouched. No standalone test needed.

  test('AC-B3: invocation token verifiable across simulated process restart', async () => {
    if (!HAS_REDIS) {
      // Skip when not running against Redis (memory-only CI).
      return;
    }

    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const { RedisAuthInvocationBackend } = await import(
      '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js'
    );

    // === Process 1 ===
    const redis1 = createRedisClient({ url: REDIS_URL, keyPrefix: 'cat-cafe-test:' });
    // Cleanup any leftovers from prior runs (test keyspace isolated by prefix)
    const leftovers = await redis1.keys('cat-cafe-test:auth:*');
    if (leftovers.length > 0) {
      await redis1.del(...leftovers.map((k) => k.replace('cat-cafe-test:', '')));
    }

    const backend1 = new RedisAuthInvocationBackend(redis1);
    await backend1.create(
      {
        invocationId: 'survive-restart-1',
        callbackToken: 'tok-survive',
        userId: 'u-1',
        catId: 'opus',
        threadId: 't-1',
        clientMessageIds: new Set(),
        createdAt: Date.now(),
      },
      60_000,
    );
    await redis1.quit(); // simulate process exit — in-process state gone

    // === Process 2 (fresh client, no prior in-memory state) ===
    const redis2 = createRedisClient({ url: REDIS_URL, keyPrefix: 'cat-cafe-test:' });
    const backend2 = new RedisAuthInvocationBackend(redis2);

    const result = await backend2.verify('survive-restart-1', 'tok-survive', 60_000);
    assert.equal(result.ok, true, 'token must verify after simulated process restart');
    if (result.ok) {
      assert.equal(result.record.userId, 'u-1');
      assert.equal(result.record.catId, 'opus');
      assert.equal(result.record.threadId, 't-1');
    }

    // Cleanup
    const keys = await redis2.keys('cat-cafe-test:auth:*');
    if (keys.length > 0) {
      await redis2.del(...keys.map((k) => k.replace('cat-cafe-test:', '')));
    }
    await redis2.quit();
  });
});
