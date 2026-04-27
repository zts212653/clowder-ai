/**
 * F174 Phase B P1 (gpt52 review on PR #1363) — Redis-specific TTL slide.
 *
 * Direct PTTL assertion: verify() must extend the latest pointer key TTL
 * alongside the record key TTL. Without the fix, the latest pointer is
 * anchored to its create()-time PEXPIREAT and drifts behind the record →
 * isLatest() will return false in long sessions (false stale_ignored).
 *
 * This file only runs when REDIS_URL is reachable (test:redis harness sets
 * a random port; unit suite without REDIS_URL skips silently).
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

const REDIS_URL = process.env.REDIS_URL;

describe('F174 Phase B — Redis latest pointer TTL slide (P1: gpt52 #1363)', () => {
  if (!REDIS_URL || REDIS_URL.includes(':6399')) {
    test('skipped: REDIS_URL not set or points at 圣域 6399', () => {
      assert.ok(true);
    });
    return;
  }

  test('verify() extends BOTH record TTL and latest pointer TTL', async () => {
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const { RedisAuthInvocationBackend } = await import(
      '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js'
    );

    const redis = createRedisClient({ url: REDIS_URL, keyPrefix: 'cat-cafe-ttl-slide-test:' });
    try {
      // Wipe any leftover test keys
      const leftover = await redis.keys('cat-cafe-ttl-slide-test:*');
      if (leftover.length > 0) {
        await redis.del(...leftover.map((k) => k.replace('cat-cafe-ttl-slide-test:', '')));
      }

      const backend = new RedisAuthInvocationBackend(redis);
      const ttlMs = 60_000;
      await backend.create(
        {
          invocationId: 'ttl-test:inv-1',
          callbackToken: 'tok-1',
          userId: 'u-1',
          catId: 'opus',
          threadId: 'ttl-test:thread-1',
          clientMessageIds: new Set(),
          createdAt: Date.now(),
        },
        ttlMs,
      );

      const recordKey = 'auth:inv:ttl-test:inv-1';
      const latestKey = 'auth:latest:ttl-test:thread-1:opus';

      // Initial PTTLs (allow a few ms slack)
      const recordPttlBefore = await redis.pttl(recordKey);
      const latestPttlBefore = await redis.pttl(latestKey);
      assert.ok(recordPttlBefore > 0, 'record PTTL must be set');
      assert.ok(latestPttlBefore > 0, 'latest PTTL must be set');
      assert.ok(
        Math.abs(recordPttlBefore - latestPttlBefore) < 200,
        `create() should set near-equal TTLs, drift=${Math.abs(recordPttlBefore - latestPttlBefore)}ms`,
      );

      // Wait, then verify (slides record TTL)
      await new Promise((r) => setTimeout(r, 200));
      const result = await backend.verify('ttl-test:inv-1', 'tok-1', ttlMs);
      assert.equal(result.ok, true, 'verify must succeed');

      // After verify: both PTTLs should be re-extended (back to ~ttlMs+grace)
      const recordPttlAfter = await redis.pttl(recordKey);
      const latestPttlAfter = await redis.pttl(latestKey);

      // Record should slide forward (grace is 60_000ms past expiresAt)
      assert.ok(
        recordPttlAfter > recordPttlBefore - 100,
        `record TTL must extend on verify, before=${recordPttlBefore}ms after=${recordPttlAfter}ms`,
      );
      // Latest is the bug — without fix, it stays at original ~recordPttlBefore-200ms
      // With fix, it extends in lockstep with record.
      assert.ok(
        latestPttlAfter > recordPttlAfter - 200,
        `latest TTL must slide with record (P1 bug). recordAfter=${recordPttlAfter}ms latestAfter=${latestPttlAfter}ms drift=${recordPttlAfter - latestPttlAfter}ms`,
      );
    } finally {
      // Cleanup test keys
      const leftover = await redis.keys('cat-cafe-ttl-slide-test:*');
      if (leftover.length > 0) {
        await redis.del(...leftover.map((k) => k.replace('cat-cafe-ttl-slide-test:', '')));
      }
      await redis.quit();
    }
  });

  // Cloud Codex P2 (PR #1368, ef22153e1): verifyLatest must also slide msgs
  // key TTL. Otherwise long sessions kept alive only by refresh-token lose
  // the dedup set when the original create-time TTL expires, and previously-
  // claimed clientMessageIds become first-seen again — dedup contract broken.
  test('verifyLatest() extends msgs key TTL (cloud P2 #1368)', async () => {
    const { createRedisClient } = await import('@cat-cafe/shared/utils');
    const { RedisAuthInvocationBackend } = await import(
      '../dist/domains/cats/services/agents/invocation/RedisAuthInvocationBackend.js'
    );

    const redis = createRedisClient({ url: REDIS_URL, keyPrefix: 'cat-cafe-msgs-ttl-test:' });
    try {
      const leftover = await redis.keys('cat-cafe-msgs-ttl-test:*');
      if (leftover.length > 0) {
        await redis.del(...leftover.map((k) => k.replace('cat-cafe-msgs-ttl-test:', '')));
      }

      const backend = new RedisAuthInvocationBackend(redis);
      const ttlMs = 60_000;
      await backend.create(
        {
          invocationId: 'msgs-test:inv-1',
          callbackToken: 'tok-1',
          userId: 'u-1',
          catId: 'opus',
          threadId: 'msgs-test:thread-1',
          clientMessageIds: new Set(),
          createdAt: Date.now(),
        },
        ttlMs,
      );

      // claimClientMessageId creates the msgs key (PEXPIREAT to record's expiresAt+grace).
      assert.equal(await backend.claimClientMessageId('msgs-test:inv-1', 'msg-A'), true);

      const msgsKey = 'auth:inv:msgs-test:inv-1:msgs';
      const msgsPttlBefore = await redis.pttl(msgsKey);
      assert.ok(msgsPttlBefore > 0, 'msgs PTTL must be set after first claim');

      await new Promise((r) => setTimeout(r, 200));
      const result = await backend.verifyLatest('msgs-test:inv-1', 'tok-1', ttlMs);
      assert.equal(result.ok, true, 'verifyLatest must succeed');

      const msgsPttlAfter = await redis.pttl(msgsKey);
      // verifyLatest re-anchors PTTL to now+ttlMs+grace, so it should be at
      // least the original (or larger). Without the fix, PTTL would drift
      // down by ~200ms (the wait) since no slide happened.
      assert.ok(
        msgsPttlAfter > msgsPttlBefore - 100,
        `msgs TTL must slide on verifyLatest (cloud P2 #1368). before=${msgsPttlBefore}ms after=${msgsPttlAfter}ms drift=${msgsPttlBefore - msgsPttlAfter}ms`,
      );
    } finally {
      const leftover = await redis.keys('cat-cafe-msgs-ttl-test:*');
      if (leftover.length > 0) {
        await redis.del(...leftover.map((k) => k.replace('cat-cafe-msgs-ttl-test:', '')));
      }
      await redis.quit();
    }
  });
});
