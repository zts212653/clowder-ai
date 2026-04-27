/**
 * F174 Phase B — Backend port contract test.
 *
 * Same suite runs against every IAuthInvocationBackend implementation
 * (memory now, redis appended in Task 3) so behavior parity is enforced
 * by the test runner, not by hope.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const backends = [
  [
    'memory',
    async () => {
      const { MemoryAuthInvocationBackend } = await import(
        '../dist/domains/cats/services/agents/invocation/MemoryAuthInvocationBackend.js'
      );
      return { backend: new MemoryAuthInvocationBackend({ maxRecords: 500 }), cleanup: async () => {} };
    },
  ],
];

// Redis backend variant — only included when REDIS_URL is set to ANY port
// EXCEPT 6399 (圣域 LL-015). The test:redis harness assigns a random port in
// 6300..6999 range, so a strict :6398 check would skip the Redis variant
// during full suite — defeating the contract.
const _redisUrl = process.env.REDIS_URL;
if (_redisUrl && !_redisUrl.includes(':6399')) {
  backends.push([
    'redis',
    async () => {
      const { createRedisClient } = await import('@cat-cafe/shared/utils');
      const { RedisAuthInvocationBackend } = await import(
        '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js'
      );
      const redis = createRedisClient({ url: process.env.REDIS_URL, keyPrefix: 'cat-cafe-test:' });
      // Wipe test keyspace before each test (keyPrefix isolates from shared 6398 data)
      const keys = await redis.keys('cat-cafe-test:auth:*');
      if (keys.length > 0) {
        const stripped = keys.map((k) => k.replace('cat-cafe-test:', ''));
        await redis.del(...stripped);
      }
      return {
        backend: new RedisAuthInvocationBackend(redis),
        cleanup: async () => {
          await redis.quit();
        },
      };
    },
  ]);
}

function fixture(invocationId, callbackToken, threadId = 't-1', catId = 'opus') {
  return {
    invocationId,
    callbackToken,
    userId: 'u-1',
    catId,
    threadId,
    clientMessageIds: new Set(),
    createdAt: Date.now(),
  };
}

for (const [name, factory] of backends) {
  describe(`AuthInvocationBackend contract — ${name}`, () => {
    test('create + verify round-trip returns ok:true with record', async () => {
      const { backend, cleanup } = await factory();
      try {
        await backend.create(fixture('inv-1', 'tok-1'), 60_000);
        const result = await backend.verify('inv-1', 'tok-1', 60_000);
        assert.equal(result.ok, true);
        assert.equal(result.record.callbackToken, 'tok-1');
        assert.equal(result.record.userId, 'u-1');
      } finally {
        await cleanup();
      }
    });

    test('verify with wrong token returns reason:invalid_token', async () => {
      const { backend, cleanup } = await factory();
      try {
        await backend.create(fixture('inv-2', 'tok-2'), 60_000);
        const result = await backend.verify('inv-2', 'wrong', 60_000);
        assert.deepEqual(result, { ok: false, reason: 'invalid_token' });
      } finally {
        await cleanup();
      }
    });

    test('verify with unknown id returns reason:unknown_invocation', async () => {
      const { backend, cleanup } = await factory();
      try {
        const result = await backend.verify('nonexistent', 'any', 60_000);
        assert.deepEqual(result, { ok: false, reason: 'unknown_invocation' });
      } finally {
        await cleanup();
      }
    });

    test('verify after TTL expiry returns reason:expired', async () => {
      const { backend, cleanup } = await factory();
      try {
        await backend.create(fixture('inv-3', 'tok-3'), 10);
        await new Promise((r) => setTimeout(r, 30));
        const result = await backend.verify('inv-3', 'tok-3', 10);
        assert.equal(result.ok, false);
        assert.equal(result.reason, 'expired');
      } finally {
        await cleanup();
      }
    });

    test('isLatest tracks latest invocation per thread+cat', async () => {
      const { backend, cleanup } = await factory();
      try {
        await backend.create(fixture('old-id', 'tok-old'), 60_000);
        await backend.create(fixture('new-id', 'tok-new'), 60_000);
        assert.equal(await backend.isLatest('old-id'), false);
        assert.equal(await backend.isLatest('new-id'), true);
      } finally {
        await cleanup();
      }
    });

    // Cloud Codex P2 (PR #1368, 08:54Z, 05de7c98b): atomically combine
    // verify + isLatest + slide so a stale invocation can't be refreshed in
    // the race window between preValidation isLatest check and preHandler
    // verify slide.
    test('AC-C5 atomic verifyLatest: stale invocation rejected', async () => {
      const { backend, cleanup } = await factory();
      try {
        await backend.create(fixture('inv-old', 'tok-old'), 60_000);
        await backend.create(fixture('inv-new', 'tok-new'), 60_000); // supersedes inv-old
        const stale = await backend.verifyLatest('inv-old', 'tok-old', 60_000);
        assert.equal(stale.ok, false);
        assert.equal(stale.reason, 'stale_invocation');
        const fresh = await backend.verifyLatest('inv-new', 'tok-new', 60_000);
        assert.equal(fresh.ok, true);
        assert.equal(fresh.record?.invocationId, 'inv-new');
      } finally {
        await cleanup();
      }
    });

    test('AC-C5 atomic verifyLatest: invalid token returns invalid_token (not stale)', async () => {
      const { backend, cleanup } = await factory();
      try {
        await backend.create(fixture('inv-vl', 'tok-vl'), 60_000);
        const result = await backend.verifyLatest('inv-vl', 'wrong', 60_000);
        assert.deepEqual(result, { ok: false, reason: 'invalid_token' });
      } finally {
        await cleanup();
      }
    });

    test('AC-C5 atomic verifyLatest: unknown invocation returns unknown_invocation', async () => {
      const { backend, cleanup } = await factory();
      try {
        const result = await backend.verifyLatest('nonexistent', 'any', 60_000);
        assert.deepEqual(result, { ok: false, reason: 'unknown_invocation' });
      } finally {
        await cleanup();
      }
    });

    // F174 Phase B P1 (gpt52 review #1363) — symptom check that survives
    // even with 60s grace: after a slide window, the latest pointer must
    // not have drifted relative to the record. The detailed PTTL check
    // lives in auth-invocation-redis-ttl-slide.test.js (Redis-only).
    test('verify() does not let latest pointer drift behind record TTL (P1: gpt52 #1363)', async () => {
      const { backend, cleanup } = await factory();
      try {
        await backend.create(fixture('drift-test', 'tok-drift'), 60_000);
        // Wait then slide multiple times.
        await new Promise((r) => setTimeout(r, 50));
        await backend.verify('drift-test', 'tok-drift', 60_000);
        await new Promise((r) => setTimeout(r, 50));
        await backend.verify('drift-test', 'tok-drift', 60_000);

        // After repeated slides, isLatest must still report the slot.
        // (Real symptom kicks in after TTL drift > grace; covered by the PTTL
        // assertion in the Redis-specific suite.)
        assert.equal(await backend.isLatest('drift-test'), true);
      } finally {
        await cleanup();
      }
    });

    test('claimClientMessageId dedupes per invocation', async () => {
      const { backend, cleanup } = await factory();
      try {
        await backend.create(fixture('inv-c', 'tok-c'), 60_000);
        assert.equal(await backend.claimClientMessageId('inv-c', 'msg-1'), true);
        assert.equal(await backend.claimClientMessageId('inv-c', 'msg-1'), false);
        assert.equal(await backend.claimClientMessageId('inv-c', 'msg-2'), true);
      } finally {
        await cleanup();
      }
    });

    // Cloud Codex P2 (PR #1368, 08:15Z, 7de77a70d): refresh cooldown Map only
    // does lazy GC at >100 entries but never enforces a hard cap. Under
    // memory-mode high churn, all entries can be active (none expired) and
    // accumulate unbounded — O(n) per claim + memory leak.
    if (name === 'memory') {
      test('AC-C5 cooldown bound: memory backend caps refresh cooldown map size', async () => {
        const { backend, cleanup } = await factory();
        try {
          // Claim 1500 distinct invocations within 5min cooldown — all active.
          for (let i = 0; i < 1500; i++) {
            await backend.tryClaimRefreshCooldown(`inv-${i}`, 5 * 60_000);
          }
          // Inspect internal map size via the backend itself (non-public but
          // we test the contract by re-claiming an old slot — if map is bounded
          // via FIFO eviction, early entries got evicted and re-claim succeeds).
          const earlyReclaim = await backend.tryClaimRefreshCooldown('inv-0', 5 * 60_000);
          assert.equal(earlyReclaim, true, 'early entries must be evicted under bound');
        } finally {
          await cleanup();
        }
      });

      // Cloud Codex P2 (PR #1368, 09:15Z, 5160ea926): the cap eviction loop
      // ran BEFORE the `existing` check, so a no-op re-claim by an already-
      // cooled invocation churned other valid cooldowns out of the map and
      // let those victims bypass the 5min limit early.
      test('AC-C5 cooldown bound: re-claim of active cooldown does NOT evict others', async () => {
        const { MemoryAuthInvocationBackend } = await import(
          '../dist/domains/cats/services/agents/invocation/MemoryAuthInvocationBackend.js'
        );
        const small = new MemoryAuthInvocationBackend({ maxRecords: 5 });
        // Fill cap with 5 active cooldowns.
        for (let i = 0; i < 5; i++) {
          assert.equal(await small.tryClaimRefreshCooldown(`inv-${i}`, 5 * 60_000), true);
        }
        // inv-2 tries to re-claim while still in cooldown — must return false
        // WITHOUT evicting any of inv-0..4 (no-op claim shouldn't churn).
        assert.equal(await small.tryClaimRefreshCooldown('inv-2', 5 * 60_000), false);
        // inv-0 still in cooldown? Yes — re-claim returns false (still active).
        assert.equal(await small.tryClaimRefreshCooldown('inv-0', 5 * 60_000), false);
        assert.equal(await small.tryClaimRefreshCooldown('inv-4', 5 * 60_000), false);
      });

      // Cloud Codex P2 (PR #1368, 08:38Z, 8cf95e028): cooldown cap was the
      // module constant DEFAULT_MAX_RECORDS, not the instance maxRecords.
      // Custom maxRecords now governs cooldown size too — they're in lockstep.
      test('AC-C5 cooldown bound: custom maxRecords governs cooldown cap', async () => {
        const { MemoryAuthInvocationBackend } = await import(
          '../dist/domains/cats/services/agents/invocation/MemoryAuthInvocationBackend.js'
        );
        const small = new MemoryAuthInvocationBackend({ maxRecords: 50 });
        // Claim 100 active cooldowns — should evict early ones around the 50 mark.
        for (let i = 0; i < 100; i++) {
          await small.tryClaimRefreshCooldown(`inv-${i}`, 5 * 60_000);
        }
        // inv-0 was evicted long ago (FIFO past cap=50)
        const earlyReclaim = await small.tryClaimRefreshCooldown('inv-0', 5 * 60_000);
        assert.equal(earlyReclaim, true, 'tiny cap must evict aggressively');
      });
    }
  });
}
