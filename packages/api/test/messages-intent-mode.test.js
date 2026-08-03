/**
 * #768 regression: intent_mode deferred broadcast in POST /api/messages
 *
 * Tests both the main path (routeExecution via invocationRecordStore) and
 * the legacy path (router.route fallback).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';

// Shared minimal mocks ──────────────────────────────────────────────

function makeMockRouter(routeFn, routeExecutionFn) {
  return {
    resolveTargetsAndIntent: async () => ({
      targetCats: ['codex'],
      intent: { intent: 'execute', explicit: false, promptTags: [] },
    }),
    route: routeFn ?? async function* () {},
    routeExecution:
      routeExecutionFn ??
      async function* () {
        yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
      },
    ackCollectedCursors: async () => {},
  };
}

function makeMockSocketManager() {
  const events = [];
  return {
    events,
    broadcastToRoom(room, event, payload) {
      events.push({ room, event, payload });
    },
    broadcastAgentMessage() {},
    emitToUser() {},
  };
}

function makeMockRegistry() {
  return {
    active() {
      return new Set();
    },
  };
}

function makeMockMessageStore() {
  return {
    append: async (msg) => ({ id: `msg-${Date.now()}`, ...msg }),
    updateStatus: async () => {},
  };
}

function makeMockInvocationTracker() {
  return {
    has: () => false,
    isDeleting: () => false,
    start: () => new AbortController(),
    startAll: () => new AbortController(),
    tryStartThread: () => new AbortController(),
    tryStartThreadAll: () => new AbortController(),
    complete: () => {},
    completeAll: () => {},
    completeSlot: () => {},
    trackExternalSlot: () => true,
  };
}

function makeMockInvocationRecordStore() {
  return {
    create: async () => ({ outcome: 'created', invocationId: `inv-${Date.now()}` }),
    update: async () => {},
  };
}

async function buildApp(overrides = {}) {
  const { messagesRoutes } = await import('../dist/routes/messages.js');
  const socketManager = overrides.socketManager ?? makeMockSocketManager();
  const app = Fastify();
  await app.register(messagesRoutes, {
    registry: makeMockRegistry(),
    messageStore: makeMockMessageStore(),
    socketManager,
    router: overrides.router ?? makeMockRouter(),
    invocationTracker: overrides.invocationTracker ?? makeMockInvocationTracker(),
    invocationRecordStore: overrides.invocationRecordStore,
    ...(overrides.extra ?? {}),
  });
  await app.ready();
  return { app, socketManager };
}

// ── Legacy path (no invocationRecordStore) ──────────────────────────

describe('#768 messages.ts legacy path', () => {
  it('intent_mode is NOT broadcast when router.route throws before yielding', async () => {
    const sm = makeMockSocketManager();
    const { app } = await buildApp({
      socketManager: sm,
      router: makeMockRouter(async function* () {
        throw new Error('CLI spawn failed');
      }, undefined),
      // No invocationRecordStore → legacy path
      invocationRecordStore: undefined,
    });

    await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { content: '@codex test', threadId: 'thread-768-legacy-throw' },
    });

    // Background fire-and-forget: wait for it to flush
    await new Promise((r) => setTimeout(r, 50));

    const intentEvents = sm.events.filter((e) => e.event === 'intent_mode');
    assert.equal(
      intentEvents.length,
      0,
      '#768: legacy path must NOT broadcast intent_mode when route() throws before yielding',
    );
    await app.close();
  });

  it('intent_mode IS broadcast once router.route yields first event', async () => {
    const sm = makeMockSocketManager();
    const { app } = await buildApp({
      socketManager: sm,
      router: makeMockRouter(async function* () {
        yield { type: 'text', catId: 'codex', content: 'hello', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
      }, undefined),
      invocationRecordStore: undefined,
    });

    await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { content: '@codex test', threadId: 'thread-768-legacy-ok' },
    });

    await new Promise((r) => setTimeout(r, 50));

    const intentEvents = sm.events.filter((e) => e.event === 'intent_mode');
    assert.equal(intentEvents.length, 1, '#768: legacy path must broadcast intent_mode exactly once');
    assert.equal(intentEvents[0].payload.threadId, 'thread-768-legacy-ok');
    await app.close();
  });

  it('passes authoritative A2A admission and durable deferral into the legacy route', async () => {
    const queue = new InvocationQueue();
    const tracker = makeMockInvocationTracker();
    tracker.trackExternalSlot = () => false;
    let observedClaim;
    let observedEnqueue;
    const { app } = await buildApp({
      router: makeMockRouter(async function* (_userId, _content, threadId, _blocks, _uploadDir, _signal, options) {
        observedClaim = options.trackA2ASlot(threadId, 'codex', 'user-1', options.invocationController);
        observedEnqueue = options.deferA2AEnqueue({
          threadId,
          userId: 'user-1',
          content: '@codex review complete',
          source: 'agent',
          sourceCategory: 'a2a',
          targetCats: ['codex'],
          callerCatId: 'opus',
          messageId: 'msg-legacy-review',
          a2aTriggerMessageId: 'msg-legacy-review',
          autoExecute: true,
          priority: 'normal',
          intent: 'execute',
        });
        yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
      }, undefined),
      invocationTracker: tracker,
      invocationRecordStore: undefined,
      extra: { invocationQueue: queue },
    });

    await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { content: '@opus review', threadId: 'thread-legacy-a2a-admission' },
    });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(observedClaim, false);
    assert.equal(observedEnqueue.outcome, 'enqueued');
    const [deferred] = queue.list('thread-legacy-a2a-admission', 'user-1');
    assert.equal(deferred.messageId, 'msg-legacy-review');
    assert.equal(deferred.ownerAuthProvenance, 'compatibility_fallback');
    await app.close();
  });

  it('releases a completed dynamic A2A child outside the original target set exactly once', async () => {
    const tracker = new InvocationTracker();
    const completeSlotCalls = [];
    const completeSlot = tracker.completeSlot.bind(tracker);
    let routeController;
    tracker.completeSlot = (threadId, catId, controller) => {
      completeSlotCalls.push({ threadId, catId, controller });
      completeSlot(threadId, catId, controller);
    };

    const { app } = await buildApp({
      router: makeMockRouter(async function* (_userId, _content, threadId, _blocks, _uploadDir, _signal, options) {
        routeController = options.invocationController;
        assert.equal(options.trackA2ASlot(threadId, 'opus', 'user-1', routeController), true);
        yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
      }, undefined),
      invocationTracker: tracker,
      invocationRecordStore: undefined,
    });

    await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { content: '@codex route to opus', threadId: 'thread-legacy-dynamic-child' },
    });
    await new Promise((r) => setTimeout(r, 50));

    const opusCompletions = completeSlotCalls.filter((call) => call.catId === 'opus');
    assert.equal(opusCompletions.length, 1);
    assert.equal(opusCompletions[0].threadId, 'thread-legacy-dynamic-child');
    assert.equal(opusCompletions[0].controller, routeController);
    assert.equal(tracker.has('thread-legacy-dynamic-child', 'opus'), false);
    await app.close();
  });

  it('cannot release a replacement dynamic child with the completed route generation', async () => {
    const tracker = new InvocationTracker();
    const completeSlot = tracker.completeSlot.bind(tracker);
    let routeController;
    let replacementController;
    let opusCompletionCount = 0;
    tracker.completeSlot = (threadId, catId, controller) => {
      if (catId === 'opus') {
        opusCompletionCount += 1;
        replacementController = tracker.startAll(threadId, ['opus'], 'user-2', 'replacement-opus');
      }
      completeSlot(threadId, catId, controller);
    };

    const { app } = await buildApp({
      router: makeMockRouter(async function* (_userId, _content, threadId, _blocks, _uploadDir, _signal, options) {
        routeController = options.invocationController;
        assert.equal(options.trackA2ASlot(threadId, 'opus', 'user-1', routeController), true);
        yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
      }, undefined),
      invocationTracker: tracker,
      invocationRecordStore: undefined,
    });

    await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { content: '@codex replace opus', threadId: 'thread-legacy-replacement-child' },
    });
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(opusCompletionCount, 1);
    assert.ok(replacementController);
    assert.notEqual(replacementController, routeController);
    assert.equal(
      tracker.classifyExecutionId('thread-legacy-replacement-child', 'opus', 'replacement-opus'),
      'matching',
    );
    assert.equal(tracker.has('thread-legacy-replacement-child', 'opus'), true);
    tracker.completeAll('thread-legacy-replacement-child', ['opus'], replacementController);
    await app.close();
  });
});

// ── Main path (with invocationRecordStore) ──────────────────────────

describe('#768 messages.ts main path', () => {
  it('intent_mode is NOT broadcast when routeExecution throws before yielding', async () => {
    const sm = makeMockSocketManager();
    const { app } = await buildApp({
      socketManager: sm,
      router: makeMockRouter(undefined, async function* () {
        throw new Error('CLI spawn failed');
      }),
      invocationRecordStore: makeMockInvocationRecordStore(),
    });

    await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { content: '@codex test', threadId: 'thread-768-main-throw' },
    });

    await new Promise((r) => setTimeout(r, 50));

    const intentEvents = sm.events.filter((e) => e.event === 'intent_mode');
    assert.equal(
      intentEvents.length,
      0,
      '#768: main path must NOT broadcast intent_mode when routeExecution throws before yielding',
    );
    await app.close();
  });

  it('intent_mode IS broadcast once routeExecution yields first event', async () => {
    const sm = makeMockSocketManager();
    const { app } = await buildApp({
      socketManager: sm,
      router: makeMockRouter(undefined, async function* () {
        yield { type: 'text', catId: 'codex', content: 'hello', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
      }),
      invocationRecordStore: makeMockInvocationRecordStore(),
    });

    await app.inject({
      method: 'POST',
      url: '/api/messages',
      payload: { content: '@codex test', threadId: 'thread-768-main-ok' },
    });

    await new Promise((r) => setTimeout(r, 50));

    const intentEvents = sm.events.filter((e) => e.event === 'intent_mode');
    assert.equal(intentEvents.length, 1, '#768: main path must broadcast intent_mode exactly once');
    assert.equal(intentEvents[0].payload.threadId, 'thread-768-main-ok');
    await app.close();
  });
});
