/**
 * F174 Phase C: POST /api/callbacks/refresh-token — stale invocation guard.
 *
 * Cloud Codex P1 (PR #1368): refresh-token currently slides TTL on stale
 * invocations because it doesn't run the isLatest() guard that other
 * stale-aware routes use (post_message:347, update_bootcamp etc). Refusing
 * with stale_invocation reason keeps stale invocation lifecycle aligned
 * across the system.
 *
 * Cloud Codex P2 (PR #1368, c5927046): split off from monolithic 403-line
 * callback-refresh-token.test.js to honor 350-line hard cap.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createTestContext } from './helpers/refresh-token-test-app.js';

describe('POST /api/callbacks/refresh-token — stale guard (F174-C)', () => {
  test('stale invocation refresh: 401 stale_invocation + does NOT slide TTL', async () => {
    const { registry, createApp } = await createTestContext();
    const app = await createApp();
    const old = await registry.create('user-1', 'opus', 'thread-1');
    const recordBefore = await registry.getRecord(old.invocationId);
    assert.ok(recordBefore, 'old record should exist');
    const expiresBefore = recordBefore.expiresAt;

    // Newer invocation supersedes the old one
    await registry.create('user-1', 'opus', 'thread-1');
    assert.equal(await registry.isLatest(old.invocationId), false, 'old must now be stale');

    // Wait so any TTL slide would push expiresAt forward measurably
    await new Promise((r) => setTimeout(r, 50));

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': old.invocationId, 'x-callback-token': old.callbackToken },
    });

    assert.equal(res.statusCode, 401, 'stale refresh must 401');
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'callback_auth_failed');
    assert.equal(body.reason, 'stale_invocation');

    // Most important: TTL must NOT have been slid
    const recordAfter = await registry.getRecord(old.invocationId);
    assert.ok(recordAfter, 'record still exists');
    const drift = recordAfter.expiresAt - expiresBefore;
    assert.ok(drift <= 5, `stale refresh slid TTL by ${drift}ms; should be 0`);
  });
});
