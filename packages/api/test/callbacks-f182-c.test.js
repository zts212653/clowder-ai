/**
 * F182 Phase C — MCP tool routing degradation tests
 *
 * Covers:
 *  AC-C1: A class soft degradation (post_message routing_warnings + KD-7 message)
 *  AC-C2: A' class hard fail (multi_mention) + B class hard fail (create_task, start_vote)
 *  AC-C3: KD-6 wrapper prefix format (covered in mcp-server/test/callback-tools.test.js)
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';

function createMockSocketManager() {
  const messages = [];
  const roomEvents = [];
  return {
    broadcastAgentMessage(msg) {
      messages.push(msg);
    },
    broadcastToRoom(room, event, data) {
      roomEvents.push({ room, event, data });
    },
    emitToUser() {},
    getMessages() {
      return messages;
    },
    getRoomEvents() {
      return roomEvents;
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// A class: post_message soft degradation
// ─────────────────────────────────────────────────────────────────────────────

describe('F182 C1 - A class: post_message routing_warnings (soft degradation)', () => {
  let registry;
  let messageStore;
  let threadStore;
  let taskStore;
  let socketManager;
  let app;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    taskStore = new TaskStore();
    socketManager = createMockSocketManager();

    app = Fastify({ logger: false });
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      taskStore,
      evidenceStore: {
        search: async () => [],
        health: async () => true,
        initialize: async () => {},
        upsert: async () => {},
        deleteByAnchor: async () => {},
        getByAnchor: async () => null,
      },
      reflectionService: { reflect: async () => '' },
      markerQueue: { submit: async () => ({}), list: async () => [], transition: async () => {} },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  test('C1-a: disabled explicit target includes routing_warnings in 200 response', async () => {
    const thread = threadStore.create('u1', 'test');
    const { invocationId, callbackToken } = await registry.create('u1', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { content: 'hello', targetCats: ['antigravity'] },
    });

    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.ok(body.routing_warnings, 'should have routing_warnings field');
    assert.ok(Array.isArray(body.routing_warnings), 'routing_warnings should be array');
    assert.ok(body.routing_warnings.length > 0, 'should have at least one warning');
    assert.equal(body.routing_warnings[0].kind, 'cat_disabled');
    assert.equal(body.routing_warnings[0].catId, 'antigravity');
    assert.ok(Array.isArray(body.routing_warnings[0].alternatives));
  });

  test('C1-b: KD-7 — response always has message field', async () => {
    const thread = threadStore.create('u1', 'test');
    const { invocationId, callbackToken } = await registry.create('u1', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { content: 'hello', targetCats: ['antigravity'] },
    });

    const body = JSON.parse(res.body);
    assert.ok(
      typeof body.message === 'string' && body.message.length > 0,
      'response must have non-empty message field (KD-7)',
    );
    assert.ok(
      body.message.includes('antigravity') || body.message.includes('停用'),
      'message should mention the disabled cat',
    );
  });

  test('C1-c: all explicit targets disabled → isError:true + routed:[]', async () => {
    const thread = threadStore.create('u1', 'test');
    const { invocationId, callbackToken } = await registry.create('u1', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { content: 'hello', targetCats: ['antigravity'] },
    });

    const body = JSON.parse(res.body);
    assert.equal(body.isError, true, 'isError should be true when all explicit targets disabled');
    assert.deepEqual(body.routed, [], 'routed should be empty array');
  });

  test('C1-d: message is still stored even when all explicit targets disabled', async () => {
    const thread = threadStore.create('u1', 'test');
    const { invocationId, callbackToken } = await registry.create('u1', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { content: 'hello stored', targetCats: ['antigravity'] },
    });

    const body = JSON.parse(res.body);
    assert.ok(body.messageId, 'messageId should be returned even when routing failed (message was stored)');
  });

  test('C1-e: unknown catId still gets routing_warnings (cat_not_found)', async () => {
    const thread = threadStore.create('u1', 'test');
    const { invocationId, callbackToken } = await registry.create('u1', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { content: 'hello', targetCats: ['xyzunknown9999'] },
    });

    const body = JSON.parse(res.body);
    assert.ok(body.routing_warnings?.length > 0, 'should have routing_warnings for unknown cat');
    assert.equal(body.routing_warnings[0].kind, 'cat_not_found');
  });

  test('C1-f: valid target has no routing_warnings', async () => {
    const thread = threadStore.create('u1', 'test');
    const { invocationId, callbackToken } = await registry.create('u1', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { content: 'hello', targetCats: ['codex'] },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.routing_warnings?.length ?? 0, 0, 'no routing_warnings for available cat');
    assert.ok(typeof body.message === 'string', 'message field always present');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B class: create_task ownerCatId validation
// ─────────────────────────────────────────────────────────────────────────────

describe('F182 C2 - B class: create_task disabled ownerCatId → 400', () => {
  let registry;
  let messageStore;
  let threadStore;
  let taskStore;
  let socketManager;
  let app;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    taskStore = new TaskStore();
    socketManager = createMockSocketManager();

    app = Fastify({ logger: false });
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      taskStore,
      evidenceStore: {
        search: async () => [],
        health: async () => true,
        initialize: async () => {},
        upsert: async () => {},
        deleteByAnchor: async () => {},
        getByAnchor: async () => null,
      },
      reflectionService: { reflect: async () => '' },
      markerQueue: { submit: async () => ({}), list: async () => [], transition: async () => {} },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  test('C2-a: disabled ownerCatId returns 400 cat_disabled', async () => {
    const { invocationId, callbackToken } = await registry.create('u1', 'opus');

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-task',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { title: 'Fix bug', ownerCatId: 'antigravity' },
    });

    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.kind, 'cat_disabled', `expected cat_disabled, got: ${JSON.stringify(body)}`);
    assert.equal(body.catId, 'antigravity');
    assert.ok(Array.isArray(body.alternatives));
  });

  test('C2-b: available ownerCatId still creates task', async () => {
    const { invocationId, callbackToken } = await registry.create('u1', 'opus');

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-task',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { title: 'Fix bug', ownerCatId: 'codex' },
    });

    assert.equal(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.task.ownerCatId, 'codex');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B class: start_vote voter validation
// ─────────────────────────────────────────────────────────────────────────────

describe('F182 C2 - B class: start_vote disabled voter → 400', () => {
  let registry;
  let messageStore;
  let threadStore;
  let socketManager;
  let app;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    socketManager = createMockSocketManager();

    app = Fastify({ logger: false });
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      evidenceStore: {
        search: async () => [],
        health: async () => true,
        initialize: async () => {},
        upsert: async () => {},
        deleteByAnchor: async () => {},
        getByAnchor: async () => null,
      },
      reflectionService: { reflect: async () => '' },
      markerQueue: { submit: async () => ({}), list: async () => [], transition: async () => {} },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  test('C2-c: disabled voter returns 400 cat_disabled', async () => {
    const thread = threadStore.create('u1', 'test');
    const { invocationId, callbackToken } = await registry.create('u1', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/start-vote',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        question: 'Test vote?',
        options: ['Yes', 'No'],
        voters: ['antigravity'],
      },
    });

    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.kind, 'cat_disabled', `expected cat_disabled, got: ${JSON.stringify(body)}`);
    assert.equal(body.catId, 'antigravity');
  });

  test('C2-d: unknown voter returns 400 cat_not_found', async () => {
    const thread = threadStore.create('u1', 'test');
    const { invocationId, callbackToken } = await registry.create('u1', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/start-vote',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        question: 'Test vote?',
        options: ['Yes', 'No'],
        voters: ['xyzunknown9999'],
      },
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.kind, 'cat_not_found');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// A' class: multi_mention disabled target
// ─────────────────────────────────────────────────────────────────────────────

describe("F182 C2 - A' class: multi_mention disabled target → 400", () => {
  let mockRegistry;
  let mockSocket;
  let mockMessageStore;
  let mockInvocationRecordStore;
  let mockRouter;
  let app;
  let creds;

  beforeEach(async () => {
    const { resetMultiMentionOrchestrator } = await import('../dist/routes/callback-multi-mention-routes.js');
    resetMultiMentionOrchestrator();

    // Simple mock registry (follows multi-mention-routes.test.js pattern)
    const records = new Map();
    mockRegistry = {
      register(catId, threadId, userId) {
        const id = `inv-${records.size}`;
        const token = `tok-${records.size}`;
        records.set(id, { catId, threadId, userId, invocationId: id, callbackToken: token });
        return { invocationId: id, callbackToken: token };
      },
      async verify(invocationId, callbackToken) {
        const r = records.get(invocationId);
        if (!r) return { ok: false, reason: 'unknown_invocation' };
        if (r.callbackToken !== callbackToken) return { ok: false, reason: 'invalid_token' };
        return { ok: true, record: r };
      },
      isLatest() {
        return true;
      },
      claimClientMessageId() {
        return true;
      },
    };

    mockSocket = createMockSocketManager();
    mockMessageStore = { append: async (m) => ({ id: 'msg-0', ...m }), getById: async () => null };
    mockInvocationRecordStore = {
      create: async () => null,
      get: async () => null,
      update: async () => null,
      list: async () => [],
    };
    mockRouter = {
      async *routeExecution() {
        yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
      },
    };

    creds = mockRegistry.register('opus', 'thread-1', 'user-1');

    const { registerCallbackAuthHook } = await import('../dist/routes/callback-auth-prehandler.js');
    const { registerMultiMentionRoutes } = await import('../dist/routes/callback-multi-mention-routes.js');

    app = Fastify({ logger: false });
    registerCallbackAuthHook(app, mockRegistry);
    registerMultiMentionRoutes(app, {
      messageStore: mockMessageStore,
      socketManager: mockSocket,
      router: mockRouter,
      invocationRecordStore: mockInvocationRecordStore,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  test('C2-e: disabled target returns 400 cat_disabled', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['antigravity'],
        question: 'What do you think?',
        callbackTo: 'opus',
        overrideReason: 'test',
      },
    });

    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.kind, 'cat_disabled', `expected cat_disabled, got: ${JSON.stringify(body)}`);
    assert.equal(body.catId, 'antigravity');
    assert.ok(Array.isArray(body.alternatives));
  });

  test('C2-f: disabled callbackTo returns 400 cat_disabled', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'What do you think?',
        callbackTo: 'antigravity',
        overrideReason: 'test',
      },
    });

    assert.equal(res.statusCode, 400, `expected 400, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.kind, 'cat_disabled');
  });

  test('C2-g: available targets proceed normally', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'What do you think?',
        callbackTo: 'opus',
        overrideReason: 'test',
      },
    });

    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// P2-1: Store resolved catId (not raw @mention) after resolver validation
// ─────────────────────────────────────────────────────────────────────────────

describe('F182 P2-1 — store resolved catId not raw @mention', () => {
  let registry;
  let messageStore;
  let threadStore;
  let taskStore;
  let socketManager;
  let app;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { TaskStore } = await import('../dist/domains/cats/services/stores/ports/TaskStore.js');
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    taskStore = new TaskStore();
    socketManager = createMockSocketManager();

    app = Fastify({ logger: false });
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      threadStore,
      taskStore,
      evidenceStore: {
        search: async () => [],
        health: async () => true,
        initialize: async () => {},
        upsert: async () => {},
        deleteByAnchor: async () => {},
        getByAnchor: async () => null,
      },
      reflectionService: { reflect: async () => '' },
      markerQueue: { submit: async () => ({}), list: async () => [], transition: async () => {} },
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  test('P2-1a: create_task ownerCatId stores canonical catId when @mention format sent', async () => {
    const { invocationId, callbackToken } = await registry.create('u1', 'opus');

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/create-task',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { title: 'Test task', ownerCatId: '@codex' },
    });

    assert.equal(res.statusCode, 201, `expected 201, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.task.ownerCatId, 'codex', 'ownerCatId must be canonical catId (no @-prefix)');
  });

  test('P2-1b: start_vote voters stores canonical catIds when @mention format sent', async () => {
    const thread = threadStore.create('u1', 'test');
    const { invocationId, callbackToken } = await registry.create('u1', 'opus', thread.id);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/start-vote',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { question: 'Test?', options: ['A', 'B'], voters: ['@codex'] },
    });

    assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.ok(body.votingState.voters.includes('codex'), 'voters must include canonical catId');
    assert.ok(!body.votingState.voters.some((v) => v.startsWith('@')), 'voters must NOT have @-prefix');
  });
});
