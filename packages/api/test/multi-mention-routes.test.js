/**
 * Multi-Mention Callback Route Tests (F086 M1)
 *
 * Tests POST /api/callbacks/multi-mention and GET /api/callbacks/multi-mention-status
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { resetMultiMentionOrchestrator } from '../dist/routes/callback-multi-mention-routes.js';
import { canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

// ── Mocks ──────────────────────────────────────────────────────────────

function createMockRegistry() {
  const records = new Map();
  return {
    register(catId, threadId, userId, parentInvocationId) {
      const id = `inv-${records.size}`;
      const token = `tok-${records.size}`;
      records.set(id, {
        catId,
        threadId,
        userId,
        invocationId: id,
        callbackToken: token,
        ownerAuthProvenance: 'strict',
        ...(parentInvocationId ? { parentInvocationId } : {}),
      });
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
}

function createMockSocketManager() {
  const messages = [];
  const roomEvents = [];
  return {
    broadcastAgentMessage(msg, threadId) {
      messages.push({ ...msg, threadId });
    },
    broadcastToRoom(room, event, data) {
      roomEvents.push({ room, event, data });
    },
    getMessages() {
      return messages;
    },
    getRoomEvents() {
      return roomEvents;
    },
  };
}

function createMockMessageStore() {
  const messages = [];
  return {
    append(msg) {
      const stored = { id: `msg-${messages.length}`, ...msg };
      messages.push(stored);
      return stored;
    },
    getById: (id) => messages.find((m) => m.id === id) ?? null,
    getMessages() {
      return messages;
    },
  };
}

function createMockInvocationRecordStore() {
  let counter = 0;
  const created = [];
  const updates = [];
  const records = new Map();
  return {
    create(input) {
      const id = `inv-mm-${counter++}`;
      created.push({ id, ...input });
      records.set(id, {
        id,
        status: 'queued',
        ...input,
      });
      return { outcome: 'created', invocationId: id };
    },
    update(id, data) {
      updates.push({ id, data: { ...data } });
      const existing = records.get(id) ?? { id };
      const next = { ...existing, ...data };
      records.set(id, next);
      return next;
    },
    getCreated() {
      return created;
    },
    getUpdates() {
      return updates;
    },
    getRecord(id) {
      return records.get(id);
    },
  };
}

function createMockInvocationTracker() {
  const starts = [];
  const completes = [];
  const slotCompletes = [];
  const allCompletes = [];
  return {
    start(threadId, catId, userId, catIds) {
      const controller = new AbortController();
      starts.push({ threadId, catId, userId, catIds, controller });
      return controller;
    },
    complete(threadId, catId, controller) {
      completes.push({ threadId, catId, controller });
    },
    completeSlot(threadId, catId, controller) {
      slotCompletes.push({ threadId, catId, controller });
    },
    completeAll(threadId, catIds, controller) {
      allCompletes.push({ threadId, catIds: [...catIds], controller });
    },
    trackExternalSlot() {
      return true;
    },
    getStarts() {
      return starts;
    },
    getCompletes() {
      return completes;
    },
    getSlotCompletes() {
      return slotCompletes;
    },
    getAllCompletes() {
      return allCompletes;
    },
  };
}

function createMockRouter(responses = {}) {
  const executions = [];
  return {
    async *routeExecution(userId, message, threadId, _invId, targetCats, _intent, _opts) {
      executions.push({ userId, message, threadId, targetCats });
      const catId = targetCats[0];
      const text = responses[catId] ?? `Response from ${catId}`;
      yield { type: 'text', catId, content: text, timestamp: Date.now() };
      yield { type: 'done', catId, isFinal: true, timestamp: Date.now() };
    },
    getExecutions() {
      return executions;
    },
  };
}

function createMockQueueProcessor() {
  const hooks = new Map();
  return {
    registerEntryCompleteHook(entryId, hook) {
      hooks.set(entryId, hook);
    },
    unregisterEntryCompleteHook(entryId) {
      hooks.delete(entryId);
    },
    requestDrain() {
      return Promise.resolve();
    },
  };
}

// ── Test setup ─────────────────────────────────────────────────────────

describe('Multi-Mention Routes', () => {
  /** @type {import('fastify').FastifyInstance} */
  let app;
  let mockRegistry;
  let mockSocket;
  let mockMessageStore;
  let mockInvocationRecordStore;
  let mockInvocationTracker;
  let mockRouter;
  let invocationQueue;
  let mockQueueProcessor;
  let creds;

  beforeEach(async () => {
    resetMultiMentionOrchestrator();

    mockRegistry = createMockRegistry();
    mockSocket = createMockSocketManager();
    mockMessageStore = createMockMessageStore();
    mockInvocationRecordStore = createMockInvocationRecordStore();
    mockInvocationTracker = createMockInvocationTracker();
    mockRouter = createMockRouter({ codex: 'Codex says hello', gemini: 'Gemini says hi' });
    invocationQueue = new InvocationQueue();
    mockQueueProcessor = createMockQueueProcessor();

    // Register a caller invocation (opus calling)
    creds = mockRegistry.register('opus', 'thread-1', 'user-1');

    app = Fastify({ logger: false });
    registerCallbackAuthHook(app, mockRegistry);

    const { registerMultiMentionRoutes } = await import('../dist/routes/callback-multi-mention-routes.js');

    registerMultiMentionRoutes(app, {
      registry: mockRegistry,
      messageStore: mockMessageStore,
      socketManager: mockSocket,
      router: mockRouter,
      invocationRecordStore: mockInvocationRecordStore,
      invocationTracker: mockInvocationTracker,
      invocationQueue,
      queueProcessor: mockQueueProcessor,
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  // ── POST /api/callbacks/multi-mention ──────────────────────────────

  test('creates multi-mention request and returns requestId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'What do you think?',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.requestId);
    assert.equal(body.status, 'running');
  });

  test('uses durable prompt coverage so a same-wave sibling reply does not hold multi-mention', async () => {
    const freshnessApp = Fastify({ logger: false });
    registerCallbackAuthHook(freshnessApp, mockRegistry);
    const causalMessageStore = createMockMessageStore();
    const trigger = causalMessageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'M1 shared wave',
      mentions: ['opus', 'fable5'],
      threadId: 'thread-1',
      timestamp: 1,
    });
    causalMessageStore.append({
      userId: 'user-1',
      catId: 'fable5',
      content: 'Fable sibling reply',
      mentions: [],
      threadId: 'thread-1',
      timestamp: 2,
      extra: { causal: { kind: 'invocation_reply', triggerMessageId: trigger.id } },
    });
    causalMessageStore.getByThreadAfter = async (_threadId, afterId, limit = 20) =>
      causalMessageStore
        .getMessages()
        .filter((message) => message.id > afterId)
        .slice(0, limit);
    const { registerMultiMentionRoutes } = await import('../dist/routes/callback-multi-mention-routes.js');
    registerMultiMentionRoutes(freshnessApp, {
      messageStore: causalMessageStore,
      socketManager: mockSocket,
      router: mockRouter,
      invocationRecordStore: mockInvocationRecordStore,
      invocationTracker: mockInvocationTracker,
      invocationQueue,
      queueProcessor: mockQueueProcessor,
      deliveryCursorStore: {
        async getSeenCursor() {
          return trigger.id;
        },
      },
      turnExecutionStore: {
        async get(invocationId) {
          return {
            invocationId,
            parentInvocationId: invocationId,
            threadId: 'thread-1',
            userId: 'user-1',
            catId: 'opus',
            executionKind: 'ordinary',
            status: 'running',
            startedAt: 1,
            causal: { triggerMessageId: trigger.id, coveredMessageIds: [trigger.id] },
          };
        },
      },
    });
    await freshnessApp.ready();

    const res = await freshnessApp.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Continue the actual work',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'running');
    await freshnessApp.close();
  });

  test('holds multi-mention on unread visible other-cat stream-origin speech in play mode', async () => {
    const freshnessApp = Fastify({ logger: false });
    registerCallbackAuthHook(freshnessApp, mockRegistry);
    const causalMessageStore = createMockMessageStore();
    const baseline = causalMessageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'baseline already seen',
      mentions: ['opus'],
      threadId: 'thread-1',
      timestamp: 1,
    });
    causalMessageStore.append({
      userId: 'user-1',
      catId: 'codex-sol',
      content: 'unread persisted cat answer',
      mentions: [],
      origin: 'stream',
      threadId: 'thread-1',
      timestamp: 2,
    });
    causalMessageStore.getByThreadAfter = async (_threadId, afterId, limit = 20) =>
      causalMessageStore
        .getMessages()
        .filter((message) => message.id > afterId)
        .slice(0, limit);
    const { registerMultiMentionRoutes } = await import('../dist/routes/callback-multi-mention-routes.js');
    registerMultiMentionRoutes(freshnessApp, {
      messageStore: causalMessageStore,
      socketManager: mockSocket,
      router: mockRouter,
      invocationRecordStore: mockInvocationRecordStore,
      invocationTracker: mockInvocationTracker,
      deliveryCursorStore: {
        async getSeenCursor() {
          return baseline.id;
        },
      },
      threadStore: {
        async get() {
          return { id: 'thread-1', thinkingMode: 'play' };
        },
      },
    });
    await freshnessApp.ready();

    const res = await freshnessApp.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: { targets: ['codex'], question: 'must read first', callbackTo: 'opus' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'held');
    assert.equal(JSON.parse(res.body).reason, 'newer_messages_available');
    await freshnessApp.close();
  });

  test('checks queued continue-current work against the callback outer parent', async () => {
    const freshnessApp = Fastify({ logger: false });
    registerCallbackAuthHook(freshnessApp, mockRegistry);
    const parentInvocationId = 'parent-multi-freshness';
    const parentCreds = mockRegistry.register('opus', 'thread-multi-parent', 'user-1', parentInvocationId);
    const queueMessageStore = createMockMessageStore();
    queueMessageStore.getByThreadAfter = async () => [];
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const invocationQueue = new InvocationQueue();
    invocationQueue.enqueue(
      canonicalTestQueueInput({
        ownerAuthProvenance: 'strict',
        threadId: 'thread-multi-parent',
        userId: 'user-1',
        kind: 'conversation_input',
        content: 'read before starting a multi-mention',
        source: 'user',
        targetCats: ['opus'],
        authorIntentByCatId: {
          opus: { requested: 'continue_current', boundParentInvocationId: parentInvocationId },
        },
        intent: 'execute',
      }),
    );
    const { registerMultiMentionRoutes } = await import('../dist/routes/callback-multi-mention-routes.js');
    registerMultiMentionRoutes(freshnessApp, {
      messageStore: queueMessageStore,
      socketManager: mockSocket,
      router: mockRouter,
      invocationRecordStore: mockInvocationRecordStore,
      invocationTracker: mockInvocationTracker,
      invocationQueue,
      deliveryCursorStore: { getSeenCursor: async () => 'seen-cursor' },
      turnExecutionStore: {
        async get(invocationId) {
          return {
            invocationId,
            parentInvocationId,
            threadId: 'thread-multi-parent',
            userId: 'user-1',
            catId: 'opus',
            executionKind: 'ordinary',
            status: 'running',
            startedAt: 1,
          };
        },
      },
    });
    await freshnessApp.ready();

    const res = await freshnessApp.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: {
        'x-invocation-id': parentCreds.invocationId,
        'x-callback-token': parentCreds.callbackToken,
      },
      payload: {
        targets: ['codex'],
        question: 'Do not start before reading current work',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'held');
    assert.equal(JSON.parse(res.body).reason, 'newer_messages_available');
    await freshnessApp.close();
  });

  test('fails closed when callback auth has no durable child execution', async () => {
    const missingLedgerApp = Fastify({ logger: false });
    registerCallbackAuthHook(missingLedgerApp, mockRegistry);
    const { registerMultiMentionRoutes } = await import('../dist/routes/callback-multi-mention-routes.js');
    registerMultiMentionRoutes(missingLedgerApp, {
      messageStore: mockMessageStore,
      socketManager: mockSocket,
      router: mockRouter,
      invocationRecordStore: mockInvocationRecordStore,
      invocationTracker: mockInvocationTracker,
      turnExecutionStore: {
        async get() {
          return null;
        },
      },
    });
    await missingLedgerApp.ready();

    const res = await missingLedgerApp.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'must not run without child truth',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).status, 'turn_execution_not_found');
    await missingLedgerApp.close();
  });

  test('rejects invalid callback credentials', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': 'fake', 'x-callback-token': 'fake' },
      payload: {
        targets: ['codex'],
        question: 'test',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 401);
  });

  test('rejects unknown target cat', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['nonexistent-cat'],
        question: 'test',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Unknown cat'));
  });

  test('rejects unknown callbackTo cat', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'test',
        callbackTo: 'nonexistent-cat',
      },
    });

    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('callbackTo'));
  });

  test('queues all targets without direct provider dispatch', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex', 'gemini'],
        question: 'Review this design',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(mockRouter.getExecutions().length, 0);
    const entries = invocationQueue.list('thread-1', 'user-1');
    assert.equal(entries.length, 2);
    assert.deepEqual(entries.flatMap((entry) => entry.targetCats).sort(), ['codex', 'gemini']);
  });

  test('includes multi-mention prefix in queued content', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'What is your opinion?',
        callbackTo: 'opus',
      },
    });

    const [entry] = invocationQueue.list('thread-1', 'user-1');
    assert.ok(entry.content.includes('[Multi-Mention from opus]'));
    assert.ok(entry.content.includes('What is your opinion?'));
  });

  test('uses default timeout when not specified', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'test',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 200);
  });

  test('accepts optional fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'test',
        callbackTo: 'opus',
        context: 'Some context',
        idempotencyKey: 'key-1',
        timeoutMinutes: 10,
        triggerType: 'design_review',
        searchEvidenceRefs: ['ref-1'],
      },
    });

    assert.equal(res.statusCode, 200);
  });

  // ── GET /api/callbacks/multi-mention-status ────────────────────────

  test('returns status for existing request', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'test',
        callbackTo: 'opus',
      },
    });

    const { requestId } = JSON.parse(createRes.body);

    const statusRes = await app.inject({
      method: 'GET',
      url: '/api/callbacks/multi-mention-status',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      query: { requestId },
    });

    assert.equal(statusRes.statusCode, 200);
    const body = JSON.parse(statusRes.body);
    assert.equal(body.requestId, requestId);
    assert.ok(['running', 'partial', 'done'].includes(body.status));
  });

  test('returns 404 for unknown requestId', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/multi-mention-status',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      query: { requestId: 'nonexistent' },
    });

    assert.equal(res.statusCode, 404);
  });

  test('rejects status query with invalid credentials', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/callbacks/multi-mention-status',
      query: {
        invocationId: 'fake',
        callbackToken: 'fake',
        requestId: 'any',
      },
    });

    assert.equal(res.statusCode, 401);
  });

  // ── Anti-cascade ──────────────────────────────────────────────────

  test('rejects multi-mention from active target cat (anti-cascade)', async () => {
    // Manually set up orchestrator state: opus created a multi-mention targeting codex
    const { getMultiMentionOrchestrator } = await import('../dist/routes/callback-multi-mention-routes.js');
    const orch = getMultiMentionOrchestrator();
    const { createCatId } = await import('@cat-cafe/shared');
    const req = orch.create({
      threadId: 'thread-1',
      initiator: createCatId('opus'),
      callbackTo: createCatId('opus'),
      targets: [createCatId('codex')],
      question: 'First question',
      timeoutMinutes: 8,
    });
    orch.start(req.id);

    // Register codex invocation in same thread
    const codexCreds = mockRegistry.register('codex', 'thread-1', 'user-1');

    // codex tries to create another multi-mention — should be rejected
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': codexCreds.invocationId, 'x-callback-token': codexCreds.callbackToken },
      payload: {
        targets: ['gemini'],
        question: 'Cascading question',
        callbackTo: 'codex',
      },
    });

    assert.equal(res.statusCode, 409);
    const body = JSON.parse(res.body);
    assert.ok(body.error.includes('Anti-cascade'));
  });

  // ── Idempotency ───────────────────────────────────────────────────

  test('idempotency key returns same requestId', async () => {
    const payload = {
      invocationId: creds.invocationId,
      callbackToken: creds.callbackToken,
      targets: ['codex'],
      question: 'test',
      callbackTo: 'opus',
      idempotencyKey: 'idem-1',
    };

    const res1 = await app.inject({ method: 'POST', url: '/api/callbacks/multi-mention', payload });
    const res2 = await app.inject({ method: 'POST', url: '/api/callbacks/multi-mention', payload });

    const body1 = JSON.parse(res1.body);
    const body2 = JSON.parse(res2.body);
    assert.equal(body1.requestId, body2.requestId);
  });
});
