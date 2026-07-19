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
      _appended: appended,
    };
  }

  async function createApp(guardRejectionLog) {
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
