/**
 * F174 Phase C: POST /api/callbacks/refresh-token — auth path tests.
 *
 * AC-C1: endpoint落地, header creds, fail-closed 401 (reason from Phase A)
 * F298: active credentials report null expiry fields (no heartbeat extension contract).
 *
 * Cloud Codex P1 (PR #1368, c5927046): split off from monolithic 403-line
 * callback-refresh-token.test.js to honor 350-line hard cap.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createTestContext } from './helpers/refresh-token-test-app.js';

describe('POST /api/callbacks/refresh-token — auth (F174-C)', () => {
  test('returns 200 with explicit null expiry fields on valid creds', async () => {
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
    assert.equal(body.expiresAt, null);
    assert.equal(body.ttlRemainingMs, null);
  });

  test('fails closed before refresh preValidation can inspect durable credentials', async () => {
    const { registry, createApp } = await createTestContext({ startupRecoveryRequired: true });
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(res.statusCode, 503);
    assert.equal(res.json().reason, 'startup_recovery_pending');
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

  test('refresh does not manufacture a new active deadline', async () => {
    const { registry, createApp } = await createTestContext();
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    const body = JSON.parse(res.body);
    assert.deepEqual(
      { expiresAt: body.expiresAt, ttlRemainingMs: body.ttlRemainingMs },
      { expiresAt: null, ttlRemainingMs: null },
    );
  });
});
