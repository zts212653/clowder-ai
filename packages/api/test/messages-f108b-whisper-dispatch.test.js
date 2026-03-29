/**
 * F108 Phase B: Whisper/targeted messages use slot-level delivery mode.
 *
 * Core behavior:
 * - Whisper to idle cat → immediate (side-dispatch), even if another cat is busy
 * - Whisper to busy cat → queue (same as before)
 * - Broadcast (no whisper) → thread-level check (any busy → queue)
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');

function buildDeps(overrides = {}) {
  const invocationQueue = new InvocationQueue();
  return {
    registry: new InvocationRegistry(),
    messageStore: {
      append: mock.fn(async (msg) => ({ id: `msg-${Date.now()}`, ...msg })),
      getByThread: mock.fn(async () => []),
      getByThreadBefore: mock.fn(async () => []),
    },
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    router: {
      resolveTargetsAndIntent: mock.fn(async () => ({
        targetCats: ['opus'],
        intent: { intent: 'execute' },
      })),
      routeExecution: mock.fn(async function* () {
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
      route: mock.fn(async function* () {
        yield { type: 'done' };
      }),
    },
    invocationTracker: {
      start: mock.fn(() => new AbortController()),
      tryStartThread: mock.fn(() => new AbortController()),
      complete: mock.fn(),
      // Slot-aware has(): thread-level returns true (opus busy), slot-level varies
      has: mock.fn((threadId, catId) => {
        if (catId === 'opus') return true; // opus is busy
        if (catId === 'codex') return false; // codex is idle
        // No catId → thread-level: true (something is busy)
        return !catId ? true : false;
      }),
      cancel: mock.fn(() => ({ cancelled: true, catIds: ['opus'] })),
      isDeleting: mock.fn(() => false),
      getActiveSlots: mock.fn(() => ['opus']),
    },
    invocationRecordStore: {
      create: mock.fn(async () => ({
        outcome: 'created',
        invocationId: 'inv-stub',
      })),
      update: mock.fn(async () => {}),
    },
    invocationQueue,
    threadStore: {
      get: mock.fn(async () => ({
        id: 'thread-1',
        title: 'Test Thread',
        createdBy: 'test-user',
      })),
      updateTitle: mock.fn(async () => {}),
    },
    ...overrides,
  };
}

describe('F108B: whisper slot-aware delivery mode', () => {
  let app;
  let deps;

  beforeEach(async () => {
    deps = buildDeps();
    const { messagesRoutes } = await import('../dist/routes/messages.js');
    app = Fastify();
    await app.register(messagesRoutes, deps);
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('whisper to idle cat (codex) → immediate dispatch, not queued', async () => {
    // opus is busy, codex is idle. Whisper targets codex.
    deps.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['codex'],
      intent: { intent: 'execute' },
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '缅因猫你反思一下',
        threadId: 'thread-1',
        visibility: 'whisper',
        whisperTo: ['codex'],
        // No deliveryMode → server should auto-decide based on target slot
      },
    });

    assert.equal(res.statusCode, 200, `Expected 200 (immediate), got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'processing', 'whisper to idle cat should be immediate, not queued');

    // Should have created InvocationRecord (immediate path)
    assert.ok(
      deps.invocationRecordStore.create.mock.calls.length > 0,
      'immediate dispatch should create InvocationRecord',
    );

    // Queue should be empty
    assert.equal(deps.invocationQueue.list('thread-1', 'user-1').length, 0, 'whisper to idle cat should not enqueue');
  });

  it('whisper to busy cat (opus) → queued', async () => {
    // opus is busy. Whisper targets opus.
    deps.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['opus'],
      intent: { intent: 'execute' },
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '布偶猫这个 bug 先放一放',
        threadId: 'thread-1',
        visibility: 'whisper',
        whisperTo: ['opus'],
      },
    });

    assert.equal(res.statusCode, 202, `Expected 202 (queued), got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'queued', 'whisper to busy cat should queue');
  });

  it('broadcast (no whisper) with active cat → still queued (thread-level)', async () => {
    // opus is busy. No whisper → broadcast. Should queue.
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '大家注意',
        threadId: 'thread-1',
        // No visibility, no whisperTo → broadcast
      },
    });

    assert.equal(res.statusCode, 202, `Expected 202 (queued), got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'queued', 'broadcast with active cat should queue');
  });

  it('AC-B4: broadcast @mention to idle cat → immediate (slot-level check)', async () => {
    // opus is busy, codex is idle. Message @mentions codex explicitly.
    // resolveTargetsAndIntent returns hasMentions: true because @codex was parsed.
    deps.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['codex'],
      intent: { intent: 'execute' },
      hasMentions: true,
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '@codex 帮我看看这个函数',
        threadId: 'thread-1',
        // No visibility, no whisperTo → broadcast, but with explicit @mention
      },
    });

    assert.equal(res.statusCode, 200, `Expected 200 (immediate), got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'processing', '@mention to idle cat should dispatch immediately');
    assert.equal(deps.invocationQueue.list('thread-1', 'user-1').length, 0, '@mention to idle cat should not enqueue');
  });

  it('AC-B4: broadcast @mention to busy cat → queued', async () => {
    // opus is busy. Message @mentions opus explicitly.
    deps.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['opus'],
      intent: { intent: 'execute' },
      hasMentions: true,
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '@opus 停一下',
        threadId: 'thread-1',
      },
    });

    assert.equal(res.statusCode, 202, `Expected 202 (queued), got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'queued', '@mention to busy cat should queue');
  });

  it('AC-B4: broadcast without @mention (fallback routing) → thread-level queue', async () => {
    // opus is busy. No @mention → fallback routing resolves to opus.
    // hasMentions: false → thread-level check → queued.
    deps.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['opus'],
      intent: { intent: 'execute' },
      hasMentions: false,
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '帮我看看这个函数',
        threadId: 'thread-1',
      },
    });

    assert.equal(res.statusCode, 202, `Expected 202 (queued), got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'queued', 'no @mention with busy thread should queue');
  });

  it('P1: multi @mention with mixed busy/idle → queued (any busy = queue)', async () => {
    // @codex(idle) + @opus(busy). hasMentions: true, targetCats: ['codex', 'opus'].
    // Even though codex is idle, opus is busy → entire message should queue.
    deps.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['codex', 'opus'],
      intent: { intent: 'execute' },
      hasMentions: true,
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '@codex @opus 帮我看看',
        threadId: 'thread-1',
      },
    });

    assert.equal(res.statusCode, 202, `Expected 202 (queued), got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'queued', 'multi-mention with any busy target should queue');
  });

  it('P1: multi @mention with reversed order (busy first) → queued', async () => {
    // @opus(busy) + @codex(idle). Order reversed — should still queue.
    deps.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['opus', 'codex'],
      intent: { intent: 'execute' },
      hasMentions: true,
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '@opus @codex 帮我看看',
        threadId: 'thread-1',
      },
    });

    assert.equal(res.statusCode, 202, `Expected 202 (queued), got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'queued', 'multi-mention with busy first should also queue');
  });

  it('P1: multi @mention all idle → immediate', async () => {
    // @codex(idle) + @gemini(idle). Both idle → immediate.
    deps.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['codex', 'gemini'],
      intent: { intent: 'execute' },
      hasMentions: true,
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '@codex @gemini 帮我看看',
        threadId: 'thread-1',
      },
    });

    assert.equal(res.statusCode, 200, `Expected 200 (immediate), got ${res.statusCode}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'processing', 'multi-mention all idle should dispatch immediately');
  });

  it('explicit deliveryMode=force on whisper → cancels target slot and executes', async () => {
    // opus is busy. Whisper to opus with force → should cancel and execute immediately.
    deps.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['opus'],
      intent: { intent: 'execute' },
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '布偶猫停下来',
        threadId: 'thread-1',
        visibility: 'whisper',
        whisperTo: ['opus'],
        deliveryMode: 'force',
      },
    });

    // Force should cancel and execute immediately
    assert.ok(deps.invocationTracker.cancel.mock.calls.length > 0, 'force mode should cancel active invocation');
    assert.equal(deps.invocationQueue.list('thread-1', 'user-1').length, 0, 'force mode should not enqueue');
  });
});
