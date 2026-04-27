/**
 * F174 Phase D1 — callback auth failure telemetry (AC-D1, AC-D2).
 *
 * Tests the central recorder + snapshot used by the debug endpoint and
 * the OTel counter export. Counter shape lives in instruments.ts; this
 * file proves the in-memory tally + per-reason coverage contract.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';

describe('callback-auth-telemetry (F174-D1)', () => {
  let recordCallbackAuthFailure;
  let getCallbackAuthFailureSnapshot;
  let resetCallbackAuthFailureForTest;

  beforeEach(async () => {
    const mod = await import('../dist/routes/callback-auth-telemetry.js');
    recordCallbackAuthFailure = mod.recordCallbackAuthFailure;
    getCallbackAuthFailureSnapshot = mod.getCallbackAuthFailureSnapshot;
    resetCallbackAuthFailureForTest = mod.resetCallbackAuthFailureForTest;
    resetCallbackAuthFailureForTest();
  });

  test('AC-D1: snapshot starts empty', () => {
    const snap = getCallbackAuthFailureSnapshot();
    assert.deepEqual(snap.reasonCounts, {
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
    assert.deepEqual(snap.toolCounts, {});
    assert.equal(snap.totalFailures, 0);
  });

  test('AC-D2: all 5 reasons increment correctly', () => {
    const reasons = ['expired', 'invalid_token', 'unknown_invocation', 'missing_creds', 'stale_invocation'];
    for (const reason of reasons) {
      recordCallbackAuthFailure({ reason, tool: 'refresh-token', catId: 'opus' });
    }
    const snap = getCallbackAuthFailureSnapshot();
    for (const reason of reasons) {
      assert.equal(snap.reasonCounts[reason], 1, `reason=${reason} count must be 1`);
    }
    assert.equal(snap.totalFailures, 5);
  });

  test('toolCounts tracks per-tool failures', () => {
    recordCallbackAuthFailure({ reason: 'expired', tool: 'refresh-token', catId: 'opus' });
    recordCallbackAuthFailure({ reason: 'expired', tool: 'refresh-token', catId: 'opus' });
    recordCallbackAuthFailure({ reason: 'invalid_token', tool: 'post-message', catId: 'codex' });
    const snap = getCallbackAuthFailureSnapshot();
    assert.equal(snap.toolCounts['refresh-token'], 2);
    assert.equal(snap.toolCounts['post-message'], 1);
    assert.equal(snap.totalFailures, 3);
  });

  test('recentSamples includes timestamp, reason, tool, catId (last N)', () => {
    recordCallbackAuthFailure({ reason: 'expired', tool: 'refresh-token', catId: 'opus' });
    recordCallbackAuthFailure({ reason: 'invalid_token', tool: 'post-message', catId: 'codex' });
    const snap = getCallbackAuthFailureSnapshot();
    assert.ok(Array.isArray(snap.recentSamples));
    assert.equal(snap.recentSamples.length, 2);
    const last = snap.recentSamples[snap.recentSamples.length - 1];
    assert.equal(last.reason, 'invalid_token');
    assert.equal(last.tool, 'post-message');
    assert.equal(last.catId, 'codex');
    assert.ok(typeof last.at === 'number' && last.at > 0);
  });

  test('recentSamples capped to prevent unbounded growth', () => {
    for (let i = 0; i < 200; i++) {
      recordCallbackAuthFailure({ reason: 'expired', tool: 'refresh-token', catId: 'opus' });
    }
    const snap = getCallbackAuthFailureSnapshot();
    assert.ok(snap.recentSamples.length <= 100, `recentSamples must cap at 100, got ${snap.recentSamples.length}`);
    assert.equal(snap.totalFailures, 200, 'totalFailures still tracks all');
    assert.equal(snap.reasonCounts.expired, 200, 'reasonCounts not capped');
  });

  test('handles missing catId gracefully (panel/anonymous failures)', () => {
    recordCallbackAuthFailure({ reason: 'missing_creds', tool: 'refresh-token' });
    const snap = getCallbackAuthFailureSnapshot();
    assert.equal(snap.reasonCounts.missing_creds, 1);
    assert.equal(snap.recentSamples[0].catId, undefined);
  });
});
