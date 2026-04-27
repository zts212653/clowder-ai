/**
 * F174 Phase D1 — `/api/debug/callback-auth` endpoint (AC-D3).
 *
 * Session-cookie-only owner gate — cloud Codex P1 (20:30Z) proved that
 * header-based paths (including Origin-gated ones) are spoofable by
 * same-origin browser GETs (which omit Origin). The only trustworthy
 * identity source for a sensitive debug endpoint is the session cookie.
 *
 * Tests use a preHandler to set `request.sessionUserId` from a test-only
 * header, mirroring what the real session plugin would do after validating
 * the signed cookie.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

/**
 * Build a Fastify app with the debug route + a test session shim.
 * Send `x-test-session-user: <userId>` header to simulate an authenticated
 * session cookie. Real requests would use the `sessionAuthPlugin`; we skip
 * that to avoid pulling the whole cookie stack into unit tests.
 */
async function buildApp() {
  const { registerCallbackAuthDebugRoute } = await import('../dist/routes/callback-auth-debug.js');
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    const v = request.headers['x-test-session-user'];
    const raw = Array.isArray(v) ? v[0] : v;
    if (typeof raw === 'string' && raw.trim().length > 0) {
      request.sessionUserId = raw.trim();
    }
  });
  registerCallbackAuthDebugRoute(app);
  await app.ready();
  return app;
}

describe('GET /api/debug/callback-auth — session-only (F174-D1)', () => {
  let app;
  let resetCallbackAuthFailureForTest;
  let recordCallbackAuthFailure;

  beforeEach(async () => {
    const mod = await import('../dist/routes/callback-auth-telemetry.js');
    resetCallbackAuthFailureForTest = mod.resetCallbackAuthFailureForTest;
    recordCallbackAuthFailure = mod.recordCallbackAuthFailure;
    resetCallbackAuthFailureForTest();
    app = await buildApp();
    // Owner gate now requires explicit DEFAULT_OWNER_USER_ID — set to match session user
    process.env.DEFAULT_OWNER_USER_ID = 'default-user';
  });

  test('returns 200 snapshot shape when session is present', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/debug/callback-auth',
      headers: { 'x-test-session-user': 'default-user' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.deepEqual(Object.keys(body.reasonCounts).sort(), [
      'agent_key_expired',
      'agent_key_revoked',
      'agent_key_scope_mismatch',
      'agent_key_unknown',
      'expired',
      'invalid_token',
      'missing_creds',
      'stale_invocation',
      'unknown_invocation',
    ]);
    assert.equal(typeof body.totalFailures, 'number');
    assert.equal(typeof body.uptimeMs, 'number');
    assert.ok(Array.isArray(body.recentSamples));
    assert.ok(typeof body.toolCounts === 'object' && body.toolCounts !== null);
  });

  test('reflects recorded failures live', async () => {
    recordCallbackAuthFailure({ reason: 'expired', tool: 'refresh-token', catId: 'opus' });
    recordCallbackAuthFailure({ reason: 'stale_invocation', tool: 'post-message', catId: 'codex' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/debug/callback-auth',
      headers: { 'x-test-session-user': 'default-user' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.totalFailures, 2);
    assert.equal(body.reasonCounts.expired, 1);
    assert.equal(body.reasonCounts.stale_invocation, 1);
    assert.equal(body.toolCounts['refresh-token'], 1);
    assert.equal(body.toolCounts['post-message'], 1);
  });
});

describe('GET /api/debug/callback-auth — auth rejections (F174-D1)', () => {
  let app;

  beforeEach(async () => {
    const mod = await import('../dist/routes/callback-auth-telemetry.js');
    mod.resetCallbackAuthFailureForTest();
    app = await buildApp();
  });

  test('rejects 401 when no session cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/debug/callback-auth' });
    assert.equal(res.statusCode, 401);
    assert.match(JSON.parse(res.body).error, /session/i);
  });

  // Cloud Codex P1 (PR #1377, 20:30Z): same-origin GET can omit Origin header,
  // so "no Origin = non-browser" assumption fails. Any compromised/injected
  // browser JS could then send X-Cat-Cafe-User and pass the gate. Header path
  // must be removed entirely; session cookie is the only trust anchor.
  test('rejects X-Cat-Cafe-User header even with no Origin (P1 #1377, 20:30Z)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/debug/callback-auth',
      headers: { 'x-cat-cafe-user': 'default-user' }, // no session, spoofable
    });
    assert.equal(res.statusCode, 401, 'header-only identity must be rejected — session cookie required');
  });

  test('rejects X-Cat-Cafe-User header even with Origin set', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/debug/callback-auth',
      headers: {
        origin: 'http://localhost:3000',
        'x-cat-cafe-user': 'default-user',
      },
    });
    assert.equal(res.statusCode, 401);
  });

  // Cloud Codex P1 (PR #1377, 21:00Z): /api/session mints sessions for
  // anonymous callers, so "has session" alone is not authorization — an
  // anonymous attacker can create a session and read telemetry. Require
  // session user to match the configured owner.
  test('rejects 403 when session user is not the configured owner (P1 #1377, 21:00Z)', async () => {
    process.env.DEFAULT_OWNER_USER_ID = 'alice';
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/debug/callback-auth',
        headers: { 'x-test-session-user': 'default-user' }, // session mints default-user
      });
      assert.equal(res.statusCode, 403, 'non-owner session must NOT bypass ownership gate');
      assert.match(JSON.parse(res.body).error, /owner/i);
    } finally {
      delete process.env.DEFAULT_OWNER_USER_ID;
    }
  });

  // Cloud Codex P1 (PR #1377, 21:13Z): defaulting expected owner to
  // 'default-user' = silent public exposure (anyone can mint /api/session
  // session as 'default-user'). Endpoint must fail-closed when env unset.
  test('rejects 403 when DEFAULT_OWNER_USER_ID not configured (fail-closed P1 21:13Z)', async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;
    const res = await app.inject({
      method: 'GET',
      url: '/api/debug/callback-auth',
      headers: { 'x-test-session-user': 'default-user' },
    });
    assert.equal(res.statusCode, 403, 'must fail-closed when owner not explicitly configured');
    assert.match(JSON.parse(res.body).error, /DEFAULT_OWNER_USER_ID/);
  });

  test('accepts owner session when DEFAULT_OWNER_USER_ID explicitly set to default-user', async () => {
    process.env.DEFAULT_OWNER_USER_ID = 'default-user';
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/debug/callback-auth',
        headers: { 'x-test-session-user': 'default-user' },
      });
      assert.equal(res.statusCode, 200, 'explicit opt-in to default-user owner allows access');
    } finally {
      delete process.env.DEFAULT_OWNER_USER_ID;
    }
  });
});

