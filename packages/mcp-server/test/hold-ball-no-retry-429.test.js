/**
 * F257 fix (verdict PR #39): hold_ball must NOT auto-retry on 429.
 *
 * Root cause: callback-retry treats 429 as retryable (shouldRetryStatus).
 * hold_ball's 429 means "MAX_HOLDS_PER_WINDOW (3/h) reached" — the window
 * is 1 hour, so retrying in 1s/2s/4s will never succeed. The default retry
 * policy caused 3 identical POSTs, each emitting a GuardRejectionEvent,
 * hitting the threshold-escalation trigger on retry noise rather than
 * genuine independent violations.
 *
 * Fix: handleHoldBall passes { retryDelaysMs: [] } to callbackPost, making
 * it a single-attempt call. The 429 error is still surfaced to the cat.
 *
 * Evidence: 3 events in 3,032ms from thread_mrkn6povq4zzgh45/gpt52,
 * intervals ~1,016ms and ~2,016ms matching DEFAULT_RETRY_DELAYS_MS [1000, 2000, 4000].
 *
 * Fixture env vars: CAT_CAFE_API_URL, CAT_CAFE_INVOCATION_ID, CAT_CAFE_CALLBACK_TOKEN
 * (matches getCallbackConfig in callback-tools.ts:139-165). Higher-priority
 * credential sources (CAT_CAFE_CREDENTIAL_FILE, agent-key variants) are
 * explicitly cleared so the test is self-contained and CI-portable.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

/** Keys to save/restore — covers all credential resolution paths. */
const ENV_KEYS = [
  'CAT_CAFE_API_URL',
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_CREDENTIAL_FILE',
  'CAT_CAFE_AGENT_KEY_SECRET',
  'CAT_CAFE_AGENT_KEY_FILE',
  'CAT_CAFE_AGENT_KEY_FILES',
  'CAT_CAFE_CALLBACK_RETRY_DELAYS_MS',
  'CAT_CAFE_CALLBACK_FETCH_TIMEOUT_MS',
];

/** Classify a fetch URL by endpoint. */
function endpointOf(url) {
  const s = String(url);
  if (s.includes('/api/callbacks/hold-ball')) return 'hold-ball';
  if (s.includes('/api/callbacks/freshness-hold-ball-reminder')) return 'freshness';
  return 'other';
}

describe('hold_ball 429 — no auto-retry (F257 fix)', () => {
  let originalFetch;
  const savedEnv = {};

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    // Save and clear all credential env vars so we control the exact config
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
    // Set the exact vars getCallbackConfig reads (callback-tools.ts:139-154)
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:19999';
    process.env.CAT_CAFE_INVOCATION_ID = 'test-invocation-id';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-callback-token';
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    // Restore all env vars exactly
    for (const key of ENV_KEYS) {
      if (savedEnv[key] !== undefined) {
        process.env[key] = savedEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  test('429 response causes exactly 1 hold-ball POST (no retry)', async () => {
    const counts = { 'hold-ball': 0, freshness: 0, other: 0 };

    globalThis.fetch = async (url) => {
      counts[endpointOf(url)]++;
      return {
        ok: false,
        status: 429,
        text: async () =>
          JSON.stringify({
            error: 'maxHoldsPerWindow (3 per ~1h window) reached.',
            holdsInWindow: 3,
            maxHoldsPerWindow: 3,
            windowMs: 3600000,
          }),
        json: async () => ({}),
      };
    };

    const { handleHoldBall } = await import('../dist/tools/callback-tools.js');
    const result = await handleHoldBall({
      reason: 'test wait',
      nextStep: 'pass ball',
      wakeAfterMs: 10000,
      waitSourceRef: {
        kind: 'github_issue',
        value: '#test-1',
        expectedSignal: 'close',
        slaUntilMs: Date.now() + 60000,
      },
    });

    assert.equal(counts['hold-ball'], 1, 'hold_ball 429: exactly 1 POST to hold-ball endpoint');
    assert.equal(counts.freshness, 0, '429 path should not call freshness reminder');
    assert.equal(result.isError, true, '429 should surface as an error to the cat');
  });

  test('successful hold_ball: exactly 1 hold + 1 freshness fetch', async () => {
    const counts = { 'hold-ball': 0, freshness: 0, other: 0 };

    globalThis.fetch = async (url) => {
      const ep = endpointOf(url);
      counts[ep]++;
      if (ep === 'hold-ball') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ taskId: 'hold-ball-test-123', scheduled: true }),
        };
      }
      // Freshness reminder (F254 B2) — return no reminder
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
      };
    };

    const { handleHoldBall } = await import('../dist/tools/callback-tools.js');
    const result = await handleHoldBall({
      reason: 'test wait',
      nextStep: 'check CI',
      wakeAfterMs: 10000,
      waitSourceRef: {
        kind: 'github_issue',
        value: '#test-2',
        expectedSignal: 'merge',
        slaUntilMs: Date.now() + 60000,
      },
    });

    assert.ok(!result.isError, 'successful hold_ball should not be an error');
    assert.equal(counts['hold-ball'], 1, 'success path: exactly 1 POST to hold-ball');
    assert.equal(counts.freshness, 1, 'success path: exactly 1 POST to freshness reminder');
  });

  test('red-green: with env retry overrides, 429 would cause 4 POSTs without the fix', async () => {
    // This test proves the fix is load-bearing: if retryDelaysMs=[] were
    // removed from handleHoldBall, the default retry policy would kick in.
    // We use env override to set fast retries so this test runs quickly.
    //
    // With the fix in place: retryDelaysMs=[] takes precedence over env →
    // exactly 1 POST. This is the "green" assertion.
    //
    // To verify the "red" side: temporarily remove `{ retryDelaysMs: [] }`
    // from callback-tools.ts → rebuild → this test should see 4 POSTs and fail.
    process.env.CAT_CAFE_CALLBACK_RETRY_DELAYS_MS = '0,0,0';

    const counts = { 'hold-ball': 0, freshness: 0, other: 0 };

    globalThis.fetch = async (url) => {
      counts[endpointOf(url)]++;
      return {
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: 'rate limited' }),
        json: async () => ({}),
      };
    };

    const { handleHoldBall } = await import('../dist/tools/callback-tools.js');
    await handleHoldBall({
      reason: 'test retry override',
      nextStep: 'should not retry',
      wakeAfterMs: 10000,
      waitSourceRef: {
        kind: 'github_issue',
        value: '#test-3',
        expectedSignal: 'label',
        slaUntilMs: Date.now() + 60000,
      },
    });

    // With the fix: retryDelaysMs=[] overrides env → 1 POST
    // Without the fix: env [0,0,0] → 4 POSTs (1 initial + 3 retries)
    assert.equal(
      counts['hold-ball'],
      1,
      'retryDelaysMs=[] in code must override env default — exactly 1 POST even with env retries set',
    );
  });
});
