/**
 * F174 Phase C: POST /api/callbacks/refresh-token — auth path tests.
 *
 * AC-C1: endpoint落地, header creds, fail-closed 401 (reason from Phase A)
 * AC-C2: response includes expiresAt + ttlRemainingMs
 *
 * Cloud Codex P1 (PR #1368, c5927046): split off from monolithic 403-line
 * callback-refresh-token.test.js to honor 350-line hard cap.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createTestContext } from './helpers/refresh-token-test-app.js';

describe('POST /api/callbacks/refresh-token — auth (F174-C)', () => {
  test('returns 200 with ok/expiresAt/ttlRemainingMs on valid creds', async () => {
    const { registry, createApp } = await createTestContext();
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(typeof body.expiresAt, 'number');
    assert.ok(body.expiresAt > Date.now(), 'expiresAt should be in the future');
    assert.equal(typeof body.ttlRemainingMs, 'number');
    assert.ok(body.ttlRemainingMs > 0, 'ttlRemainingMs should be positive');
  });

  test('returns 401 with reason:invalid_token on bad token', async () => {
    const { registry, createApp } = await createTestContext();
    const app = await createApp();
    const { invocationId } = await registry.create('user-1', 'opus', 'thread-1');

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': 'wrong' },
    });

    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'callback_auth_failed');
    assert.equal(body.reason, 'invalid_token');
  });

  test('returns 401 with reason:unknown_invocation on missing invocation', async () => {
    const { createApp } = await createTestContext();
    const app = await createApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': 'never-existed', 'x-callback-token': 'any' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).reason, 'unknown_invocation');
  });

  test('returns 401 with reason:missing_creds on missing headers', async () => {
    const { createApp } = await createTestContext();
    const app = await createApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': 'only-one' },
    });
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).reason, 'missing_creds');
  });

  // Cloud Codex P2 (PR #1368, 6c8a4365): when ALL creds are absent, preHandler
  // no-ops (panel-path), so refresh-token must emit missing_creds itself —
  // otherwise handler returns unknown_invocation, misclassifying the failure.
  test('returns 401 with reason:missing_creds when no creds at all (cloud P2 #1368)', async () => {
    const { createApp } = await createTestContext();
    const app = await createApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
    });
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).reason, 'missing_creds');
  });

  // AC-C2 detail: ttlRemainingMs reflects current remaining (not full TTL)
  test('ttlRemainingMs equals expiresAt - now', async () => {
    const { registry, createApp } = await createTestContext();
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    const body = JSON.parse(res.body);
    const computed = body.expiresAt - Date.now();
    // Allow ~50ms slack for round-trip
    assert.ok(Math.abs(body.ttlRemainingMs - computed) < 100, `mismatch: ${body.ttlRemainingMs} vs ${computed}`);
  });
});