// F174 D2b-2 rev3 — POST /api/debug/callback-auth/mark-viewed.
// Implements GitHub bell / iOS app badge "未读 → 看过 → 消失" mental model.
// Same owner gate as snapshot read.
describe('POST /api/debug/callback-auth/mark-viewed — F174 D2b-2 rev3', () => {
  let app;
  let resetCallbackAuthFailureForTest;
  let recordCallbackAuthFailure;

  beforeEach(async () => {
    const mod = await import('../dist/routes/callback-auth-telemetry.js');
    resetCallbackAuthFailureForTest = mod.resetCallbackAuthFailureForTest;
    recordCallbackAuthFailure = mod.recordCallbackAuthFailure;
    resetCallbackAuthFailureForTest();
    app = await buildApp();
    process.env.DEFAULT_OWNER_USER_ID = 'default-user';
  });

  test('owner session: 200 + viewedAt + lastViewedAt (post-call timestamp)', async () => {
    const before = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/api/debug/callback-auth/mark-viewed',
      headers: { 'x-test-session-user': 'default-user' },
    });
    const after = Date.now();
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(typeof body.viewedAt, 'number');
    assert.ok(body.viewedAt >= before && body.viewedAt <= after);
    assert.equal(body.lastViewedAt, body.viewedAt);
  });

  test('snapshot reflects unviewedFailures24h drop after mark-viewed', async () => {
    // Use __setNowForTest for deterministic time control — round 5's `>=` safe-side
    // semantic means same-ms collisions count failures as unviewed; this test
    // requires lastViewedAt strictly > sample.at to assert "all viewed".
    // 砚砚 round 6 退回原因：under load, recordCallbackAuthFailure + mark-viewed
    // can collide on the same Date.now() ms → flaky failure when assert == 0.
    const { __setNowForTest } = await import('../dist/routes/callback-auth-telemetry.js');
    const T_RECORD = 1_700_000_000_000;
    const T_VIEW = T_RECORD + 100; // 100ms gap, well clear of same-ms ambiguity

    __setNowForTest(T_RECORD);
    try {
      // Record 3 failures at T_RECORD — all unviewed
      recordCallbackAuthFailure({ reason: 'expired', tool: 'refresh-token', catId: 'opus' });
      recordCallbackAuthFailure({ reason: 'stale_invocation', tool: 'post-message', catId: 'codex' });
      recordCallbackAuthFailure({ reason: 'invalid_token', tool: 'register-pr', catId: 'gpt52' });

      const beforeView = await app.inject({
        method: 'GET',
        url: '/api/debug/callback-auth',
        headers: { 'x-test-session-user': 'default-user' },
      });
      const before = JSON.parse(beforeView.body);
      assert.equal(before.unviewedFailures24h, 3, '3 failures all unviewed pre-mark');
      assert.equal(before.lastViewedAt, 0, 'never-viewed defaults to 0');

      // Advance clock + mark viewed at T_VIEW — viewedUpTo strictly > all sample.at
      __setNowForTest(T_VIEW);
      await app.inject({
        method: 'POST',
        url: '/api/debug/callback-auth/mark-viewed',
        headers: {
          'x-test-session-user': 'default-user',
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ viewedUpTo: T_VIEW }),
      });

      const afterView = await app.inject({
        method: 'GET',
        url: '/api/debug/callback-auth',
        headers: { 'x-test-session-user': 'default-user' },
      });
      const after = JSON.parse(afterView.body);
      assert.equal(after.unviewedFailures24h, 0, 'all 3 failures now viewed (sample.at < lastViewedAt)');
      assert.ok(after.lastViewedAt >= T_VIEW, 'lastViewedAt advanced to T_VIEW');
      assert.equal(after.totalFailures, 3, 'totalFailures unchanged (lifetime metric)');
      assert.equal(after.recent24h.totalFailures, 3, 'recent24h.totalFailures unchanged');
    } finally {
      __setNowForTest(null);
    }
  });

  test('new failures AFTER mark-viewed re-populate unviewedFailures24h', async () => {
    recordCallbackAuthFailure({ reason: 'expired', tool: 'tool-1' });
    // Small delay so lastViewedAt > sample.at (Date.now() ms-resolution can
    // collide otherwise — we want strict "post-view" semantics for the badge).
    await new Promise((r) => setTimeout(r, 5));
    await app.inject({
      method: 'POST',
      url: '/api/debug/callback-auth/mark-viewed',
      headers: { 'x-test-session-user': 'default-user' },
    });
    await new Promise((r) => setTimeout(r, 5));
    // Now NEW failure after viewing
    recordCallbackAuthFailure({ reason: 'invalid_token', tool: 'tool-2' });

    const res = await app.inject({
      method: 'GET',
      url: '/api/debug/callback-auth',
      headers: { 'x-test-session-user': 'default-user' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.unviewedFailures24h, 1, 'only the post-view failure counts as unviewed');
    assert.equal(body.totalFailures, 2);
  });

  test('rejects 401 when no session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/debug/callback-auth/mark-viewed',
    });
    assert.equal(res.statusCode, 401);
    assert.match(JSON.parse(res.body).error, /session/i);
  });

  test('rejects 403 when session user is not the configured owner', async () => {
    process.env.DEFAULT_OWNER_USER_ID = 'alice';
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/debug/callback-auth/mark-viewed',
        headers: { 'x-test-session-user': 'default-user' },
      });
      assert.equal(res.statusCode, 403);
    } finally {
      delete process.env.DEFAULT_OWNER_USER_ID;
    }
  });

  test('rejects 403 when DEFAULT_OWNER_USER_ID not configured (fail-closed)', async () => {
    delete process.env.DEFAULT_OWNER_USER_ID;
    const res = await app.inject({
      method: 'POST',
      url: '/api/debug/callback-auth/mark-viewed',
      headers: { 'x-test-session-user': 'default-user' },
    });
    assert.equal(res.statusCode, 403);
    assert.match(JSON.parse(res.body).error, /DEFAULT_OWNER_USER_ID/);
  });

  // Cloud Codex P2 #1425: optional viewedUpTo body — only ack failures the
  // user actually saw in the rendered snapshot, not any that arrived between
  // the last poll and panel open.
  test('viewedUpTo body: server uses provided timestamp (when <= now)', async () => {
    const t0 = Date.now();
    const earlier = t0 - 60_000; // 1 min ago
    const res = await app.inject({
      method: 'POST',
      url: '/api/debug/callback-auth/mark-viewed',
      headers: {
        'x-test-session-user': 'default-user',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ viewedUpTo: earlier }),
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.viewedAt, earlier, 'server uses provided viewedUpTo verbatim when valid');
    assert.equal(body.lastViewedAt, earlier);
  });

  test('viewedUpTo body: server clamps to Date.now() when client passes future timestamp', async () => {
    const future = Date.now() + 60 * 60 * 1000; // 1h ahead
    const before = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/api/debug/callback-auth/mark-viewed',
      headers: {
        'x-test-session-user': 'default-user',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ viewedUpTo: future }),
    });
    const after = Date.now();
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.viewedAt >= before && body.viewedAt <= after, 'clamped to server now()');
    assert.notEqual(body.viewedAt, future, 'future timestamp must not be honored');
  });

  test('viewedUpTo body: failures between snapshot-time and now stay unviewed (Cloud P2 fix)', async () => {
    // Simulate the Cloud Codex P2 scenario:
    //   t=0     failure A occurs        (in snapshot)
    //   t=10ms  snapshot fetched        (frontend has A only)
    //   t=20ms  failure B occurs        (NOT in snapshot user is viewing)
    //   t=30ms  user opens panel → markViewed(viewedUpTo=t=10ms)
    // Expected: B remains unviewed (user never saw it).
    recordCallbackAuthFailure({ reason: 'expired', tool: 'failure-A' });
    await new Promise((r) => setTimeout(r, 10));
    const snapshotTime = Date.now();
    await new Promise((r) => setTimeout(r, 10));
    recordCallbackAuthFailure({ reason: 'invalid_token', tool: 'failure-B' });
    await new Promise((r) => setTimeout(r, 10));

    await app.inject({
      method: 'POST',
      url: '/api/debug/callback-auth/mark-viewed',
      headers: {
        'x-test-session-user': 'default-user',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ viewedUpTo: snapshotTime }),
    });

    const finalSnap = await app.inject({
      method: 'GET',
      url: '/api/debug/callback-auth',
      headers: { 'x-test-session-user': 'default-user' },
    });
    const body = JSON.parse(finalSnap.body);
    assert.equal(body.unviewedFailures24h, 1, 'failure-B remains unviewed; failure-A acked');
    assert.equal(body.totalFailures, 2);
  });

  test('viewedUpTo body: rejects negative or non-number values (zod schema)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/debug/callback-auth/mark-viewed',
      headers: {
        'x-test-session-user': 'default-user',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ viewedUpTo: -1 }),
    });
    assert.equal(res.statusCode, 400);
  });

  test('no body: defaults to Date.now() (back-compat with pre-P2 frontend)', async () => {
    const before = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: '/api/debug/callback-auth/mark-viewed',
      headers: { 'x-test-session-user': 'default-user' },
    });
    const after = Date.now();
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.viewedAt >= before && body.viewedAt <= after);
  });

  // Cloud Codex P2 #1425 round 2: monotonic lastViewedAt — a delayed/stale
  // mark-viewed (e.g. from a tab that loaded an older snapshot) must NOT
  // move the watermark backwards, otherwise previously-cleared failures
  // would re-appear as unviewed.
  test('monotonic: stale viewedUpTo (older than current) does NOT move watermark backwards', async () => {
    // First call: advance lastViewedAt to "now"
    const newer = Date.now();
    const firstRes = await app.inject({
      method: 'POST',
      url: '/api/debug/callback-auth/mark-viewed',
      headers: { 'x-test-session-user': 'default-user' },
    });
    const first = JSON.parse(firstRes.body);
    assert.ok(first.lastViewedAt >= newer, 'first call sets lastViewedAt to now');

    // Second call: stale viewedUpTo well in the past
    const stale = newer - 5 * 60 * 1000; // 5 min ago
    const secondRes = await app.inject({
      method: 'POST',
      url: '/api/debug/callback-auth/mark-viewed',
      headers: {
        'x-test-session-user': 'default-user',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ viewedUpTo: stale }),
    });
    const second = JSON.parse(secondRes.body);
    assert.equal(secondRes.statusCode, 200);
    assert.equal(
      second.lastViewedAt,
      first.lastViewedAt,
      'stale viewedUpTo must not regress watermark — server keeps the higher value',
    );
    assert.equal(second.viewedAt, stale, 'response viewedAt reflects the request, but lastViewedAt is monotonic');
  });

  // Cloud Codex P2 #1425 round 5: same-ms safe-side bias — failure recorded
  // in the same Date.now() ms as lastViewedAt should count as UNVIEWED, not
  // be silently dropped. Strict `>` would lose unread notifications under
  // bursty traffic. Test uses __setNowForTest to deterministically set up
  // a same-ms collision.
  test('same-ms collision: failure at exact lastViewedAt ms counts as unviewed (Cloud P2 round 5)', async () => {
    const { __setNowForTest } = await import('../dist/routes/callback-auth-telemetry.js');
    const FIXED_T = 1_000_000_000_000; // arbitrary epoch ms
    __setNowForTest(FIXED_T);
    try {
      // Record a failure at exactly FIXED_T
      recordCallbackAuthFailure({ reason: 'expired', tool: 'collision-tool', catId: 'opus' });

      // Mark viewed at exactly FIXED_T (same ms)
      const res = await app.inject({
        method: 'POST',
        url: '/api/debug/callback-auth/mark-viewed',
        headers: {
          'x-test-session-user': 'default-user',
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ viewedUpTo: FIXED_T }),
      });
      assert.equal(res.statusCode, 200);
      assert.equal(JSON.parse(res.body).lastViewedAt, FIXED_T);

      // Snapshot: with `>=` semantic, the failure at FIXED_T counts as unviewed
      const snap = await app.inject({
        method: 'GET',
        url: '/api/debug/callback-auth',
        headers: { 'x-test-session-user': 'default-user' },
      });
      const body = JSON.parse(snap.body);
      assert.equal(
        body.unviewedFailures24h,
        1,
        'same-ms failure must NOT be silently dropped — safe-side counts as unviewed',
      );
    } finally {
      __setNowForTest(null);
    }
  });

  test('monotonic: previously cleared failures stay cleared even after stale mark-viewed', async () => {
    recordCallbackAuthFailure({ reason: 'expired', tool: 'failure-X' });
    await new Promise((r) => setTimeout(r, 5));
    // Mark viewed at "now" — clears failure-X
    await app.inject({
      method: 'POST',
      url: '/api/debug/callback-auth/mark-viewed',
      headers: { 'x-test-session-user': 'default-user' },
    });
    const afterClear = await app.inject({
      method: 'GET',
      url: '/api/debug/callback-auth',
      headers: { 'x-test-session-user': 'default-user' },
    });
    assert.equal(JSON.parse(afterClear.body).unviewedFailures24h, 0);

    // Now a stale tab POSTs with old viewedUpTo
    await app.inject({
      method: 'POST',
      url: '/api/debug/callback-auth/mark-viewed',
      headers: {
        'x-test-session-user': 'default-user',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ viewedUpTo: 1000 }), // ancient
    });
    const afterStale = await app.inject({
      method: 'GET',
      url: '/api/debug/callback-auth',
      headers: { 'x-test-session-user': 'default-user' },
    });
    assert.equal(
      JSON.parse(afterStale.body).unviewedFailures24h,
      0,
      'failure-X stays cleared — stale tab cannot un-acknowledge',
    );
  });
});
