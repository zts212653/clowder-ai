/**
 * Test: preflightRace helper — prevents invocation generator from hanging
 * when pre-flight async operations (Redis, session chain) are unresponsive.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

// Static import for tests that don't need a custom timeout
import { PREFLIGHT_TIMEOUT_MS, preflightRace } from '../dist/domains/cats/services/agents/invocation/invoke-helpers.js';

describe('preflightRace', () => {
  it('resolves when promise completes before timeout', async () => {
    const result = await preflightRace(Promise.resolve(42), 'test-fast');
    assert.equal(result, 42);
  });

  it('rejects when abort signal fires before timeout', async () => {
    const ac = new AbortController();
    const neverResolves = new Promise(() => {});

    // Fire abort after 20ms
    setTimeout(() => ac.abort(new Error('user_cancel')), 20);

    await assert.rejects(preflightRace(neverResolves, 'test-abort', ac.signal), /user_cancel/);
  });

  it('rejects immediately when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort(new Error('already_aborted'));

    await assert.rejects(
      preflightRace(Promise.resolve('never-seen'), 'test-pre-aborted', ac.signal),
      /already_aborted/,
    );
  });

  it('cleans up timer when promise resolves first', async () => {
    // This primarily tests there's no unhandled rejection from the timeout
    const result = await preflightRace(new Promise((resolve) => setTimeout(() => resolve('fast'), 10)), 'test-cleanup');
    assert.equal(result, 'fast');
  });

  it('PREFLIGHT_TIMEOUT_MS defaults to 30 seconds', () => {
    assert.equal(PREFLIGHT_TIMEOUT_MS, 30_000);
  });
});

describe('preflightRace timeout (short env override)', () => {
  let shortPreflightRace;
  let originalEnv;

  before(async () => {
    originalEnv = process.env.CAT_CAFE_PREFLIGHT_TIMEOUT_MS;
    process.env.CAT_CAFE_PREFLIGHT_TIMEOUT_MS = '100';
    // Dynamic import with cache-bust to pick up the env override
    const mod = await import(`../dist/domains/cats/services/agents/invocation/invoke-helpers.js?t=${Date.now()}`);
    shortPreflightRace = mod.preflightRace;
  });

  after(() => {
    if (originalEnv === undefined) delete process.env.CAT_CAFE_PREFLIGHT_TIMEOUT_MS;
    else process.env.CAT_CAFE_PREFLIGHT_TIMEOUT_MS = originalEnv;
  });

  it('rejects with preflight_timeout when promise hangs past timeout', async () => {
    const neverResolves = new Promise(() => {});
    await assert.rejects(shortPreflightRace(neverResolves, 'test-hang'), /preflight_timeout: test-hang/);
  });
});
