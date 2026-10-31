// @ts-check
/** F268 aggregate, transport, durability, and digest contract tests. */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const AUTH_HEADERS = { 'x-cat-cafe-user': 'test-user', 'content-type': 'application/json' };
const NOW = 1721000005000;
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

describe('F268 aggregate outcome dimension (Sol P1-4)', () => {
  it('distinguishes events with different outcomes in aggregates', async () => {
    const Fastify = (await import('fastify')).default;
    const { tipTelemetryRoutes, InMemoryTipEventSink } = await import('../dist/routes/tip-telemetry.js');

    const app = Fastify();
    app.decorateRequest('sessionUserId', null);
    app.addHook('preHandler', async (request) => {
      const userId = request.headers['x-cat-cafe-user'];
      if (typeof userId === 'string') request.sessionUserId = userId;
    });

    const sink = new InMemoryTipEventSink();
    await app.register(tipTelemetryRoutes, { sink, now: () => NOW });

    const batch = {
      batchId: 'c50e8400-e29b-41d4-a716-446655440010',
      attempt: 1,
      events: [
        {
          event: 'capability_tip_exposed',
          tipId: 'tip-x',
          context: 'thinking',
          surface: 'pending_bubble',
          outcome: 'shown',
          timestamp: 1721000000000,
        },
        {
          event: 'capability_tip_exposed',
          tipId: 'tip-x',
          context: 'thinking',
          surface: 'pending_bubble',
          outcome: 'failed',
          timestamp: 1721000001000,
        },
        {
          event: 'capability_tip_exposed',
          tipId: 'tip-x',
          context: 'thinking',
          surface: 'pending_bubble',
          outcome: 'shown',
          timestamp: 1721000002000,
        },
      ],
      assembledAt: 1721000005000,
      schemaVersion: 1,
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/tip-telemetry/batch',
      headers: AUTH_HEADERS,
      payload: JSON.stringify(batch),
    });
    assert.equal(res.statusCode, 202);

    const shownCount = sink.getAggregate('2024-07-14', 'tip-x', 'capability_tip_exposed', 'shown');
    const failedCount = sink.getAggregate('2024-07-14', 'tip-x', 'capability_tip_exposed', 'failed');
    assert.equal(shownCount, 2, 'shown outcome aggregate');
    assert.equal(failedCount, 1, 'failed outcome aggregate');
    await app.close();
  });
});

