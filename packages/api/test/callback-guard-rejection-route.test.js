/**
 * F257 V2/Phase B — MCP client-layer guard rejection ingest tests (AC-B1).
 *
 * Trust-boundary contract under test:
 * - identity (catId/threadId/invocationId) comes from the auth record, NEVER
 *   from the payload — spoofed payload identity fields must be ignored
 * - guardId is whitelisted against the ledger registry (fail-closed)
 * - eventId/timestamp are server-generated; layer='mcp-client';
 *   correlationConfidence='exact' (auth-token-bound invocationId)
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, mock, test } from 'node:test';
import Fastify from 'fastify';

describe('F257 V2: /api/callbacks/guard-rejections ingest', () => {
  let registry;
  let threadStore;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    registry = new InvocationRegistry();
    threadStore = new ThreadStore();
  });

  function makeFakeLog() {
    const appended = [];
    return {
      append: mock.fn(async (event) => {
        appended.push(event);
      }),
      // In-memory ledgerId query — mirrors fetchWindow filter semantics so the
      // POST → GET e2e loop closes without Redis.
      async queryWindowComplete(opts) {
        return this.queryWindowStrictComplete(opts);
      },
      async queryWindowStrictComplete(opts) {
        const events = appended.filter(
          (e) =>
            (!opts.ledgerId || e.ledgerId === opts.ledgerId) &&
            (!opts.ownerUserId || e.ownerUserId === opts.ownerUserId) &&
            e.timestamp >= opts.since &&
            e.timestamp < (opts.until ?? Number.POSITIVE_INFINITY),
        );
        return { events, truncated: false };
      },
      _appended: appended,
    };
  }

  async function createApp(guardRejectionLog, extra = {}) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
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

  test('401 when callback auth headers are missing', async () => {
    const log = makeFakeLog();
    const app = await createApp(log);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/guard-rejections',
      payload: {
        kind: 'http_policy_reject',
        guardId: 'cross_post_routing_credentials',
        sourceTool: 'cross_post_message',
        normalizedReason: 'no_routing_credentials',
      },
    });
    assert.equal(response.statusCode, 401);
    assert.equal(log._appended.length, 0, 'nothing appended without auth');
  });

  test('400 on invalid kind (not an MCP-producible kind)', async () => {
    const log = makeFakeLog();
    const app = await createApp(log);
    const thread = await threadStore.create('user-gr-1', 'gr1');
    const { invocationId, callbackToken } = await registry.create('user-gr-1', 'codex', thread.id);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/guard-rejections',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        kind: 'http_rate_limit', // server-side kind, not MCP-local
        guardId: 'cross_post_routing_credentials',
        sourceTool: 'cross_post_message',
        normalizedReason: 'no_routing_credentials',
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(log._appended.length, 0);
  });

  test('sol P1-3 regression: prototype-chain guardIds are rejected (toString/constructor/__proto__)', async () => {
    const log = makeFakeLog();
    const app = await createApp(log);
    const thread = await threadStore.create('user-gr-proto', 'grproto');
    const { invocationId, callbackToken } = await registry.create('user-gr-proto', 'codex', thread.id);

    for (const protoKey of ['toString', 'constructor', '__proto__']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/guard-rejections',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: {
          kind: 'http_policy_reject',
          guardId: protoKey,
          sourceTool: 'x',
          normalizedReason: 'y',
        },
      });
      assert.equal(response.statusCode, 400, `prototype key '${protoKey}' must be rejected (was 202 pre-fix)`);
    }
    assert.equal(log._appended.length, 0, 'no prototype-key event may reach the ledger');
  });

  test('sol P1-1 regression: agent-key principal is accepted; payload thread verified via scoped resolver', async () => {
    const log = makeFakeLog();
    // Fake agent-key registry: secret 'ak-good' → cat 'antigravity' owned by user-ak.
    const agentKeyRegistry = {
      async verify(secret) {
        if (secret !== 'ak-good') return { ok: false, reason: 'unknown_key' };
        return { ok: true, record: { agentKeyId: 'ak-1', userId: 'user-ak', catId: 'antigravity' } };
      },
    };
    const app = await createApp(log, { agentKeyRegistry });
    const ownThread = await threadStore.create('user-ak', 'ak-own');
    const foreignThread = await threadStore.create('user-other', 'ak-foreign');

    // Own thread coordinate → verified and attributed.
    const ok = await app.inject({
      method: 'POST',
      url: '/api/callbacks/guard-rejections',
      headers: { 'x-agent-key-secret': 'ak-good' },
      payload: {
        kind: 'http_policy_reject',
        guardId: 'cross_post_routing_credentials',
        sourceTool: 'cross_post_message',
        normalizedReason: 'no_routing_credentials',
        threadId: ownThread.id,
      },
    });
    assert.equal(ok.statusCode, 202, 'agent-key principal must be accepted (was 401 pre-fix)');
    assert.equal(log._appended.length, 1);
    assert.equal(log._appended[0].catId, 'antigravity');
    assert.equal(log._appended[0].threadId, ownThread.id, 'verified own thread attributed');
    assert.equal(log._appended[0].invocationId, 'unknown', 'agent-key has no invocation binding');
    assert.equal(log._appended[0].correlationConfidence, 'window');

    // Foreign thread coordinate → degrades to unknown, never attributed.
    const foreign = await app.inject({
      method: 'POST',
      url: '/api/callbacks/guard-rejections',
      headers: { 'x-agent-key-secret': 'ak-good' },
      payload: {
        kind: 'http_policy_reject',
        guardId: 'cross_post_routing_credentials',
        sourceTool: 'cross_post_message',
        normalizedReason: 'no_routing_credentials',
        threadId: foreignThread.id,
      },
    });
    assert.equal(foreign.statusCode, 202, 'observation is kept even when thread verification fails');
    assert.equal(
      log._appended[1].threadId,
      'unknown',
      'foreign thread must NOT be attributed (scoped resolver denied)',
    );
  });

  test('sol P1-4 e2e: rejection-response ledgerId queries back both events + stats with how_counted', async () => {
    const log = makeFakeLog();
    const fakeStatsRedis = {
      sets: new Map(),
      async sadd(key, member) {
        const s = this.sets.get(key) ?? new Set();
        s.add(member);
        this.sets.set(key, s);
        return 1;
      },
      async scard(key) {
        return this.sets.get(key)?.size ?? 0;
      },
      // callbacks.ts constructs GuardLedgerStats from opts.redis — provide both ops.
    };
    const app = await createApp(log, { redis: fakeStatsRedis });
    const thread = await threadStore.create('user-gr-q', 'grq');
    const { invocationId, callbackToken } = await registry.create('user-gr-q', 'codex', thread.id);

    // Ingest an MCP-local reject → response hands us the ledgerId.
    const post = await app.inject({
      method: 'POST',
      url: '/api/callbacks/guard-rejections',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        kind: 'http_policy_reject',
        guardId: 'cross_post_routing_credentials',
        sourceTool: 'cross_post_message',
        normalizedReason: 'no_routing_credentials',
      },
    });
    assert.equal(post.statusCode, 202);
    const { ledgerId } = JSON.parse(post.body);

    // A same-pot API-route event already in the ledger (spec acceptance shape:
    // "one 429-style route event + one MCP reject → query by ledger id → both").
    await log.append({
      eventId: 'evt-route-1',
      ledgerId,
      kind: 'http_policy_reject',
      threadId: thread.id,
      catId: 'codex',
      guardId: 'cross_post_routing_credentials',
      ownerUserId: 'user-gr-q',
      invocationId: 'unknown',
      sourceTool: 'cross_post_message',
      normalizedReason: 'no_routing_credentials',
      layer: 'api-route',
      timestamp: Date.now(),
      correlationConfidence: 'window',
    });

    // Stats: one anomaly reference recorded for this pot.
    fakeStatsRedis.sets.set(`guard-ledger:stats:user-gr-q:${ledgerId}:anomaly-refs`, new Set(['dev-1']));

    const get = await app.inject({
      method: 'GET',
      url: `/api/callbacks/guard-rejections?ledgerId=${encodeURIComponent(ledgerId)}`,
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
    });
    assert.equal(get.statusCode, 200);
    const body = JSON.parse(get.body);
    assert.equal(body.ledgerId, ledgerId);
    assert.equal(body.events.length, 2, 'query by ledgerId returns BOTH layers (mcp-client + api-route)');
    assert.deepEqual(new Set(body.events.map((e) => e.layer)), new Set(['mcp-client', 'api-route']));
    assert.equal(body.stats.anomalyRefCount, 1, 'AC-B2 stats exposed on the query surface');
    assert.ok(body.stats.howCounted.includes('scard'), 'how_counted travels with the stat');
    assert.equal(body.truncated, false);
  });

  test('sol P1-2 e2e: anomaly report referencing a ledgerId writes pot stats through the ROUTE', async () => {
    const log = makeFakeLog();
    const fakeStatsRedis = {
      sets: new Map(),
      async sadd(key, member) {
        const s = this.sets.get(key) ?? new Set();
        s.add(member);
        this.sets.set(key, s);
        return 1;
      },
      async scard(key) {
        return this.sets.get(key)?.size ?? 0;
      },
    };
    const anchorMsg = { id: 'm-anchor-1', threadId: 'thread-rep', userId: 'user-rep' };
    const fakeDeviationLog = {
      async append(event) {
        return { outcome: 'appended', eventId: event.eventId };
      },
      async query() {
        return { events: [], nextCursor: null, missingBodies: [] };
      },
    };
    const app = await createApp(log, {
      redis: fakeStatsRedis,
      deviationEventLog: fakeDeviationLog,
      messageStore: {
        async getMessagesForThread() {
          return [];
        },
        async getById(id) {
          return id === anchorMsg.id ? anchorMsg : null;
        },
      },
    });
    const thread = await threadStore.create('user-rep', 'rep1');
    const { invocationId, callbackToken } = await registry.create('user-rep', 'codex', thread.id);

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/harness-signals/report',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        subjectCatId: 'codex',
        source: 'self',
        note: 'hit 429 twice; rejection carried ledger mcp/hold-ball-rate-limit — reporting per F257 V2',
        sourceAnchor: { kind: 'thread_message', messageId: anchorMsg.id },
        attributions: [
          { objectiveId: 'obj-routing-delivery', unitRefs: [{ unitType: 'segment', unitId: 'S1' }], weight: 1 },
        ],
      },
    });
    assert.equal(response.statusCode, 200, `report route must succeed, got ${response.body}`);

    // sol P1-2: pre-fix this returned 200 with statsWrites=0 (route adapter
    // dropped ledgerStats). Now the write side records the reference.
    const statsKey = 'guard-ledger:stats:user-rep:mcp/hold-ball-rate-limit:anomaly-refs';
    const statsSet = fakeStatsRedis.sets.get(statsKey);
    assert.ok(statsSet && statsSet.size === 1, `stats must be written through the route (got ${statsSet?.size ?? 0})`);
  });

  test('400 on unregistered guardId (fail-closed whitelist)', async () => {
    const log = makeFakeLog();
    const app = await createApp(log);
    const thread = await threadStore.create('user-gr-2', 'gr2');
    const { invocationId, callbackToken } = await registry.create('user-gr-2', 'codex', thread.id);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/guard-rejections',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        kind: 'http_policy_reject',
        guardId: 'made_up_guard',
        sourceTool: 'whatever',
        normalizedReason: 'whatever',
      },
    });
    assert.equal(response.statusCode, 400);
    const body = JSON.parse(response.body);
    assert.ok(body.error.includes('unregistered guardId'), 'error names the whitelist failure');
    assert.equal(log._appended.length, 0, 'unregistered guard must not enter the ledger');
  });

  test('202: identity comes from auth record, spoofed payload identity ignored, octet complete', async () => {
    const log = makeFakeLog();
    const app = await createApp(log);
    const thread = await threadStore.create('user-gr-3', 'gr3');
    const { invocationId, callbackToken } = await registry.create('user-gr-3', 'codex', thread.id);
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/guard-rejections',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        kind: 'http_policy_reject',
        guardId: 'cross_post_routing_credentials',
        sourceTool: 'cross_post_message',
        normalizedReason: 'no_routing_credentials',
        // Spoof attempts — schema strips unknown fields; identity must come
        // from the auth record (V1 three-axis provenance discipline).
        catId: 'evil-cat',
        threadId: 'evil-thread',
        invocationId: 'evil-invocation',
        timestamp: 1,
      },
    });
    assert.equal(response.statusCode, 202);
    const body = JSON.parse(response.body);
    assert.equal(body.accepted, true);
    assert.equal(body.ledgerId, 'mcp/cross-post-routing-credentials', 'response carries the pot coordinate');

    assert.equal(log._appended.length, 1);
    const event = log._appended[0];
    assert.equal(event.catId, 'codex', 'catId from auth record, not payload');
    assert.equal(event.threadId, thread.id, 'threadId from auth record, not payload');
    assert.equal(event.invocationId, invocationId, 'invocationId from auth record, not payload');
    assert.notEqual(event.timestamp, 1, 'timestamp server-generated');
    assert.equal(event.kind, 'http_policy_reject');
    assert.equal(event.guardId, 'cross_post_routing_credentials');
    assert.equal(event.ledgerId, 'mcp/cross-post-routing-credentials');
    assert.equal(event.sourceTool, 'cross_post_message');
    assert.equal(event.normalizedReason, 'no_routing_credentials');
    assert.equal(event.layer, 'mcp-client');
    assert.equal(event.correlationConfidence, 'exact', 'auth-bound invocationId → exact');
    assert.ok(event.eventId, 'server-generated eventId present');
    assert.equal(body.eventId, event.eventId, 'response eventId matches appended event');
  });
});
