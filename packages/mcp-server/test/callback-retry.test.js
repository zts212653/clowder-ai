/**
 * callback-retry postJsonWithRetry — fetch timeout (hung socket) tests
 *
 * Layer 3 fix: the raw fetch in postJsonWithRetry has NO AbortSignal, so a hung
 * TCP socket (server accepts but never responds) leaves `await fetch` pending
 * FOREVER — it never throws (no retry) and never resolves. Every callback
 * (hold_ball / post_message / ...) then hangs the cat's tool call indefinitely.
 * Same defect class as refresh-loop PR #1368 (e521cc7aa), which this path missed.
 *
 * Fix: add `signal: AbortSignal.timeout(...)` so a hung socket aborts → AbortError
 * → caught as retryable → retries → exhausts → returns a failure result (bounded),
 * instead of pending forever.
 *
 * Uses globalThis.fetch mocking; tests run against compiled dist/.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

describe('postJsonWithRetry — fetch timeout (hung socket)', () => {
  let originalEnv;
  let originalFetch;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
  });

  test('aborts a hung fetch via timeout instead of pending forever', async () => {
    process.env.CAT_CAFE_CALLBACK_FETCH_TIMEOUT_MS = '50';
    const { postJsonWithRetry } = await import('../dist/tools/callback-retry.js');

    let attemptCount = 0;
    let abortCount = 0;
    // Hung socket: the returned promise ONLY settles if the request is aborted.
    // Pre-fix (no signal passed) → never settles → postJsonWithRetry hangs forever.
    globalThis.fetch = (_url, opts) =>
      new Promise((_resolve, reject) => {
        attemptCount++;
        const signal = opts?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            abortCount++;
            // Reject with the signal's REAL reason — for AbortSignal.timeout()
            // that's a TimeoutError DOMException, exactly what production fetch
            // throws on timeout. (sonnet review P3: mock should mirror the real
            // error type, not a hand-rolled AbortError.) Fallback keeps the test
            // robust if a future caller passes a plain AbortController signal.
            reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
          });
        }
      });

    // Race against a watchdog: if postJsonWithRetry never returns, the test fails
    // with a clear "HUNG" message rather than silently timing out the suite.
    const result = await Promise.race([
      postJsonWithRetry('http://127.0.0.1:1/x', '{}', [0, 0]),
      new Promise((_resolve, reject) =>
        setTimeout(() => reject(new Error('HUNG: postJsonWithRetry never returned within 3s')), 3000),
      ),
    ]);

    assert.equal(result.ok, false, 'should return a bounded failure after timeout + retry exhaustion');
    assert.ok(abortCount >= 1, `expected the hung fetch to be timeout-aborted, got abortCount=${abortCount}`);
    assert.ok(attemptCount >= 1, 'fetch should have been attempted');
  });

  test('a slow-but-within-timeout fetch still succeeds (no false abort)', async () => {
    process.env.CAT_CAFE_CALLBACK_FETCH_TIMEOUT_MS = '500';
    const { postJsonWithRetry } = await import('../dist/tools/callback-retry.js');

    globalThis.fetch = (_url, _opts) =>
      new Promise((resolve) => {
        // resolves well within the 500ms timeout
        setTimeout(() => resolve({ ok: true, json: async () => ({ status: 'ok' }) }), 20);
      });

    const result = await postJsonWithRetry('http://127.0.0.1:1/x', '{}', [0, 0]);
    assert.equal(result.ok, true, 'a fast response must not be aborted by the timeout');
  });
});
