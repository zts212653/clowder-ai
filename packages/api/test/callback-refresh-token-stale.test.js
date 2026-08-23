/**
 * F174 Phase C: POST /api/callbacks/refresh-token — stale invocation guard.
 *
 * F298: a superseded active attempt is durably terminalized as `replaced`.
 *
 * Cloud Codex P2 (PR #1368, c5927046): split off from monolithic 403-line
 * callback-refresh-token.test.js to honor 350-line hard cap.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createTestContext } from './helpers/refresh-token-test-app.js';

describe('POST /api/callbacks/refresh-token — stale guard (F174-C)', () => {
  test('superseded invocation refresh returns its typed replaced tombstone', async () => {
    const { registry, createApp } = await createTestContext();
    const app = await createApp();
    const old = await registry.create('user-1', 'opus', 'thread-1');
    const recordBefore = await registry.getRecord(old.invocationId);
    assert.ok(recordBefore, 'old record should exist');
    assert.equal(recordBefore.expiresAt, null);

    // Newer invocation supersedes the old one
    await registry.create('user-1', 'opus', 'thread-1');
    assert.equal(await registry.isLatest(old.invocationId), false, 'old must now be stale');

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': old.invocationId, 'x-callback-token': old.callbackToken },
    });

    assert.equal(res.statusCode, 401, 'replaced refresh must 401');
    const body = JSON.parse(res.body);
    assert.equal(body.error, 'callback_auth_failed');
    assert.equal(body.reason, 'replaced');

    const recordAfter = await registry.getRecord(old.invocationId);
    assert.ok(recordAfter, 'record still exists');
    assert.equal(recordAfter.state, 'replaced');
    assert.equal(typeof recordAfter.expiresAt, 'number', 'only the terminal tombstone has a GC deadline');
    assert.ok(recordAfter.expiresAt > Date.now());
  });
});
