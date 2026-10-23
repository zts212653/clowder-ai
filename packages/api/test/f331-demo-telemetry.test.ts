import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CapabilityTipUsageEventSchema } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InMemoryTipEventSink, tipTelemetryRoutes } from '../src/routes/tip-telemetry.js';

test('F331 demo observations survive the F268 contract and reject content fields', () => {
  const event = {
    event: 'capability_tip_demo_completed',
    tipId: 'capability-propose-thread',
    context: 'thinking',
    surface: 'pending_bubble',
    outcome: 'shown',
    timestamp: Date.now(),
  };
  assert.equal(CapabilityTipUsageEventSchema.safeParse(event).success, true);
  assert.equal(CapabilityTipUsageEventSchema.safeParse({ ...event, prompt: 'private' }).success, false);
});

test('F331 query is authenticated, reports real counts, null for no samples and unavailable storage honestly', async () => {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    if (request.headers['x-test-user']) Object.assign(request, { sessionUserId: 'test-owner' });
  });
  const now = Date.UTC(2026, 9, 22, 12);
  const counts = [
    ['capability_tip_demo_exposed', 10],
    ['capability_tip_demo_opened', 4],
    ['capability_tip_demo_started', 3],
    ['capability_tip_demo_completed', 2],
    ['capability_tip_demo_tried', 2],
    ['capability_tip_demo_used', 1],
  ];
  await app.register(tipTelemetryRoutes, {
    sink: new InMemoryTipEventSink(),
    now: () => now,
    readUsage: async () => ({
      rows: counts.map(([event, count]) => ({
        date: '2026-10-22',
        tipId: 'capability-propose-thread',
        event,
        outcome: 'shown',
        count,
      })),
    }),
  });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/tip-telemetry/demos' })).statusCode, 401);
    const response = await app.inject({
      method: 'GET',
      url: '/api/tip-telemetry/demos',
      headers: { 'x-test-user': 'yes' },
    });
    assert.equal(response.statusCode, 200);
    const result = response.json();
    assert.equal(result.status, 'observed');
    assert.equal(result.demos[0].watchRate, 0.4);
    assert.equal(result.demos[0].completionRate, 0.5);
    assert.equal(result.demos[0].useAfterCompletionRate, 0.5);
    counts.length = 0;
    const empty = (
      await app.inject({ method: 'GET', url: '/api/tip-telemetry/demos', headers: { 'x-test-user': 'yes' } })
    ).json();
    assert.equal(empty.status, 'no_data');
    assert.equal(empty.demos[0].watchRate, null);
    assert.equal(empty.demos[0].useAfterCompletionRate, null);
    assert.equal(
      (await app.inject({ method: 'GET', url: '/api/tip-telemetry/demos?days=999', headers: { 'x-test-user': 'yes' } }))
        .statusCode,
      400,
    );
  } finally {
    await app.close();
  }
});

test('F331 query reports unavailable storage as 503 rather than inventing an empty sample', async () => {
  const app = Fastify();
  app.addHook('preHandler', async (request) => {
    Object.assign(request, { sessionUserId: 'test-owner' });
  });
  await app.register(tipTelemetryRoutes, {
    sink: new InMemoryTipEventSink(),
    readUsage: async () => {
      throw new Error('offline');
    },
  });
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/tip-telemetry/demos' })).statusCode, 503);
  } finally {
    await app.close();
  }
});
