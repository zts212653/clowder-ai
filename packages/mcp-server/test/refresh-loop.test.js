/**
 * F174 Phase C — MCP client refresh loop algorithm tests.
 *
 * AC-C3: client uses clamp(ttlRemainingMs/4, 5min, 30min) + jitter ±15%
 * AC-C5: refresh failure does not crash, returns rescheduling decision
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('refresh loop algorithm (F174-C)', () => {
  // Note: MIN_DELAY_MS is now derived from server cooldown (5min) + 5% buffer
  // / jitter floor (0.85) = ~6.18min, so jittered minimum stays above the
  // server's 5min cooldown and never wastes a 429 round-trip.
  // Range: jittered min ≈ 6.18 × 0.85 = 5.25min; jittered max from MIN ≈ 6.18 × 1.15 = 7.11min.
  const MIN_BASE_MS = Math.ceil((5 * 60_000 * 1.05) / 0.85); // ≈ 370_588ms
  const MIN_JITTERED = MIN_BASE_MS * 0.85; // ≈ 314_999ms (5.25min)
  const MIN_JITTERED_UPPER = MIN_BASE_MS * 1.15; // ≈ 426_176ms (7.11min)
  const MAX_JITTERED_LOWER = 30 * 60_000 * 0.85; // 25.5min
  const MAX_JITTERED_UPPER = 30 * 60_000 * 1.15; // 34.5min

  test('AC-C3: 2h TTL → ~30min next-delay (clamped to upper bound, ±15%)', async () => {
    const { computeNextRefreshDelay } = await import('../dist/refresh-loop.js');
    for (let i = 0; i < 50; i++) {
      const d = computeNextRefreshDelay(2 * 60 * 60_000);
      assert.ok(d >= MAX_JITTERED_LOWER && d <= MAX_JITTERED_UPPER, `iter ${i}: 2h TTL got ${d}ms`);
    }
  });

  test('AC-C3: 10min TTL → MIN-clamped (proportional 2.5min < min, ±15%)', async () => {
    const { computeNextRefreshDelay } = await import('../dist/refresh-loop.js');
    for (let i = 0; i < 50; i++) {
      const d = computeNextRefreshDelay(10 * 60_000);
      assert.ok(d >= MIN_JITTERED && d <= MIN_JITTERED_UPPER, `iter ${i}: 10min TTL got ${d}ms`);
    }
  });

  test('AC-C3: 4h TTL → ~30min upper-clamped (proportional 60min > max, ±15%)', async () => {
    const { computeNextRefreshDelay } = await import('../dist/refresh-loop.js');
    for (let i = 0; i < 50; i++) {
      const d = computeNextRefreshDelay(4 * 60 * 60_000);
      assert.ok(d >= MAX_JITTERED_LOWER && d <= MAX_JITTERED_UPPER, `iter ${i}: 4h TTL got ${d}ms`);
    }
  });

  test('AC-C3: clamps below min for very short TTL (defensive)', async () => {
    const { computeNextRefreshDelay } = await import('../dist/refresh-loop.js');
    const d = computeNextRefreshDelay(30_000);
    assert.ok(d >= MIN_JITTERED, `tiny TTL must clamp to ≥cooldown-safe min, got ${d}ms`);
  });

  test('AC-C3: handles zero/negative TTL without throwing', async () => {
    const { computeNextRefreshDelay } = await import('../dist/refresh-loop.js');
    const dZero = computeNextRefreshDelay(0);
    const dNeg = computeNextRefreshDelay(-1000);
    assert.ok(dZero >= MIN_JITTERED, `0 TTL → min, got ${dZero}ms`);
    assert.ok(dNeg >= MIN_JITTERED, `negative TTL → min, got ${dNeg}ms`);
  });

  // Cloud Codex P2 (PR #1368): jittered delay must never fall below the
  // server's refresh cooldown (5min) — otherwise the loop fires too early
  // and wastes a 429 round-trip. Pre-fix: clamp(5min) * 0.85 = 4.25min.
  test('AC-C3 cooldown safe: jittered delay always >= 5min server cooldown', async () => {
    const { computeNextRefreshDelay } = await import('../dist/refresh-loop.js');
    const SERVER_COOLDOWN_MS = 5 * 60_000;

    // Test boundary cases that would have produced sub-cooldown delays:
    // - 10min TTL (/4 = 2.5min, clamps to lower)
    // - 5min TTL (/4 = 1.25min, clamps to lower)
    // - 1min TTL (way below)
    // - 20min TTL (/4 = 5min, exactly at lower bound)
    const inputs = [10 * 60_000, 5 * 60_000, 1 * 60_000, 20 * 60_000];
    for (const ttl of inputs) {
      // Run many iterations to exercise jitter randomness
      for (let i = 0; i < 100; i++) {
        const delay = computeNextRefreshDelay(ttl);
        assert.ok(
          delay >= SERVER_COOLDOWN_MS,
          `ttl=${ttl}ms iter ${i}: delay ${delay}ms < server cooldown ${SERVER_COOLDOWN_MS}ms (would burn 429)`,
        );
      }
    }
  });

  // Cloud Codex P2 (PR #1368, 22:55Z): refresh tick used callbackPost which
  // retries 408/429/5xx by default. 429 = server cooldown (5min), retry within
  // seconds is guaranteed to fail → 3 wasted retries per scheduled tick.
  // Refresh loop is itself a retry mechanism — doubling is structural duplication.
  test('AC-C5 no double retry: refresh tick on 429 makes exactly 1 fetch (no callback-retry layer)', async () => {
    const { performRefreshTick } = await import('../dist/refresh-loop.js');

    let fetchCallCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCallCount++;
      return {
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: 'refresh_rate_limited', retryAfterMs: 300_000 }),
      };
    };

    process.env.CAT_CAFE_API_URL = 'http://localhost:3003';
    process.env.CAT_CAFE_INVOCATION_ID = 'test-inv';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-tok';

    try {
      const result = await performRefreshTick();
      assert.equal(fetchCallCount, 1, `429 must NOT trigger retries, got ${fetchCallCount} fetch calls`);
      // Result should be a failure decision (loop reschedules)
      assert.equal(result.ok, false);
      assert.equal(typeof result.nextDelayMs, 'number');
      assert.ok(result.nextDelayMs > 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('AC-C5 no double retry: refresh tick on 5xx makes exactly 1 fetch', async () => {
    const { performRefreshTick } = await import('../dist/refresh-loop.js');

    let fetchCallCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      fetchCallCount++;
      return { ok: false, status: 503, text: async () => 'service unavailable' };
    };
    process.env.CAT_CAFE_API_URL = 'http://localhost:3003';
    process.env.CAT_CAFE_INVOCATION_ID = 'test-inv';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-tok';

    try {
      const result = await performRefreshTick();
      assert.equal(fetchCallCount, 1, `5xx must NOT retry within tick, got ${fetchCallCount} fetch calls`);
      assert.equal(result.ok, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // AC-C5: failure handling
  test('AC-C5: handleRefreshFailure returns reschedule + delay (no throw)', async () => {
    const { handleRefreshFailure } = await import('../dist/refresh-loop.js');
    const result = handleRefreshFailure(new Error('ECONNREFUSED'));
    assert.equal(result.shouldReschedule, true);
    assert.ok(result.delayMs >= 60_000, `back-off should be >=1min, got ${result.delayMs}`);
  });

  test('AC-C5: failure with non-Error throwable still handled', async () => {
    const { handleRefreshFailure } = await import('../dist/refresh-loop.js');
    const result1 = handleRefreshFailure('string error');
    const result2 = handleRefreshFailure(undefined);
    assert.equal(result1.shouldReschedule, true);
    assert.equal(result2.shouldReschedule, true);
  });

  // Cloud Codex P1 (PR #1368, 06:52Z, e4da094a59): registering SIGINT/SIGTERM
  // handlers without calling process.exit() suppresses Node's default termination
  // behavior, leaving the MCP process unable to shutdown on signals.
  //
  // Cloud Codex P2 (PR #1368, 08:15Z, 7de77a70d): exit(0) hides termination
  // cause from supervisors. Standard Unix: exit(128+signum) — SIGTERM=143,
  // SIGINT=130 — preserves signal semantics.
  test('AC-C5 signal handler: SIGINT/SIGTERM stop loop AND exit with 128+signum', async () => {
    const { installShutdownHandlers } = await import('../dist/refresh-loop.js');

    let stopCalls = 0;
    let exitCode = null;
    const fakeLoop = { stop: () => stopCalls++ };
    const captured = new Map();
    const fakeProcess = {
      on: (signal, handler) => captured.set(signal, handler),
      exit: (code) => {
        exitCode = code;
      },
    };

    installShutdownHandlers(fakeLoop, fakeProcess);
    assert.ok(captured.has('SIGTERM'), 'SIGTERM handler must be registered');
    assert.ok(captured.has('SIGINT'), 'SIGINT handler must be registered');

    captured.get('SIGTERM')();
    assert.equal(stopCalls, 1, 'SIGTERM must call loop.stop()');
    assert.equal(exitCode, 128 + 15, 'SIGTERM must exit with 143 (128+SIGTERM=15)');

    exitCode = null;
    captured.get('SIGINT')();
    assert.equal(stopCalls, 2, 'SIGINT must call loop.stop()');
    assert.equal(exitCode, 128 + 2, 'SIGINT must exit with 130 (128+SIGINT=2)');
  });

  // Cloud Codex P1 (PR #1368, 07:36Z, e521cc7aa): performRefreshTick issued
  // fetch() with no abort/timeout. A hung TCP socket would leave the await
  // pending forever, blocking the next setTimeout from firing → token expires
  // silently in long sessions.
  test('AC-C5 timeout: hung fetch aborts within timeout, returns failure decision', async () => {
    const { performRefreshTick } = await import('../dist/refresh-loop.js');

    let abortedAt = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (_url, opts) =>
      new Promise((_resolve, reject) => {
        opts?.signal?.addEventListener('abort', () => {
          abortedAt = Date.now();
          const err = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });

    process.env.CAT_CAFE_API_URL = 'http://localhost:3003';
    process.env.CAT_CAFE_INVOCATION_ID = 'test-inv';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-tok';

    try {
      const t0 = Date.now();
      const result = await performRefreshTick({ timeoutMs: 200 });
      const elapsed = Date.now() - t0;
      assert.ok(abortedAt !== null, 'fetch must be aborted via AbortSignal');
      assert.ok(elapsed < 1000, `tick must abort near 200ms timeout, took ${elapsed}ms`);
      assert.equal(result.ok, false, 'aborted tick = failure decision');
      assert.ok(result.nextDelayMs > 0, 'must reschedule');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
