// @ts-check
/**
 * F268 AC-B1: Tip telemetry ingress route tests.
 *
 * Verifies:
 * - 401 without session
 * - 400 on invalid batch schema (client dead-letters)
 * - 202 on valid batch with correct ack shape
 * - Idempotent: same (batchId, attempt) returns 202 without re-ingesting
 * - Privacy: extra fields in events cause 400 (structural rejection)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const AUTH_HEADERS = { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' };
const NOW = 1721000005000;

/**
 * @returns {Promise<import('fastify').FastifyInstance>}
 */
async function buildApp() {
  const Fastify = (await import('fastify')).default;
  const { tipTelemetryRoutes, InMemoryTipEventSink } = await import('../dist/routes/tip-telemetry.js');

  const app = Fastify();

  // Minimal session auth decorator matching production pattern
  app.decorateRequest('sessionUserId', null);
  app.addHook('preHandler', async (request) => {
    const userId = request.headers['x-cat-cafe-user'];
    if (typeof userId === 'string') {
      // @ts-expect-error — decorator assignment
      request.sessionUserId = userId;
    }
  });

  const sink = new InMemoryTipEventSink();
  await app.register(tipTelemetryRoutes, { sink, now: () => NOW });
  return app;
}

const validBatch = {
  batchId: '550e8400-e29b-41d4-a716-446655440000',
  attempt: 1,
  events: [
    {
      event: 'capability_tip_exposed',
      tipId: 'magic-word-scaffold',
      context: 'thinking',
      surface: 'pending_bubble',
      outcome: 'shown',
      timestamp: 1721000000000,
    },
  ],
  assembledAt: 1721000005000,
  schemaVersion: 1,
};

