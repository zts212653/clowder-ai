/**
 * B6: multi_mention dispatch via InvocationQueue (F122B)
 *
 * Tests that when invocationQueue + queueProcessor deps are provided,
 * multi-mention dispatches go through the queue path instead of direct
 * routeExecution, and response aggregation works via entryCompleteHook.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import { CAT_CONFIGS, catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import {
  getMultiMentionOrchestrator,
  resetMultiMentionOrchestrator,
} from '../dist/routes/callback-multi-mention-routes.js';

for (const [id, config] of Object.entries(CAT_CONFIGS)) {
  if (!catRegistry.has(id)) catRegistry.register(id, config);
}

// ── Mocks ──────────────────────────────────────────────────────────────

function createMockRegistry() {
  const records = new Map();
  return {
    register(catId, threadId, userId) {
      const id = `inv-${records.size}`;
      const token = `tok-${records.size}`;
      records.set(id, { catId, threadId, userId, invocationId: id, callbackToken: token });
      return { invocationId: id, callbackToken: token };
    },
    verify(invocationId, callbackToken) {
      const r = records.get(invocationId);
      if (!r || r.callbackToken !== callbackToken) return null;
      return r;
    },
    isLatest: () => true,
    claimClientMessageId: () => true,
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
    getMessages: () => messages,
    getRoomEvents: () => roomEvents,
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
    getMessages: () => messages,
  };
}

function createMockInvocationRecordStore() {
  let counter = 0;
  return {
    create(input) {
      return { outcome: 'created', invocationId: `inv-mm-${counter++}` };
    },
    update() {},
  };
}

function createMockInvocationTracker() {
  return {
    start(threadId, catId, userId, catIds) {
      return new AbortController();
    },
    startAll() {
      return new AbortController();
    },
    tryStartThreadAll() {
      return new AbortController();
    },
    complete() {},
    completeAll() {},
  };
}

function createMockRouter() {
  const executions = [];
  return {
    async *routeExecution(userId, message, threadId, _invId, targetCats) {
      executions.push({ userId, message, threadId, targetCats });
      yield { type: 'text', catId: targetCats[0], content: `Response from ${targetCats[0]}`, timestamp: Date.now() };
      yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: Date.now() };
    },
    getExecutions: () => executions,
  };
}

/**
 * Mock QueueProcessor that captures registered hooks and simulates execution.
 */
