/**
 * #768 regression: intent_mode deferred broadcast in POST /api/messages
 *
 * Tests both the main path (routeExecution via invocationRecordStore) and
 * the legacy path (router.route fallback).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';

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
    tryStartThread: () => new AbortController(),
    complete: () => {},
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
