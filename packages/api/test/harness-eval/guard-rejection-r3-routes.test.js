/**
 * F257 V2 R3 route-level regression tests.
 *
 * P2-3: stats SCARD error → { available: false }
 * P2-4①: owner dual-tenant GET isolation
 * P2-4②: resolver throw → 202 + threadId=unknown
 * P2-4③: >cap pagination (10,001 → 10,000 + truncated)
 * P2-5: skip behavior (server-side skip events queryable + invalid kind rejected)
 *
 * [opus/claude-opus-4-6🐾]
 */

import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import Fastify from 'fastify';

// ---------------------------------------------------------------------------
// Helpers — shared app builder for callback-guard-rejection-routes
// ---------------------------------------------------------------------------

const T = 1700000000000;

let registry;
let threadStore;

async function setup() {
  const { InvocationRegistry } = await import(
    '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
  );
  const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
  registry = new InvocationRegistry();
  threadStore = new ThreadStore();
}

function makeFakeLog(events = []) {
  const appended = [];
  return {
    append: mock.fn(async (event) => {
      appended.push(event);
    }),
    async queryWindowComplete(opts) {
      return this.queryWindowStrictComplete(opts);
    },
    async queryWindowStrictComplete(opts) {
      const all = [...events, ...appended];
      const filtered = all.filter(
        (e) =>
          (!opts.ledgerId || e.ledgerId === opts.ledgerId) &&
          (!opts.ownerUserId || e.ownerUserId === opts.ownerUserId) &&
          e.timestamp >= opts.since &&
          e.timestamp < (opts.until ?? Number.POSITIVE_INFINITY),
      );
      return { events: filtered, truncated: false };
    },
    _appended: appended,
  };
}

async function createApp(guardRejectionLog, extra = {}) {
  const { callbacksRoutes } = await import('../../dist/routes/callbacks.js');
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore: {
      async getMessagesForThread() {
        return [];
      },
    },
    socketManager: {
      broadcastAgentMessage() {},
      getMessages() {
        return [];
      },
    },
    threadStore,
    evidenceStore: {
      async store() {},
      async search() {
        return [];
      },
    },
    markerQueue: { enqueue() {} },
    reflectionService: { async run() {} },
    holdBallDeps: {
      registry,
      taskRunner: { registerDynamic() {}, unregister() {} },
      templateRegistry: { get() {} },
      dynamicTaskStore: { insert() {}, getAll: () => [], remove: () => true },
      messageStore: { async append() {} },
      socketManager: { broadcastToRoom() {} },
      guardRejectionLog,
    },
    ...extra,
  });
  return app;
}

/**
 * Directly register guard-rejection routes (bypassing callbacksRoutes)
 * to inject deps like ledgerStats without going through Redis construction.
 */
async function createDirectRouteApp(deps) {
  const { registerCallbackGuardRejectionRoutes } = await import('../../dist/routes/callback-guard-rejection-routes.js');
  const app = Fastify();
  // Wire callback auth prehandler — the GET handler calls requireCallbackPrincipal
  app.addHook('preHandler', async (request) => {
    const invId = request.headers['x-invocation-id'];
    const token = request.headers['x-callback-token'];
    if (invId && token) {
      const result = await registry.verify(invId, token);
      if (result.ok) {
        request.callbackPrincipal = {
          kind: 'invocation',
          userId: result.record.userId,
          catId: result.record.catId,
          threadId: result.record.threadId,
          invocationId: invId,
        };
      }
    }
  });
  registerCallbackGuardRejectionRoutes(app, deps);
  return app;
}

// ---------------------------------------------------------------------------
// P2-4②: resolver throw → 202 + threadId=unknown
// ---------------------------------------------------------------------------