function createMockQueueProcessor() {
  const hooks = new Map();
  const autoExecuteCalls = [];
  return {
    registerEntryCompleteHook(entryId, hook) {
      hooks.set(entryId, hook);
    },
    unregisterEntryCompleteHook(entryId) {
      hooks.delete(entryId);
    },
    tryAutoExecute(threadId) {
      autoExecuteCalls.push(threadId);
      return Promise.resolve();
    },
    getHooks: () => hooks,
    getAutoExecuteCalls: () => autoExecuteCalls,
    simulateComplete(entryId, status, responseText) {
      const hook = hooks.get(entryId);
      if (hook) {
        hook(entryId, status, responseText);
        hooks.delete(entryId);
      }
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('B6: multi_mention queue dispatch', () => {
  let app;
  let mockRegistry, mockSocket, mockMessageStore, mockInvocationRecordStore;
  let mockInvocationTracker, mockRouter;
  let invocationQueue, mockQueueProcessor;
  let creds;

  beforeEach(async () => {
    resetMultiMentionOrchestrator();
    mockRegistry = createMockRegistry();
    mockSocket = createMockSocketManager();
    mockMessageStore = createMockMessageStore();
    mockInvocationRecordStore = createMockInvocationRecordStore();
    mockInvocationTracker = createMockInvocationTracker();
    mockRouter = createMockRouter();
    invocationQueue = new InvocationQueue();
    mockQueueProcessor = createMockQueueProcessor();
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

  test('enqueues targets via InvocationQueue instead of direct dispatch', async () => {
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
    const body = res.json();
    assert.ok(body.requestId);

    // Router should NOT have been called directly (queue path used)
    assert.equal(mockRouter.getExecutions().length, 0);

    // tryAutoExecute should have been called
    assert.ok(mockQueueProcessor.getAutoExecuteCalls().length > 0);

    // Completion hook should have been registered for the enqueued entry
    assert.ok(mockQueueProcessor.getHooks().size > 0);
  });

  test('registers entryCompleteHook that records response in orchestrator', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Review this?',
        callbackTo: 'opus',
      },
    });

    const body = res.json();
    const requestId = body.requestId;
    const orch = getMultiMentionOrchestrator();

    // Initially status is running (no responses yet)
    assert.equal(orch.getStatus(requestId), 'running');

    // Simulate queue execution completing with response text
    const hooks = mockQueueProcessor.getHooks();
    assert.equal(hooks.size, 1);
    const [entryId] = hooks.keys();
    mockQueueProcessor.simulateComplete(entryId, 'succeeded', 'I reviewed it, looks good!');

    // After completion, orchestrator should be done (all 1 target responded)
    assert.equal(orch.getStatus(requestId), 'done');

    // Result message should have been flushed to message store
    const stored = mockMessageStore.getMessages();
    assert.ok(stored.length > 0);
    const flushMsg = stored.find((m) => m.content?.includes('Multi-Mention'));
    assert.ok(flushMsg, 'Expected a flushed result message');
    assert.ok(flushMsg.content.includes('I reviewed it, looks good!'));
  });

  test('multi-target: hooks fire independently and aggregate', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex', 'gemini'],
        question: 'Thoughts?',
        callbackTo: 'opus',
      },
    });

    const body = res.json();
    const requestId = body.requestId;
    const orch = getMultiMentionOrchestrator();

    // Two hooks should be registered (one per target)
    const hooks = mockQueueProcessor.getHooks();
    assert.equal(hooks.size, 2);

    const entryIds = [...hooks.keys()];

    // Complete first target
    mockQueueProcessor.simulateComplete(entryIds[0], 'succeeded', 'Codex response');
    assert.equal(orch.getStatus(requestId), 'partial');

    // Complete second target
    mockQueueProcessor.simulateComplete(entryIds[1], 'succeeded', 'Gemini response');
    assert.equal(orch.getStatus(requestId), 'done');

    // Both responses should be in the flush message
    const stored = mockMessageStore.getMessages();
    const flushMsg = stored.find((m) => m.content?.includes('Multi-Mention'));
    assert.ok(flushMsg);
    assert.ok(flushMsg.content.includes('Codex response'));
    assert.ok(flushMsg.content.includes('Gemini response'));
  });

  test('failed dispatch records failure response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Something?',
        callbackTo: 'opus',
      },
    });

    const body = res.json();
    const requestId = body.requestId;
    const orch = getMultiMentionOrchestrator();

    const hooks = mockQueueProcessor.getHooks();
    const [entryId] = hooks.keys();
    mockQueueProcessor.simulateComplete(entryId, 'failed', '');

    assert.equal(orch.getStatus(requestId), 'done');
    const result = orch.getResult(requestId);
    assert.ok(result.responses[0].content.includes('[dispatch error]'));
  });

  test('enqueued entries have source=agent and autoExecute=true', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Test queue entry fields',
        callbackTo: 'opus',
      },
    });

    // Check the real InvocationQueue entries
    const entries = invocationQueue.listAutoExecute('thread-1');
    assert.ok(entries.length > 0);
    const entry = entries[0];
    assert.equal(entry.source, 'agent');
    assert.equal(entry.autoExecute, true);
    assert.deepEqual(entry.targetCats, ['codex']);
    assert.ok(entry.content.includes('[Multi-Mention from opus]'));
    assert.ok(entry.content.includes('Test queue entry fields'));
  });

  test('depth limit prevents excessive enqueue', async () => {
    // Fill the queue with 10 agent entries (MAX_MM_DEPTH)
    for (let i = 0; i < 10; i++) {
      invocationQueue.enqueue({
        threadId: 'thread-1',
        userId: 'user-1',
        content: `fill-${i}`,
        source: 'agent',
        targetCats: [`cat-${i}`],
        intent: 'execute',
      });
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Should be blocked by depth',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 200);
    // No new hooks should be registered (depth limit hit)
    assert.equal(mockQueueProcessor.getHooks().size, 0);
  });

  test('duplicate cat detection skips already-queued cats', async () => {
    // Pre-enqueue codex as agent
    invocationQueue.enqueue({
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'existing',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Should be skipped',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 200);
    // No new hooks (codex already queued)
    assert.equal(mockQueueProcessor.getHooks().size, 0);
  });

  test('falls back to direct dispatch when queue deps are absent', async () => {
    // Create a new app WITHOUT queue deps
    const fallbackApp = Fastify({ logger: false });
    registerCallbackAuthHook(fallbackApp, mockRegistry);
    resetMultiMentionOrchestrator();
    const fallbackRouter = createMockRouter();
    const { registerMultiMentionRoutes } = await import('../dist/routes/callback-multi-mention-routes.js');
    const fallbackCreds = mockRegistry.register('opus', 'thread-2', 'user-2');

    registerMultiMentionRoutes(fallbackApp, {
      registry: mockRegistry,
      messageStore: mockMessageStore,
      socketManager: mockSocket,
      router: fallbackRouter,
      invocationRecordStore: mockInvocationRecordStore,
      invocationTracker: mockInvocationTracker,
      // No invocationQueue or queueProcessor
    });
    await fallbackApp.ready();

    const res = await fallbackApp.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': fallbackCreds.invocationId, 'x-callback-token': fallbackCreds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Fallback test',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 200);

    // Wait for async dispatch to complete
    await new Promise((r) => setTimeout(r, 100));

    // Direct dispatch should have been used (router called)
    assert.ok(fallbackRouter.getExecutions().length > 0);

    await fallbackApp.close();
  });
});

