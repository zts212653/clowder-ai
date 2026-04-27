/**
 * F174 Phase D2a — backend extensions for the dashboard card (D2b frontend
 * will consume these). Adds:
 *   - `byCat` counter (per-cat failure totals, mirrors `toolCounts`)
 *   - 24h rolling window via per-hour ring buffer (24 buckets)
 *   - `recent24h` snapshot section: {totalFailures, byReason, byTool, byCat}
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

describe('callback-auth-telemetry D2a (F174-D2a)', () => {
  let mod;
  let recordCallbackAuthFailure;
  let getCallbackAuthFailureSnapshot;
  let resetCallbackAuthFailureForTest;
  let __setNowForTest;

  beforeEach(async () => {
    mod = await import('../dist/routes/callback-auth-telemetry.js');
    recordCallbackAuthFailure = mod.recordCallbackAuthFailure;
    getCallbackAuthFailureSnapshot = mod.getCallbackAuthFailureSnapshot;
    resetCallbackAuthFailureForTest = mod.resetCallbackAuthFailureForTest;
    __setNowForTest = mod.__setNowForTest;
    resetCallbackAuthFailureForTest();
    if (typeof __setNowForTest === 'function') __setNowForTest(null);
  });

  test('AC-D2a byCat: catId-bearing failures aggregate per cat', () => {
    recordCallbackAuthFailure({ reason: 'expired', tool: 'refresh-token', catId: 'opus' });
    recordCallbackAuthFailure({ reason: 'expired', tool: 'refresh-token', catId: 'opus' });
    recordCallbackAuthFailure({ reason: 'invalid_token', tool: 'post-message', catId: 'codex' });
    const snap = getCallbackAuthFailureSnapshot();
    assert.equal(snap.byCat.opus, 2);
    assert.equal(snap.byCat.codex, 1);
  });

  test('AC-D2a byCat: anonymous (no catId) failures do NOT pollute byCat', () => {
    recordCallbackAuthFailure({ reason: 'missing_creds', tool: 'refresh-token' });
    recordCallbackAuthFailure({ reason: 'expired', tool: 'post-message', catId: 'opus' });
    const snap = getCallbackAuthFailureSnapshot();
    assert.equal(snap.byCat.opus, 1);
    assert.equal(snap.byCat.undefined, undefined, 'anonymous must not become a "undefined" key');
    assert.equal(Object.keys(snap.byCat).length, 1);
  });

  test('AC-D2a recent24h shape: empty initially', () => {
    const snap = getCallbackAuthFailureSnapshot();
    assert.ok(snap.recent24h, 'snapshot must include recent24h section');
    assert.equal(snap.recent24h.totalFailures, 0);
    assert.deepEqual(snap.recent24h.byReason, {
      expired: 0,
      invalid_token: 0,
      unknown_invocation: 0,
      missing_creds: 0,
      stale_invocation: 0,
      agent_key_expired: 0,
      agent_key_revoked: 0,
      agent_key_unknown: 0,
      agent_key_scope_mismatch: 0,
    });
    assert.deepEqual(snap.recent24h.byTool, {});
    assert.deepEqual(snap.recent24h.byCat, {});
  });

  test('AC-D2a recent24h: rolls up only failures from last 24h', () => {
    if (typeof __setNowForTest !== 'function') {
      throw new Error('test requires __setNowForTest export');
    }
    const T0 = 1_700_000_000_000; // arbitrary fixed reference
    const HOUR = 60 * 60 * 1000;

    // 25 hours ago — should be dropped
    __setNowForTest(T0 - 25 * HOUR);
    recordCallbackAuthFailure({ reason: 'expired', tool: 'refresh-token', catId: 'opus' });

    // 23 hours ago — should be kept
    __setNowForTest(T0 - 23 * HOUR);
    recordCallbackAuthFailure({ reason: 'invalid_token', tool: 'post-message', catId: 'codex' });

    // 1 hour ago — should be kept
    __setNowForTest(T0 - 1 * HOUR);
    recordCallbackAuthFailure({ reason: 'expired', tool: 'refresh-token', catId: 'opus' });
    recordCallbackAuthFailure({ reason: 'stale_invocation', tool: 'post-message', catId: 'opus' });

    // Snapshot taken at T0
    __setNowForTest(T0);
    const snap = getCallbackAuthFailureSnapshot();

    // Lifetime totals include all 4
    assert.equal(snap.totalFailures, 4);

    // 24h window only includes the 3 within last 24h
    assert.equal(snap.recent24h.totalFailures, 3, 'must drop the 25h-ago record');
    assert.equal(snap.recent24h.byReason.expired, 1, 'only the 1h-ago expired in window');
    assert.equal(snap.recent24h.byReason.invalid_token, 1);
    assert.equal(snap.recent24h.byReason.stale_invocation, 1);
    assert.equal(snap.recent24h.byTool['refresh-token'], 1);
    assert.equal(snap.recent24h.byTool['post-message'], 2);
    assert.equal(snap.recent24h.byCat.opus, 2);
    assert.equal(snap.recent24h.byCat.codex, 1);
  });

  // Cloud Codex P2 (PR #1393): reset helper must also clear nowOverride so
  // a previous __setNowForTest doesn't leak a frozen clock into later tests
  // that only call reset.
  test('AC-D2a P2 #1393: reset helper clears injected clock', () => {
    if (typeof __setNowForTest !== 'function') return;
    const FROZEN = 1_700_000_000_000;
    __setNowForTest(FROZEN);
    // Verify clock is frozen
    let snap = getCallbackAuthFailureSnapshot();
    const uptimeBefore = snap.uptimeMs;

    // Reset should restore wall-clock behavior
    resetCallbackAuthFailureForTest();

    // After reset, uptimeMs should reflect wall-clock (not the frozen FROZEN-startedAt)
    snap = getCallbackAuthFailureSnapshot();
    assert.notEqual(snap.uptimeMs, uptimeBefore, 'reset must clear injected clock');
    // Wall clock now > FROZEN, so uptime is current Date.now() - startedAt; not equal to frozen
    assert.ok(Math.abs(snap.uptimeMs - (Date.now() - snap.startedAt)) < 100, 'uptime should track wall clock');
  });

  test('AC-D2a recent24h: bucket rotation drops oldest as time advances', () => {
    if (typeof __setNowForTest !== 'function') return;
    const T0 = 1_700_000_000_000;
    const HOUR = 60 * 60 * 1000;

    // Record at T0 - 23h
    __setNowForTest(T0 - 23 * HOUR);
    recordCallbackAuthFailure({ reason: 'expired', tool: 'refresh-token', catId: 'opus' });

    // At T0: still in window
    __setNowForTest(T0);
    let snap = getCallbackAuthFailureSnapshot();
    assert.equal(snap.recent24h.totalFailures, 1);

    // 2 hours later: now 25h old, should drop
    __setNowForTest(T0 + 2 * HOUR);
    snap = getCallbackAuthFailureSnapshot();
    assert.equal(snap.recent24h.totalFailures, 0, 'rotated out of window');
  });
});