describe('P2-4②: resolver throw → 202 + threadId=unknown', async () => {
  await setup();

  it('ingest returns 202 even when scoped-thread resolver throws', async () => {
    const log = makeFakeLog();
    const throwingThreadStore = {
      ...threadStore,
      async getById() {
        throw new Error('READONLY: Redis failover');
      },
      async list() {
        throw new Error('READONLY: Redis failover');
      },
    };
    const app = await createApp(log, { threadStore: throwingThreadStore });
    const thread = await threadStore.create('user-r3-1', 'r3-test');
    const { invocationId, callbackToken } = await registry.create('user-r3-1', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/guard-rejections',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        kind: 'http_policy_reject',
        guardId: 'cross_post_routing_credentials',
        sourceTool: 'cross_post_message',
        normalizedReason: 'resolver_test',
        threadId: 'thread_that_will_fail_resolve',
      },
    });

    assert.equal(response.statusCode, 202, 'resolver throw must NOT 500');
    assert.equal(response.json().accepted, true);
    assert.equal(log._appended.length, 1, 'event logged despite resolver failure');
  });
});

// ---------------------------------------------------------------------------
// P2-4①: owner dual-tenant GET isolation (direct route — correct sinceMs)
// ---------------------------------------------------------------------------

describe('P2-4①: owner dual-tenant GET isolation', async () => {
  await setup();

  it('GET returns only events for the authenticated owner', async () => {
    const ownerAEvents = [
      {
        eventId: 'e-a1',
        ledgerId: 'mcp/hold-ball-rate-limit',
        ownerUserId: 'owner-A',
        threadId: 't1',
        catId: 'c1',
        guardId: 'hold_ball_rate_limit',
        kind: 'http_rate_limit',
        timestamp: T,
        correlationConfidence: 'window',
      },
      {
        eventId: 'e-a2',
        ledgerId: 'mcp/hold-ball-rate-limit',
        ownerUserId: 'owner-A',
        threadId: 't1',
        catId: 'c1',
        guardId: 'hold_ball_rate_limit',
        kind: 'http_rate_limit',
        timestamp: T + 1000,
        correlationConfidence: 'window',
      },
    ];
    const ownerBEvents = [
      {
        eventId: 'e-b1',
        ledgerId: 'mcp/hold-ball-rate-limit',
        ownerUserId: 'owner-B',
        threadId: 't2',
        catId: 'c2',
        guardId: 'hold_ball_rate_limit',
        kind: 'http_rate_limit',
        timestamp: T + 500,
        correlationConfidence: 'window',
      },
    ];
    const log = makeFakeLog([...ownerAEvents, ...ownerBEvents]);
    const app = await createDirectRouteApp({ guardRejectionLog: log });
    const thread = await threadStore.create('owner-A', 'tenant-test');
    const { invocationId, callbackToken } = await registry.create('owner-A', 'codex', thread.id);

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/guard-rejections?ledgerId=mcp/hold-ball-rate-limit&sinceMs=${T - 1000}&untilMs=${T + 5000}`,
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.events.length, 2, 'owner-A sees exactly 2 events');
    assert.ok(
      body.events.every((e) => e.ownerUserId === 'owner-A'),
      'no cross-tenant leakage',
    );
  });
});

// ---------------------------------------------------------------------------
// P2-3: stats SCARD error → { available: false } (direct route)
// ---------------------------------------------------------------------------

describe('P2-3: stats SCARD error → available: false', async () => {
  await setup();

  it('GET returns stats.available=false when SCARD throws', async () => {
    const events = [
      {
        eventId: 'e1',
        ledgerId: 'mcp/hold-ball-rate-limit',
        ownerUserId: 'user-stats',
        threadId: 't1',
        catId: 'c1',
        guardId: 'hold_ball_rate_limit',
        kind: 'http_rate_limit',
        timestamp: T,
        correlationConfidence: 'window',
      },
    ];
    const log = makeFakeLog(events);
    const failingLedgerStats = {
      async anomalyReferenceCount() {
        throw new Error('READONLY: Redis failover');
      },
    };
    const app = await createDirectRouteApp({ guardRejectionLog: log, ledgerStats: failingLedgerStats });
    const thread = await threadStore.create('user-stats', 'stats-test');
    const { invocationId, callbackToken } = await registry.create('user-stats', 'codex', thread.id);

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/guard-rejections?ledgerId=mcp/hold-ball-rate-limit&sinceMs=${T - 1000}&untilMs=${T + 5000}`,
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(response.statusCode, 200, 'events still returned — partial success');
    const body = response.json();
    assert.equal(body.events.length, 1);
    assert.equal(body.stats.available, false, 'stats degraded to available: false');
    assert.equal(body.stats.reason, 'scard_error');
  });
});

