/**
 * F174 Phase D1 — end-to-end wiring: every 401 from real routes must
 * increment the telemetry snapshot. Validates AC-D2 (all 5 reasons covered)
 * by hitting routes through Fastify and asserting reasonCounts.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import { createTestContext } from './helpers/refresh-token-test-app.js';

describe('callback-auth-telemetry integration (F174-D1)', () => {
  let getCallbackAuthFailureSnapshot;
  let resetCallbackAuthFailureForTest;

  beforeEach(async () => {
    const mod = await import('../dist/routes/callback-auth-telemetry.js');
    getCallbackAuthFailureSnapshot = mod.getCallbackAuthFailureSnapshot;
    resetCallbackAuthFailureForTest = mod.resetCallbackAuthFailureForTest;
    resetCallbackAuthFailureForTest();
  });

  test('refresh-token missing_creds increments counter (AC-D2)', async () => {
    const { createApp } = await createTestContext();
    const app = await createApp();
    const res = await app.inject({ method: 'POST', url: '/api/callbacks/refresh-token' });
    assert.equal(res.statusCode, 401);
    const snap = getCallbackAuthFailureSnapshot();
    assert.equal(snap.reasonCounts.missing_creds, 1);
    assert.equal(snap.toolCounts['refresh-token'], 1);
  });

  test('refresh-token invalid_token increments counter (AC-D2)', async () => {
    const { registry, createApp } = await createTestContext();
    const app = await createApp();
    const { invocationId } = await registry.create('user-1', 'opus', 'thread-1');
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': 'wrong' },
    });
    assert.equal(res.statusCode, 401);
    const snap = getCallbackAuthFailureSnapshot();
    assert.equal(snap.reasonCounts.invalid_token, 1);
  });

  test('refresh-token unknown_invocation increments counter (AC-D2)', async () => {
    const { createApp } = await createTestContext();
    const app = await createApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': 'never-existed', 'x-callback-token': 'any' },
    });
    assert.equal(res.statusCode, 401);
    const snap = getCallbackAuthFailureSnapshot();
    assert.equal(snap.reasonCounts.unknown_invocation, 1);
  });

  test('refresh-token interrupted increments counter (AC-D2)', async () => {
    const { registry, createApp } = await createTestContext();
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');
    await registry.commitTerminal({
      invocationId,
      disposition: 'interrupted',
      endedAt: Date.now(),
      endReason: 'api_restart',
      terminalRef: `turn_execution:${invocationId}`,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });
    assert.equal(res.statusCode, 401);
    const snap = getCallbackAuthFailureSnapshot();
    assert.equal(snap.reasonCounts.interrupted, 1, 'typed terminal path must increment counter');
  });

  test('refresh-token replaced increments counter (AC-D2)', async () => {
    const { registry, createApp } = await createTestContext();
    const app = await createApp();
    const old = await registry.create('user-1', 'opus', 'thread-1');
    await registry.create('user-1', 'opus', 'thread-1'); // supersedes old
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': old.invocationId, 'x-callback-token': old.callbackToken },
    });
    assert.equal(res.statusCode, 401);
    const snap = getCallbackAuthFailureSnapshot();
    assert.equal(snap.reasonCounts.replaced, 1);
  });
});
