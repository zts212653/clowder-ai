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
 * Supports BOTH invocation and agent-key principal paths (sol R4 P2-4①).
 */
async function createDirectRouteApp(deps) {
  const { registerCallbackGuardRejectionRoutes } = await import('../../dist/routes/callback-guard-rejection-routes.js');
  const app = Fastify();
  // Wire callback auth prehandler — supports invocation + agent-key principals
  app.addHook('preHandler', async (request) => {
    // Path 1: invocation principal (x-invocation-id + x-callback-token)
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
        return;
      }
    }
    // Path 2: agent-key principal (x-test-agent-key — test-only header)
    const agentKeyHeader = request.headers['x-test-agent-key'];
    if (agentKeyHeader) {
      const record = JSON.parse(agentKeyHeader);
      request.callbackPrincipal = {
        kind: 'agent_key',
        agentKeyId: record.agentKeyId ?? 'ak-test',
        userId: record.userId,
        catId: record.catId,
        scope: record.scope ?? 'full',
      };
    }
  });
  registerCallbackGuardRejectionRoutes(app, deps);
  return app;
}

// ---------------------------------------------------------------------------
// P2-4②: resolver throw → 202 + threadId=unknown
// sol R4: must use AGENT-KEY principal (not invocation) to exercise the
// resolver branch. Production calls threadStore.get (not getById). Must
// assert threadId='unknown' in the appended event.
// ---------------------------------------------------------------------------