// ---------------------------------------------------------------------------
// P2-4③: >cap pagination (10,001 → 10,000 + truncated)
// ---------------------------------------------------------------------------

describe('P2-4③: >HARD_QUERY_CAP → truncated=true', async () => {
  await setup();

  it('GET returns truncated=true when event count exceeds cap', async () => {
    const capLog = {
      append: mock.fn(async () => {}),
      async queryWindowComplete(opts) {
        return this.queryWindowStrictComplete(opts);
      },
      async queryWindowStrictComplete() {
        const events = Array.from({ length: 10_000 }, (_, i) => ({
          eventId: `cap-${i}`,
          ledgerId: 'mcp/hold-ball-rate-limit',
          ownerUserId: 'user-cap',
          threadId: 't1',
          catId: 'c1',
          guardId: 'hold_ball_rate_limit',
          kind: 'http_rate_limit',
          timestamp: T + i * 1000,
          correlationConfidence: 'window',
        }));
        return { events, truncated: true };
      },
    };
    const app = await createApp(capLog);
    const thread = await threadStore.create('user-cap', 'cap-test');
    const { invocationId, callbackToken } = await registry.create('user-cap', 'codex', thread.id);

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/guard-rejections?ledgerId=mcp/hold-ball-rate-limit&sinceMs=${T}&untilMs=${T + 20_000_000}`,
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.truncated, true, 'truncated flag must reach the caller');
    assert.equal(body.events.length, 10_000);
  });
});

// ---------------------------------------------------------------------------
// P2-5: skip behavior — server-side skip events are queryable via GET,
// and invalid kinds are rejected on POST (architecture contract: skip
// events are emitted server-side, NOT through MCP client ingest)
// ---------------------------------------------------------------------------

describe('P2-5: route_decision_skip emit behavior', async () => {
  await setup();

  it('server-side skip events are queryable via GET (dedup_active positive)', async () => {
    // Skip events are appended SERVER-SIDE (routing code), not via POST.
    // Test that they appear in GET results when pre-seeded.
    const skipEvents = [
      {
        eventId: 'skip-1',
        ledgerId: 'mcp/a2a-route-decision-skip',
        ownerUserId: 'user-skip',
        threadId: 't1',
        catId: 'c1',
        guardId: 'a2a_route_decision_skip',
        kind: 'route_decision_skip',
        timestamp: T,
        correlationConfidence: 'window',
        normalizedReason: 'dedup_active',
      },
    ];
    const log = makeFakeLog(skipEvents);
    const app = await createDirectRouteApp({ guardRejectionLog: log });
    const thread = await threadStore.create('user-skip', 'skip-test');
    const { invocationId, callbackToken } = await registry.create('user-skip', 'codex', thread.id);

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/guard-rejections?ledgerId=mcp/a2a-route-decision-skip&sinceMs=${T - 1000}&untilMs=${T + 5000}`,
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.events.length, 1, 'skip event visible via GET');
    assert.equal(body.events[0].kind, 'route_decision_skip');
  });

  it('MCP POST rejects route_decision_skip kind (server-side only)', async () => {
    const log = makeFakeLog();
    const app = await createApp(log);
    const thread = await threadStore.create('user-no-mcp-skip', 'no-mcp-skip');
    const { invocationId, callbackToken } = await registry.create('user-no-mcp-skip', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/guard-rejections',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        kind: 'route_decision_skip',
        guardId: 'a2a_route_decision_skip',
        sourceTool: 'route_callback',
        normalizedReason: 'dedup_active',
      },
    });

    assert.equal(response.statusCode, 400, 'skip kind is server-side only — rejected on POST');
    assert.equal(log._appended.length, 0, 'nothing appended');
  });
});