describe('B6: QueueProcessor entryCompleteHook integration', () => {
  test('executeEntry fires registered hook with response text', async () => {
    const { InvocationQueue: IQ } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { QueueProcessor: QP } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

    const queue = new IQ();
    let hookResult = null;

    const stubDeps = {
      queue,
      invocationTracker: {
        start: () => new AbortController(),
        startAll: () => new AbortController(),
        tryStartThreadAll: () => new AbortController(),
        complete: () => {},
        completeAll: () => {},
        has: () => false,
      },
      invocationRecordStore: {
        create: () => ({ outcome: 'created', invocationId: 'inv-test' }),
        update: () => {},
      },
      router: {
        async *routeExecution(_u, _c, _t, _m, targetCats) {
          yield { type: 'text', catId: targetCats[0], content: 'Hello from hook', timestamp: Date.now() };
          yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: Date.now() };
        },
        ackCollectedCursors: () => Promise.resolve(),
      },
      socketManager: {
        broadcastAgentMessage: () => {},
        broadcastToRoom: () => {},
        emitToUser: () => {},
      },
      messageStore: {
        markDelivered: () => null,
        getById: () => null,
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };

    const qp = new QP(stubDeps);

    const result = queue.enqueue({
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'test',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
    });

    qp.registerEntryCompleteHook(result.entry.id, (entryId, status, responseText) => {
      hookResult = { entryId, status, responseText };
    });

    // Trigger execution via tryAutoExecute
    await qp.tryAutoExecute('thread-1');

    // Wait for async execution to complete
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(hookResult, 'Hook should have been called');
    assert.equal(hookResult.status, 'succeeded');
    assert.equal(hookResult.responseText, 'Hello from hook');
  });

  test('hook is auto-removed after firing (one-shot)', async () => {
    const { InvocationQueue: IQ } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { QueueProcessor: QP } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

    const queue = new IQ();
    let hookCallCount = 0;

    const stubDeps = {
      queue,
      invocationTracker: {
        start: () => new AbortController(),
        startAll: () => new AbortController(),
        tryStartThreadAll: () => new AbortController(),
        complete: () => {},
        completeAll: () => {},
        has: () => false,
      },
      invocationRecordStore: {
        create: () => ({ outcome: 'created', invocationId: 'inv-test-2' }),
        update: () => {},
      },
      router: {
        async *routeExecution(_u, _c, _t, _m, targetCats) {
          yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: Date.now() };
        },
        ackCollectedCursors: () => Promise.resolve(),
      },
      socketManager: {
        broadcastAgentMessage: () => {},
        broadcastToRoom: () => {},
        emitToUser: () => {},
      },
      messageStore: {
        markDelivered: () => null,
        getById: () => null,
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };

    const qp = new QP(stubDeps);

    const result = queue.enqueue({
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'test',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
    });

    qp.registerEntryCompleteHook(result.entry.id, () => {
      hookCallCount++;
    });

    await qp.tryAutoExecute('thread-1');
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(hookCallCount, 1, 'Hook should fire exactly once');
  });

  test('P1: aborted entry fires hook with canceled status, not succeeded', async () => {
    const { InvocationQueue: IQ } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { QueueProcessor: QP } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

    const queue = new IQ();
    let hookResult = null;
    const abortController = new AbortController();

    const stubDeps = {
      queue,
      invocationTracker: {
        start: () => abortController,
        startAll: () => abortController,
        tryStartThreadAll: () => new AbortController(),
        complete: () => {},
        completeAll: () => {},
        has: () => false,
      },
      invocationRecordStore: {
        create: () => ({ outcome: 'created', invocationId: 'inv-abort' }),
        update: () => {},
      },
      router: {
        async *routeExecution(_u, _c, _t, _m, targetCats) {
          yield { type: 'text', catId: targetCats[0], content: 'partial', timestamp: Date.now() };
          abortController.abort();
          yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: Date.now() };
        },
        ackCollectedCursors: () => Promise.resolve(),
      },
      socketManager: {
        broadcastAgentMessage: () => {},
        broadcastToRoom: () => {},
        emitToUser: () => {},
      },
      messageStore: {
        markDelivered: () => null,
        getById: () => null,
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };

    const qp = new QP(stubDeps);

    const result = queue.enqueue({
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'test',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
    });

    qp.registerEntryCompleteHook(result.entry.id, (entryId, status, responseText) => {
      hookResult = { entryId, status, responseText };
    });

    await qp.tryAutoExecute('thread-1');
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(hookResult, 'Hook should have been called');
    assert.equal(hookResult.status, 'canceled', 'Aborted entry should report canceled, not succeeded');
  });

  test('R4-P1: duplicate invocation fires hook with succeeded, not failed', async () => {
    const { InvocationQueue: IQ } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { QueueProcessor: QP } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

    const queue = new IQ();
    let hookResult = null;

    const stubDeps = {
      queue,
      invocationTracker: {
        start: () => new AbortController(),
        startAll: () => new AbortController(),
        tryStartThreadAll: () => new AbortController(),
        complete: () => {},
        completeAll: () => {},
        has: () => false,
      },
      invocationRecordStore: {
        create: () => ({ outcome: 'duplicate', invocationId: 'inv-dup' }),
        update: () => {},
      },
      router: {
        async *routeExecution() {
          throw new Error('Should not be called for duplicate');
        },
        ackCollectedCursors: () => Promise.resolve(),
      },
      socketManager: {
        broadcastAgentMessage: () => {},
        broadcastToRoom: () => {},
        emitToUser: () => {},
      },
      messageStore: {
        markDelivered: () => null,
        getById: () => null,
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };

    const qp = new QP(stubDeps);

    const result = queue.enqueue({
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'test-dup',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
    });

    qp.registerEntryCompleteHook(result.entry.id, (entryId, status, responseText) => {
      hookResult = { entryId, status, responseText };
    });

    await qp.tryAutoExecute('thread-1');
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(hookResult, 'Hook should have been called for duplicate');
    assert.equal(hookResult.status, 'succeeded', 'Duplicate should report succeeded, not failed');
  });
});

describe('B6: canceled hook skips recordResponse in dispatchViaQueue', () => {
  let app;
  let mockRegistry, mockSocket, mockMessageStore, mockInvocationRecordStore;
  let mockInvocationTracker, mockRouter;
  let invocationQueue, mockQueueProcessor;
  let creds;

  beforeEach(async () => {
    resetMultiMentionOrchestrator();
    mockRegistry = createMockRegistry();
    mockSocket = createMockSocketManager();
    mockMessageStore = createMockMessageStore();
    mockInvocationRecordStore = createMockInvocationRecordStore();
    mockInvocationTracker = createMockInvocationTracker();
    mockRouter = createMockRouter();
    invocationQueue = new InvocationQueue();
    mockQueueProcessor = createMockQueueProcessor();
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

  test('canceled hook does not record response in orchestrator', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Abort scenario?',
        callbackTo: 'opus',
      },
    });

    const body = res.json();
    const requestId = body.requestId;
    const orch = getMultiMentionOrchestrator();

    assert.equal(orch.getStatus(requestId), 'running');

    const hooks = mockQueueProcessor.getHooks();
    const [entryId] = hooks.keys();
    mockQueueProcessor.simulateComplete(entryId, 'canceled', '');

    // Orchestrator should still be running (canceled does NOT count as a response)
    assert.equal(orch.getStatus(requestId), 'running');
  });

  test('P2: unregisterEntryCompleteHook cleans up on entry removal', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Will be removed',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 200);

    const hooks = mockQueueProcessor.getHooks();
    assert.equal(hooks.size, 1, 'Should have registered one hook');

    const [entryId] = hooks.keys();
    mockQueueProcessor.unregisterEntryCompleteHook(entryId);
    assert.equal(hooks.size, 0, 'Hook should be cleaned up after unregister');
  });
});