describe('P2-4②: agent-key resolver throw → 202 + threadId=unknown', async () => {
  await setup();

  it('agent-key POST with resolver throw → 202, event.threadId=unknown', async () => {
    const log = makeFakeLog();
    // threadStore.get is what resolveScopedThreadId calls (not getById)
    const throwingThreadStore = {
      async get() {
        throw new Error('READONLY: Redis failover');
      },
      async list() {
        throw new Error('READONLY: Redis failover');
      },
    };
    const app = await createDirectRouteApp({
      guardRejectionLog: log,
      threadStore: throwingThreadStore,
    });

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/guard-rejections',
      headers: {
        'x-test-agent-key': JSON.stringify({ userId: 'user-ak-1', catId: 'codex' }),
      },
      payload: {
        kind: 'http_policy_reject',
        guardId: 'cross_post_routing_credentials',
        sourceTool: 'cross_post_message',
        normalizedReason: 'resolver_test',
        threadId: 'thread_that_will_fail_resolve',
      },
    });

    assert.equal(response.statusCode, 202, 'resolver throw must NOT 500 the ingest');
    assert.equal(response.json().accepted, true);
    assert.equal(log._appended.length, 1, 'event logged despite resolver failure');
    // Critical assertion: threadId degrades to 'unknown' (coalescer untrusted-key isolation)
    assert.equal(log._appended[0].threadId, 'unknown', 'failed resolver → threadId=unknown');
    assert.equal(log._appended[0].correlationConfidence, 'window', 'agent-key → window confidence');
    assert.equal(log._appended[0].catId, 'codex', 'catId from principal, not payload');
    assert.equal(log._appended[0].userId || log._appended[0].ownerUserId, 'user-ak-1', 'userId from principal');
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
// P2-4③: >cap pagination via real GuardRejectionEventLog + LIMIT-aware Redis
// sol R4: must instantiate real EventLog with a Redis fake that supports
// ZRANGEBYSCORE LIMIT, insert 10,001 events, and observe HARD_QUERY_CAP
// truncation through the actual paging code path.
// ---------------------------------------------------------------------------

/**
 * Minimal Redis fake supporting ZRANGEBYSCORE with LIMIT (the paging
 * primitive GuardRejectionEventLog.fetchWindow uses). Members stored
 * sorted by score for correct range + offset semantics.
 */
function createZsetRedis() {
  const members = [];
  return {
    async zadd(_key, score, member) {
      members.push({ score: Number(score), member });
      return 1;
    },
    async zrangebyscore(_key, min, max, ...args) {
      let offset = 0;
      let count = members.length;
      for (let i = 0; i < args.length; i++) {
        if (String(args[i]).toUpperCase() === 'LIMIT') {
          offset = Number(args[i + 1]);
          count = Number(args[i + 2]);
          break;
        }
      }
      // Must be sorted by score for correct LIMIT behavior
      const sorted = [...members].sort((a, b) => a.score - b.score);
      return sorted
        .filter((m) => m.score >= Number(min) && m.score <= Number(max))
        .slice(offset, offset + count)
        .map((m) => m.member);
    },
    async zremrangebyscore() {
      return 0;
    },
  };
}

describe('P2-4③: >HARD_QUERY_CAP via real EventLog + LIMIT-aware Redis', async () => {
  await setup();

  it('real EventLog returns truncated=true when 10,001 matching events exceed cap', async () => {
    const { GuardRejectionEventLog } = await import('../../dist/infrastructure/harness-eval/GuardRejectionEventLog.js');
    const redis = createZsetRedis();
    const realLog = new GuardRejectionEventLog(redis);

    // Seed 10,001 events — exceeds HARD_QUERY_CAP (10,000)
    for (let i = 0; i < 10_001; i++) {
      await realLog.append({
        eventId: `cap-evt-${i}`,
        ledgerId: 'mcp/hold-ball-rate-limit',
        ownerUserId: 'user-cap',
        threadId: 't1',
        catId: 'c1',
        guardId: 'hold_ball_rate_limit',
        kind: 'http_rate_limit',
        timestamp: T + i * 100,
        correlationConfidence: 'window',
        invocationId: 'inv-1',
        sourceTool: 'hold_ball',
        normalizedReason: 'rate_limited',
        layer: 'api-route',
        currentCount: 5,
        maxAllowed: 5,
        windowMs: 3600000,
      });
    }

    // Query through the real EventLog's fetchWindow paging path
    const { events, truncated } = await realLog.queryWindowStrictComplete({
      since: T,
      until: T + 2_000_000,
      ownerUserId: 'user-cap',
    });

    assert.equal(truncated, true, 'HARD_QUERY_CAP reached → truncated=true');
    assert.equal(events.length, 10_000, 'exactly cap events returned');

    // Verify this surfaces through the GET route
    const app = await createDirectRouteApp({ guardRejectionLog: realLog });
    const thread = await threadStore.create('user-cap', 'cap-route-test');
    const { invocationId, callbackToken } = await registry.create('user-cap', 'codex', thread.id);

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/guard-rejections?ledgerId=mcp/hold-ball-rate-limit&sinceMs=${T}&untilMs=${T + 2_000_000}`,
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.truncated, true, 'truncated flag reaches the HTTP caller');
    assert.equal(body.events.length, 10_000, 'route-level cap enforcement');
  });
});

// ---------------------------------------------------------------------------
// P2-5: skip kind ingest guard + ledgerId trust boundary
// Architecture contract: route_decision_skip is emitted SERVER-SIDE only
// (route-serial.ts:3107,3326 via guardRejectionLog.append). The MCP POST
// schema rejects it. Full emit-path coverage lives in route-serial
// integration tests (route-serial-routing-guard-remedial.test.js).
// ---------------------------------------------------------------------------

describe('P2-5: route_decision_skip kind guard', async () => {
  await setup();

  it('MCP POST rejects route_decision_skip kind (Zod enum guard)', async () => {
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
    assert.ok(response.json().issues[0].includes('kind'), 'error surfaces the field name');
    assert.equal(log._appended.length, 0, 'nothing appended');
  });

  it('MCP POST accepts valid MCP kinds (positive counterexample)', async () => {
    const log = makeFakeLog();
    const app = await createApp(log);
    const thread = await threadStore.create('user-valid-kind', 'valid-kind');
    const { invocationId, callbackToken } = await registry.create('user-valid-kind', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/guard-rejections',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        kind: 'http_policy_reject',
        guardId: 'cross_post_routing_credentials',
        sourceTool: 'cross_post_message',
        normalizedReason: 'missing_credentials',
      },
    });

    assert.equal(response.statusCode, 202, 'valid MCP kind accepted');
    assert.equal(log._appended.length, 1, 'event appended');
  });
});

// ---------------------------------------------------------------------------
// P2-1 (sol R4): GET rejects unregistered ledgerId at API boundary
// ---------------------------------------------------------------------------

describe('P2-1: GET rejects unregistered ledgerId', async () => {
  await setup();

  it('returns 400 for spoofed ledgerId', async () => {
    const log = makeFakeLog();
    const app = await createDirectRouteApp({ guardRejectionLog: log });
    const thread = await threadStore.create('user-spoof', 'spoof-test');
    const { invocationId, callbackToken } = await registry.create('user-spoof', 'codex', thread.id);

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/guard-rejections?ledgerId=evil/fake-pot&sinceMs=${T}&untilMs=${T + 5000}`,
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(response.statusCode, 400, 'unregistered ledgerId → 400');
    assert.ok(response.json().error.includes('unregistered'), 'error message names the issue');
    assert.ok(Array.isArray(response.json().registered), 'response includes valid options');
  });

  it('returns 400 for prototype-like ledgerId', async () => {
    const log = makeFakeLog();
    const app = await createDirectRouteApp({ guardRejectionLog: log });
    const thread = await threadStore.create('user-proto', 'proto-test');
    const { invocationId, callbackToken } = await registry.create('user-proto', 'codex', thread.id);

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/guard-rejections?ledgerId=toString&sinceMs=${T}&untilMs=${T + 5000}`,
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(response.statusCode, 400, 'prototype key → 400');
  });

  it('returns 200 for registered ledgerId', async () => {
    const log = makeFakeLog();
    const app = await createDirectRouteApp({ guardRejectionLog: log });
    const thread = await threadStore.create('user-valid-ledger', 'valid-test');
    const { invocationId, callbackToken } = await registry.create('user-valid-ledger', 'codex', thread.id);

    const response = await app.inject({
      method: 'GET',
      url: `/api/callbacks/guard-rejections?ledgerId=mcp/hold-ball-rate-limit&sinceMs=${T}&untilMs=${T + 5000}`,
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });

    assert.equal(response.statusCode, 200, 'registered ledgerId → 200');
  });
});