describe('F268 tip-telemetry route', () => {
  it('returns 401 without session auth', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/tip-telemetry/batch',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(validBatch),
    });
    assert.equal(res.statusCode, 401);
    await app.close();
  });

  it('returns 202 with valid batch', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/tip-telemetry/batch',
      headers: AUTH_HEADERS,
      payload: JSON.stringify(validBatch),
    });
    assert.equal(res.statusCode, 202);
    const body = res.json();
    assert.equal(body.batchId, validBatch.batchId);
    assert.equal(body.accepted, 1);
    assert.equal(body.rejected, 0);
    await app.close();
  });

  it('returns 400 on invalid batch schema', async () => {
    const app = await buildApp();
    const invalidBatch = { ...validBatch, batchId: 'not-a-uuid' };
    const res = await app.inject({
      method: 'POST',
      url: '/api/tip-telemetry/batch',
      headers: AUTH_HEADERS,
      payload: JSON.stringify(invalidBatch),
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.accepted, 0);
    assert.ok(body.rejected > 0);
    assert.ok(Array.isArray(body.rejectedReasons));
    await app.close();
  });

  it('returns 400 when event has extra field (privacy guard)', async () => {
    const app = await buildApp();
    const batch = {
      ...validBatch,
      events: [
        {
          ...validBatch.events[0],
          secretContent: 'this should be rejected by .strict()',
        },
      ],
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/tip-telemetry/batch',
      headers: AUTH_HEADERS,
      payload: JSON.stringify(batch),
    });
    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.accepted, 0);
    await app.close();
  });

  it('is idempotent: same (batchId, attempt) returns 202 without double-counting', async () => {
    const app = await buildApp();

    // First submission
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/tip-telemetry/batch',
      headers: AUTH_HEADERS,
      payload: JSON.stringify(validBatch),
    });
    assert.equal(res1.statusCode, 202);

    // Same batch again (network retry)
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/tip-telemetry/batch',
      headers: AUTH_HEADERS,
      payload: JSON.stringify(validBatch),
    });
    assert.equal(res2.statusCode, 202);
    const body = res2.json();
    assert.equal(body.batchId, validBatch.batchId);
    assert.equal(body.accepted, 1); // Reports as if accepted (idempotent)

    await app.close();
  });

  it('is idempotent across retry attempts: same batchId with different attempt still deduplicates', async () => {
    const app = await buildApp();

    // First submission attempt=1
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/tip-telemetry/batch',
      headers: AUTH_HEADERS,
      payload: JSON.stringify(validBatch),
    });
    assert.equal(res1.statusCode, 202);
    assert.equal(res1.json().accepted, 1);

    // Client didn't receive ACK, retries with attempt=2 — same batchId
    const retryBatch = { ...validBatch, attempt: 2 };
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/tip-telemetry/batch',
      headers: AUTH_HEADERS,
      payload: JSON.stringify(retryBatch),
    });
    assert.equal(res2.statusCode, 202);
    const body = res2.json();
    assert.equal(body.batchId, validBatch.batchId);
    assert.equal(body.accepted, 1); // Idempotent — not double-counted

    await app.close();
  });

  it('accepts multi-event batch', async () => {
    const app = await buildApp();
    const batch = {
      ...validBatch,
      batchId: 'a50e8400-e29b-41d4-a716-446655440001',
      events: [
        {
          event: 'capability_tip_exposed',
          tipId: 'tip-a',
          context: 'thinking',
          surface: 'pending_bubble',
          timestamp: 1721000000000,
        },
        {
          event: 'capability_tip_action',
          tipId: 'tip-b',
          context: 'waiting_external',
          surface: 'assistant_stream_bubble',
          actionType: 'open_concierge_draft',
          outcome: 'opened',
          timestamp: 1721000001000,
        },
        {
          event: 'capability_tip_exposed',
          tipId: 'tip-c',
          context: 'review',
          surface: 'concierge',
          outcome: 'shown',
          timestamp: 1721000002000,
        },
      ],
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/tip-telemetry/batch',
      headers: AUTH_HEADERS,
      payload: JSON.stringify(batch),
    });
    assert.equal(res.statusCode, 202);
    const body = res.json();
    assert.equal(body.accepted, 3);
    assert.equal(body.rejected, 0);
    await app.close();
  });

  it('returns 409 on payload conflict: same batchId with different events', async () => {
    const app = await buildApp();

    // First submission with original events
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/tip-telemetry/batch',
      headers: AUTH_HEADERS,
      payload: JSON.stringify(validBatch),
    });
    assert.equal(res1.statusCode, 202);

    // Same batchId but DIFFERENT events — this is a bug in the client, not a retry
    const conflictBatch = {
      ...validBatch,
      events: [
        {
          event: 'capability_tip_action',
          tipId: 'different-tip',
          context: 'review',
          surface: 'concierge',
          actionType: 'open_source',
          outcome: 'opened',
          timestamp: 1721000099000,
        },
      ],
    };
    const res2 = await app.inject({
      method: 'POST',
      url: '/api/tip-telemetry/batch',
      headers: AUTH_HEADERS,
      payload: JSON.stringify(conflictBatch),
    });
    assert.equal(res2.statusCode, 409);
    const body = res2.json();
    assert.equal(body.accepted, 0);
    assert.ok(body.rejectedReasons[0].includes('conflict'));

    await app.close();
  });

  it('returns 400 when batch envelope has extra field', async () => {
    const app = await buildApp();
    const batch = { ...validBatch, batchId: 'b50e8400-e29b-41d4-a716-446655440002', userId: 'leaked-identity' };
    const res = await app.inject({
      method: 'POST',
      url: '/api/tip-telemetry/batch',
      headers: AUTH_HEADERS,
      payload: JSON.stringify(batch),
    });
    assert.equal(res.statusCode, 400);
    await app.close();
  });

  it('rejects events older than the 7d delivery window', async () => {
    const app = await buildApp();
    const staleBatch = {
      ...validBatch,
      batchId: 'b50e8400-e29b-41d4-a716-446655440099',
      events: [{ ...validBatch.events[0], timestamp: NOW - 8 * 24 * 60 * 60 * 1000 }],
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/tip-telemetry/batch',
      headers: AUTH_HEADERS,
      payload: JSON.stringify(staleBatch),
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().rejectedReasons[0], /delivery window/);
    await app.close();
  });

  it('rejects events beyond the allowed future clock skew', async () => {
    const app = await buildApp();
    const futureBatch = {
      ...validBatch,
      batchId: 'b50e8400-e29b-41d4-a716-446655440100',
      events: [{ ...validBatch.events[0], timestamp: NOW + 10 * 60 * 1000 }],
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/tip-telemetry/batch',
      headers: AUTH_HEADERS,
      payload: JSON.stringify(futureBatch),
    });
    assert.equal(res.statusCode, 400);
    assert.match(res.json().rejectedReasons[0], /delivery window/);
    await app.close();
  });
});