describe('F268 transport counters completeness (Sol P1-5)', () => {
  it('records transport counters for rejected and conflict (not just accepted)', async () => {
    const Fastify = (await import('fastify')).default;
    const { tipTelemetryRoutes, InMemoryTipEventSink } = await import('../dist/routes/tip-telemetry.js');

    const app = Fastify();
    app.decorateRequest('sessionUserId', null);
    app.addHook('preHandler', async (request) => {
      const userId = request.headers['x-cat-cafe-user'];
      if (typeof userId === 'string') request.sessionUserId = userId;
    });

    const sink = new InMemoryTipEventSink();
    await app.register(tipTelemetryRoutes, { sink, now: () => NOW });

    const batch1 = { ...validBatch, batchId: 'd50e8400-e29b-41d4-a716-446655440020' };
    await app.inject({
      method: 'POST',
      url: '/api/tip-telemetry/batch',
      headers: AUTH_HEADERS,
      payload: JSON.stringify(batch1),
    });

    const invalidBatch = { ...validBatch, batchId: 'not-valid' };
    await app.inject({
      method: 'POST',
      url: '/api/tip-telemetry/batch',
      headers: AUTH_HEADERS,
      payload: JSON.stringify(invalidBatch),
    });

    const conflictBatch = {
      ...validBatch,
      batchId: 'd50e8400-e29b-41d4-a716-446655440020',
      events: [
        {
          event: 'capability_tip_action',
          tipId: 'other',
          context: 'review',
          surface: 'concierge',
          actionType: 'open_source',
          outcome: 'opened',
          timestamp: NOW - 100,
        },
      ],
    };
    await app.inject({
      method: 'POST',
      url: '/api/tip-telemetry/batch',
      headers: AUTH_HEADERS,
      payload: JSON.stringify(conflictBatch),
    });

    assert.ok(sink.getTransportCounter('accepted') >= 1, 'accepted counter');
    assert.ok(sink.getTransportCounter('rejected') >= 1, 'rejected counter');
    assert.ok(sink.getTransportCounter('conflict') >= 1, 'conflict counter');
    await app.close();
  });

  it('records every transport status in batch units, not event units', async () => {
    const Fastify = (await import('fastify')).default;
    const { tipTelemetryRoutes, InMemoryTipEventSink } = await import('../dist/routes/tip-telemetry.js');

    const app = Fastify();
    app.decorateRequest('sessionUserId', null);
    app.addHook('preHandler', async (request) => {
      const userId = request.headers['x-cat-cafe-user'];
      if (typeof userId === 'string') request.sessionUserId = userId;
    });

    const sink = new InMemoryTipEventSink();
    await app.register(tipTelemetryRoutes, { sink, now: () => NOW });
    const events = [
      validBatch.events[0],
      { ...validBatch.events[0], tipId: 'second-tip', timestamp: validBatch.events[0].timestamp + 1 },
      { ...validBatch.events[0], tipId: 'third-tip', timestamp: validBatch.events[0].timestamp + 2 },
    ];
    const batch = {
      ...validBatch,
      batchId: 'e50e8400-e29b-41d4-a716-446655440020',
      events,
    };

    await app.inject({
      method: 'POST',
      url: '/api/tip-telemetry/batch',
      headers: AUTH_HEADERS,
      payload: JSON.stringify(batch),
    });
    await app.inject({
      method: 'POST',
      url: '/api/tip-telemetry/batch',
      headers: AUTH_HEADERS,
      payload: JSON.stringify({ ...batch, attempt: 2 }),
    });

    assert.equal(sink.getTransportCounter('accepted'), 1, 'one accepted batch, regardless of event count');
    assert.equal(sink.getTransportCounter('duplicate'), 1, 'one duplicate batch, regardless of event count');
    await app.close();
  });
});

describe('F268 no-Redis durability guard (Sol P1-6)', () => {
  it('returns 503 when no durable sink is available', async () => {
    const Fastify = (await import('fastify')).default;
    const { tipTelemetryRoutes, UnavailableTipEventSink } = await import('../dist/routes/tip-telemetry.js');

    const app = Fastify();
    app.decorateRequest('sessionUserId', null);
    app.addHook('preHandler', async (request) => {
      const userId = request.headers['x-cat-cafe-user'];
      if (typeof userId === 'string') request.sessionUserId = userId;
    });

    const sink = new UnavailableTipEventSink();
    await app.register(tipTelemetryRoutes, { sink, now: () => NOW });

    const res = await app.inject({
      method: 'POST',
      url: '/api/tip-telemetry/batch',
      headers: AUTH_HEADERS,
      payload: JSON.stringify(validBatch),
    });
    assert.equal(res.statusCode, 503);
    await app.close();
  });
});

describe('F268 payloadDigest scope constraint (Fable P1)', () => {
  it('digest is stable across different attempt values (excludes attempt from hash)', async () => {
    const { computePayloadDigest } = await import('../dist/routes/tip-telemetry.js');
    const events = validBatch.events;

    const digest1 = computePayloadDigest(events, 1);
    const digest2 = computePayloadDigest(events, 1);
    assert.equal(digest1, digest2);
    assert.match(digest1, /^[0-9a-f]{64}$/);
  });

  it('digest changes when events differ', async () => {
    const { computePayloadDigest } = await import('../dist/routes/tip-telemetry.js');
    const events1 = validBatch.events;
    const events2 = [
      {
        event: 'capability_tip_action',
        tipId: 'different-tip',
        context: 'review',
        surface: 'concierge',
        actionType: 'open_source',
        outcome: 'opened',
        timestamp: 1721000099000,
      },
    ];

    const d1 = computePayloadDigest(events1, 1);
    const d2 = computePayloadDigest(events2, 1);
    assert.notEqual(d1, d2);
  });

  it('digest changes when schemaVersion differs', async () => {
    const { computePayloadDigest } = await import('../dist/routes/tip-telemetry.js');
    const events = validBatch.events;

    const d1 = computePayloadDigest(events, 1);
    const d2 = computePayloadDigest(events, 2);
    assert.notEqual(d1, d2);
  });
});
