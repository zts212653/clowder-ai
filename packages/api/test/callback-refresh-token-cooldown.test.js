/**
 * F174 Phase C: POST /api/callbacks/refresh-token — cooldown behavior.
 *
 * AC-C4: rate-limited per invocation per 5min max 1 refresh.
 * Plus all the "bad-auth不烧 slot" / legacy / mixed-source variants that
 * defend the cooldown counter against unauthenticated requests.
 *
 * Cloud Codex P1 (PR #1368, c5927046): split off from monolithic 403-line
 * callback-refresh-token.test.js to honor 350-line hard cap.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createTestContext } from './helpers/refresh-token-test-app.js';

describe('POST /api/callbacks/refresh-token — cooldown (F174-C)', () => {
  test('rate-limited at >1 refresh per cooldown window per invocation', async () => {
    const { registry, createApp } = await createTestContext();
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');

    const res1 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });
    assert.equal(res1.statusCode, 200, 'first refresh should succeed');

    const res2 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });
    assert.equal(res2.statusCode, 429, 'immediate second refresh should be rate-limited');

    const body = JSON.parse(res2.body);
    assert.equal(body.error, 'refresh_rate_limited');
    assert.equal(typeof body.retryAfterMs, 'number');
    assert.ok(body.retryAfterMs > 0);
  });

  // F174-C P1 (gpt52 review #1363+): rate-limited request must NOT slide TTL.
  // Cooldown was previously checked in route handler AFTER preHandler.verify()
  // which already slid TTL — so 429 was cosmetic, attacker could still extend.
  test('AC-C4 真防滥用: rate-limited refresh does NOT slide TTL', async () => {
    const { registry, createApp } = await createTestContext();
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');

    const res1 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });
    assert.equal(res1.statusCode, 200);
    const expiresAfterFirst = JSON.parse(res1.body).expiresAt;

    // Wait so any TTL slide on the rate-limited request would push expiresAt forward
    await new Promise((r) => setTimeout(r, 50));

    const res2 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });
    assert.equal(res2.statusCode, 429, 'second refresh in cooldown should 429');

    const recordAfterRateLimit = await registry.getRecord(invocationId);
    assert.ok(recordAfterRateLimit, 'record should still exist');
    assert.ok(
      recordAfterRateLimit.expiresAt <= expiresAfterFirst + 5,
      `rate-limited request slid TTL by ${recordAfterRateLimit.expiresAt - expiresAfterFirst}ms; should be 0`,
    );
  });

  // F174-C P1 #2 (gpt52 review #1368): cooldown must NOT be consumed by
  // unauthenticated requests. Pre-fix attack: send missing-token request →
  // 401 + cooldown burned → real refresh blocked 5min.
  test('AC-C4 bad-auth不烧 slot: missing token does NOT consume cooldown', async () => {
    const { registry, createApp } = await createTestContext();
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');

    const resBad = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': invocationId },
    });
    assert.equal(resBad.statusCode, 401, 'missing token must 401');
    assert.equal(JSON.parse(resBad.body).reason, 'missing_creds');

    const resReal = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });
    assert.equal(resReal.statusCode, 200, 'legitimate refresh must succeed (cooldown not burned by bad-auth)');
  });

  test('AC-C4 bad-auth不烧 slot: invalid token does NOT consume cooldown', async () => {
    const { registry, createApp } = await createTestContext();
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');

    const resBad = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': 'wrong-token' },
    });
    assert.equal(resBad.statusCode, 401);
    assert.equal(JSON.parse(resBad.body).reason, 'invalid_token');

    const resReal = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });
    assert.equal(resReal.statusCode, 200, 'legitimate refresh must succeed after invalid-token attempt');
  });

  // Cloud Codex P1 (PR #1368): refresh cooldown was header-only, but the auth
  // system also accepts legacy body/query creds from the #509 compat window.
  // Legacy clients bypassed cooldown entirely.
  test('AC-C4 legacy compat: cooldown applies to body credentials too', async () => {
    const { registry, createApp } = await createTestContext();
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');

    const res1 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      payload: { invocationId, callbackToken },
    });
    assert.equal(res1.statusCode, 200, 'legacy body refresh #1 should succeed');

    const res2 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      payload: { invocationId, callbackToken },
    });
    assert.equal(res2.statusCode, 429, 'legacy body refresh #2 must be rate-limited');
  });

  test('AC-C4 legacy compat: cooldown applies to query credentials too', async () => {
    const { registry, createApp } = await createTestContext();
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');

    const url = `/api/callbacks/refresh-token?invocationId=${invocationId}&callbackToken=${callbackToken}`;
    const res1 = await app.inject({ method: 'POST', url });
    assert.equal(res1.statusCode, 200, 'legacy query refresh #1 should succeed');

    const res2 = await app.inject({ method: 'POST', url });
    assert.equal(res2.statusCode, 429, 'legacy query refresh #2 must be rate-limited');
  });

  // F174-C P1 #3 (gpt52 review #1368): preValidation legacy merge rule was
  // looser than preHandler. Mixed-source creds passed peek + claimed cooldown
  // — but preHandler then 401'd as missing_creds. Net result: bad-auth burned slot.
  test('AC-C4 mixed-source不烧 slot: header inv + body tok does NOT consume cooldown', async () => {
    const { registry, createApp } = await createTestContext();
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');

    const resBad = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': invocationId },
      payload: { callbackToken },
    });
    assert.equal(resBad.statusCode, 401, 'mixed-source must be rejected');
    assert.equal(JSON.parse(resBad.body).reason, 'missing_creds');

    const resReal = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });
    assert.equal(resReal.statusCode, 200, 'legitimate refresh must succeed (mixed-source did not burn slot)');
  });

  test('AC-C4 mixed-source不烧 slot: header tok + body inv does NOT consume cooldown', async () => {
    const { registry, createApp } = await createTestContext();
    const app = await createApp();
    const { invocationId, callbackToken } = await registry.create('user-1', 'opus', 'thread-1');

    const resBad = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-callback-token': callbackToken },
      payload: { invocationId },
    });
    assert.equal(resBad.statusCode, 401);

    const resReal = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });
    assert.equal(resReal.statusCode, 200);
  });

  test('rate limit is per-invocation, not global', async () => {
    const { registry, createApp } = await createTestContext();
    const app = await createApp();
    const inv1 = await registry.create('user-1', 'opus', 'thread-1');
    const inv2 = await registry.create('user-1', 'codex', 'thread-2');

    const r1 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': inv1.invocationId, 'x-callback-token': inv1.callbackToken },
    });
    const r2 = await app.inject({
      method: 'POST',
      url: '/api/callbacks/refresh-token',
      headers: { 'x-invocation-id': inv2.invocationId, 'x-callback-token': inv2.callbackToken },
    });
    assert.equal(r1.statusCode, 200);
    assert.equal(r2.statusCode, 200, 'different invocation must not share cooldown');
  });
});
