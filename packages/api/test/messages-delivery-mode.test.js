/**
 * POST /api/messages deliveryMode tests (F39)
 * Tests queue/force/immediate routing logic.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');

/** Build a complete deps object for messagesRoutes */
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
      startAll: mock.fn(() => new AbortController()),
      tryStartThread: mock.fn(() => new AbortController()),
      tryStartThreadAll: mock.fn(() => new AbortController()),
      complete: mock.fn(),
      completeAll: mock.fn(),
      has: mock.fn(() => false),
      cancel: mock.fn(() => ({ cancelled: true, catIds: ['opus'] })),
      isDeleting: mock.fn(() => false),
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

describe('POST /api/messages deliveryMode', () => {
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

  it('queue mode + active invocation → enqueues and returns 202', async () => {
    // Simulate active invocation
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '你好猫猫',
        threadId: 'thread-1',
        deliveryMode: 'queue',
      },
    });

    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'queued');
    assert.equal(body.merged, false);
    assert.ok(body.entryId);
    assert.equal(body.queuePosition, 1);
    assert.match(body.userMessageId, /^msg-/);

    // Should NOT have created InvocationRecord (queued, not executing)
    assert.equal(deps.invocationRecordStore.create.mock.calls.length, 0);

    // Should have written user message to messageStore
    assert.equal(deps.messageStore.append.mock.calls.length, 1);

    // Should have emitted queue_updated to user
    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const queueUpdate = emitCalls.find((c) => c.arguments[1] === 'queue_updated');
    assert.ok(queueUpdate, 'should emit queue_updated');
    assert.equal(queueUpdate.arguments[2].action, 'enqueued');
  });

  it('queue mode → merges same-user consecutive messages', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    // First message
    await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '第一条', threadId: 'thread-1', deliveryMode: 'queue' },
    });

    // Second message — same user, same target → should merge
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '第二条', threadId: 'thread-1', deliveryMode: 'queue' },
    });

    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'queued');
    assert.equal(body.merged, true);

    // Queue should have 1 entry (merged)
    const queue = deps.invocationQueue.list('thread-1', 'user-1');
    assert.equal(queue.length, 1);
    assert.ok(queue[0].content.includes('第一条'));
    assert.ok(queue[0].content.includes('第二条'));
  });

  it('queue mode → returns 429 when queue full (no ghost message)', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    // Fill queue to capacity (5 entries with different targets to prevent merge)
    for (let i = 0; i < 5; i++) {
      deps.invocationQueue.enqueue({
        threadId: 'thread-1',
        userId: 'user-1',
        content: `msg ${i}`,
        source: 'user',
        targetCats: [`cat${i}`],
        intent: 'execute',
      });
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: 'overflow', threadId: 'thread-1', deliveryMode: 'queue' },
    });

    assert.equal(res.statusCode, 429);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'QUEUE_FULL');

    // Should NOT have written to messageStore (no ghost message)
    assert.equal(deps.messageStore.append.mock.calls.length, 0);

    // Should have emitted queue_full_warning
    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const fullWarning = emitCalls.find((c) => c.arguments[1] === 'queue_full_warning');
    assert.ok(fullWarning, 'should emit queue_full_warning');
  });

  it('queue mode → messageStore failure rolls back queue entry', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);
    deps.messageStore.append.mock.mockImplementation(async () => {
      throw new Error('DB write failed');
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '会失败', threadId: 'thread-1', deliveryMode: 'queue' },
    });

    // Fastify catches the thrown error and returns 500
    assert.equal(res.statusCode, 500);

    // The queue should be empty (entry was rolled back)
    const queue = deps.invocationQueue.list('thread-1', 'user-1');
    assert.equal(queue.length, 0, 'queue entry should be rolled back on messageStore failure');
  });

  it('force mode → cancels active invocation then executes immediately', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    const _res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '强制发送', threadId: 'thread-1', deliveryMode: 'force' },
    });

    // Should have called cancel
    assert.ok(deps.invocationTracker.cancel.mock.calls.length > 0, 'should cancel active invocation');

    // Should have broadcast cancel messages
    const broadcastCalls = deps.socketManager.broadcastAgentMessage.mock.calls;
    const cancelMsg = broadcastCalls.find((c) => c.arguments[0]?.type === 'system_info');
    assert.ok(cancelMsg, 'should broadcast cancel system_info');

    // Should have proceeded to create InvocationRecord (immediate path)
    assert.ok(deps.invocationRecordStore.create.mock.calls.length > 0);
  });

  it('immediate mode when no active → normal execution (no queue)', async () => {
    // has() returns false → no active invocation
    deps.invocationTracker.has.mock.mockImplementation(() => false);

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '直接发送', threadId: 'thread-1', deliveryMode: 'immediate' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'processing');
    assert.match(body.userMessageId, /^msg-/);

    // Should go through normal path
    assert.ok(deps.invocationRecordStore.create.mock.calls.length > 0);

    // Queue should be empty
    assert.equal(deps.invocationQueue.list('thread-1', 'user-1').length, 0);
  });

  it('aborted invocation does not emit spawn_started after stop wins the race', async () => {
    const controller = new AbortController();
    let releaseRunningUpdate;
    const runningUpdateGate = new Promise((resolve) => {
      releaseRunningUpdate = resolve;
    });

    deps.invocationTracker.tryStartThreadAll.mock.mockImplementation(() => controller);
    deps.invocationRecordStore.update.mock.mockImplementation(async (_id, data) => {
      if (data?.status === 'running') {
        await runningUpdateGate;
      }
    });
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      yield { type: 'text', catId: 'opus', content: 'late', timestamp: Date.now() };
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '先发再停', threadId: 'thread-1', deliveryMode: 'immediate' },
    });

    assert.equal(res.statusCode, 200);

    controller.abort('user_stop');
    releaseRunningUpdate();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const spawnStarted = deps.socketManager.broadcastToRoom.mock.calls.find((c) => c.arguments[1] === 'spawn_started');
    assert.equal(spawnStarted, undefined);
  });

  it('immediate execution passes queueHasQueuedMessages fairness callback to routeExecution', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    deps.invocationQueue.enqueue({
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'queued-before',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '直接发送', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((r) => setTimeout(r, 20));
    assert.ok(deps.router.routeExecution.mock.calls.length > 0);
    const call = deps.router.routeExecution.mock.calls[0];
    const options = call.arguments[6];
    assert.equal(typeof options?.queueHasQueuedMessages, 'function');
    assert.equal(options.queueHasQueuedMessages('thread-1'), true);
    assert.equal(options.queueHasQueuedMessages('thread-x'), false);
  });

  // ── P1-1: multipart deliveryMode extraction ──

  it('multipart request with deliveryMode=force → cancels and executes immediately', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    const boundary = '----cat-cafe-test-boundary';
    const payload = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="content"\r\n\r\n强制发送\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="threadId"\r\n\r\nthread-1\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="deliveryMode"\r\n\r\nforce\r\n`),
      Buffer.from(`--${boundary}--\r\n`),
    ]);

    const _res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'x-cat-cafe-user': 'user-1',
      },
      payload,
    });

    // Should cancel active invocation (force mode)
    assert.ok(
      deps.invocationTracker.cancel.mock.calls.length > 0,
      'multipart deliveryMode=force should cancel active invocation',
    );

    // Should NOT queue — should proceed to immediate execution
    assert.equal(deps.invocationQueue.list('thread-1', 'user-1').length, 0, 'force mode should not enqueue');
  });

  // ── P1-2: merged entry rollback race ──

  it('enqueued entry rollback preserves merged content when messageStore fails', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    // Make messageStore.append fail on FIRST call but simulate merge during the await
    let callCount = 0;
    deps.messageStore.append.mock.mockImplementation(async (msg) => {
      callCount++;
      if (callCount === 1) {
        // Simulate concurrent request B merging into A's entry during A's await
        // B arrives while A is waiting for messageStore.append
        deps.invocationQueue.enqueue({
          threadId: 'thread-1',
          userId: 'user-1',
          content: 'B的消息不应该丢失',
          source: 'user',
          targetCats: ['opus'],
          intent: 'execute',
        });
        throw new Error('DB write failed for A');
      }
      return { id: `msg-${Date.now()}`, ...msg };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: 'A的消息', threadId: 'thread-1', deliveryMode: 'queue' },
    });

    // A's request failed
    assert.equal(res.statusCode, 500);

    // B's merged content should still be in the queue (not removed by A's rollback)
    const queue = deps.invocationQueue.list('thread-1', 'user-1');
    assert.ok(queue.length > 0, 'queue should not be empty — B merged content must survive');
    assert.ok(queue[0].content.includes('B的消息不应该丢失'), 'B message content should survive A rollback');
  });

  // ── P1 bugfix: abort mid-loop → must NOT ack or mark succeeded ──

  it('bugfix: signal aborted mid-loop → should NOT ack cursors or mark succeeded', async () => {
    // Create a controllable AbortController
    const controller = new AbortController();

    deps.invocationTracker.has.mock.mockImplementation(() => false);
    deps.invocationTracker.start.mock.mockImplementation(() => controller);
    deps.invocationTracker.startAll.mock.mockImplementation(() => controller);
    deps.invocationTracker.tryStartThread.mock.mockImplementation(() => controller);
    deps.invocationTracker.tryStartThreadAll.mock.mockImplementation(() => controller);

    // Router that yields one message, then aborts (simulating external force-cancel),
    // then ends normally (no throw) — this is the exact scenario砚砚 identified.
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      yield { type: 'text', catId: 'opus', content: 'partial output', timestamp: Date.now() };
      // External cancel happens here (e.g., force-send from铲屎官)
      controller.abort();
      // Generator ends normally — no throw. The for-await break exits the loop,
      // but post-loop code must NOT run ack+succeeded.
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '测试取消', threadId: 'thread-1' },
    });

    assert.equal(res.statusCode, 200);

    // Wait for background IIFE to complete
    await new Promise((resolve) => setTimeout(resolve, 200));

    // ackCollectedCursors should NOT be called (aborted invocation)
    assert.equal(deps.router.ackCollectedCursors.mock.calls.length, 0, 'should NOT ack cursors for aborted invocation');

    // invocationRecordStore.update should have 'canceled', NOT 'succeeded'
    const updateCalls = deps.invocationRecordStore.update.mock.calls;
    const succeededCall = updateCalls.find((c) => c.arguments[1]?.status === 'succeeded');
    assert.ok(!succeededCall, 'should NOT mark as succeeded when signal aborted');

    const canceledCall = updateCalls.find((c) => c.arguments[1]?.status === 'canceled');
    assert.ok(canceledCall, 'should mark as canceled when signal aborted');
  });

  it('F148 fix: abort after partial completion still acks collected cursors', async () => {
    const controller = new AbortController();

    deps.invocationTracker.has.mock.mockImplementation(() => false);
    deps.invocationTracker.start.mock.mockImplementation(() => controller);
    deps.invocationTracker.startAll.mock.mockImplementation(() => controller);
    deps.invocationTracker.tryStartThread.mock.mockImplementation(() => controller);
    deps.invocationTracker.tryStartThreadAll.mock.mockImplementation(() => controller);
    deps.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['gemini', 'opus'],
      intent: { intent: 'execute' },
    }));
    deps.router.routeExecution.mock.mockImplementation(
      async function* (_userId, _content, _threadId, _messageId, _targetCats, _intent, opts) {
        opts.cursorBoundaries.set('gemini', 'boundary-gemini-001');
        yield { type: 'text', catId: 'gemini', content: 'done', timestamp: Date.now() };
        yield { type: 'done', catId: 'gemini', timestamp: Date.now() };
        controller.abort('preempted');
        yield { type: 'text', catId: 'opus', content: 'partial', timestamp: Date.now() };
      },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '@gemini @opus 测试取消后补 ack', threadId: 'thread-1' },
    });

    assert.equal(res.statusCode, 200);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const ackCalls = deps.router.ackCollectedCursors.mock.calls;
    assert.equal(ackCalls.length, 1, 'should ack collected cursors for completed cats before abort');
    assert.equal(ackCalls[0].arguments[0], 'user-1');
    assert.equal(ackCalls[0].arguments[1], 'thread-1');
    const boundaries = ackCalls[0].arguments[2];
    assert.ok(boundaries instanceof Map, 'boundaries should be a Map');
    assert.equal(boundaries.get('gemini'), 'boundary-gemini-001');

    const updateCalls = deps.invocationRecordStore.update.mock.calls;
    const succeededCall = updateCalls.find((c) => c.arguments[1]?.status === 'succeeded');
    assert.ok(!succeededCall, 'should NOT mark as succeeded when signal aborted');
    const canceledCall = updateCalls.find((c) => c.arguments[1]?.status === 'canceled');
    assert.ok(canceledCall, 'should mark as canceled when signal aborted');
  });

  it('F148 fix: exception after partial completion still acks collected cursors', async () => {
    deps.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['gemini', 'opus'],
      intent: { intent: 'execute' },
    }));
    deps.router.routeExecution.mock.mockImplementation(
      async function* (_userId, _content, _threadId, _messageId, _targetCats, _intent, opts) {
        opts.cursorBoundaries.set('gemini', 'boundary-gemini-002');
        yield { type: 'text', catId: 'gemini', content: 'done', timestamp: Date.now() };
        yield { type: 'done', catId: 'gemini', timestamp: Date.now() };
        throw new Error('ACP process crashed');
      },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '@gemini @opus 测试异常后补 ack', threadId: 'thread-1' },
    });

    assert.equal(res.statusCode, 200);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const ackCalls = deps.router.ackCollectedCursors.mock.calls;
    assert.equal(ackCalls.length, 1, 'should ack collected cursors before failing the invocation');
    const boundaries = ackCalls[0].arguments[2];
    assert.ok(boundaries instanceof Map, 'boundaries should be a Map');
    assert.equal(boundaries.get('gemini'), 'boundary-gemini-002');

    const updateCalls = deps.invocationRecordStore.update.mock.calls;
    const failedCall = updateCalls.find((c) => c.arguments[1]?.status === 'failed');
    assert.ok(failedCall, 'should mark invocation as failed on exception');
  });

  it('default mode with active invocation → falls back to queue', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    // No deliveryMode specified → smart default
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '自动排队', threadId: 'thread-1' },
    });

    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'queued');

    // Should NOT have created InvocationRecord
    assert.equal(deps.invocationRecordStore.create.mock.calls.length, 0);
  });
});
