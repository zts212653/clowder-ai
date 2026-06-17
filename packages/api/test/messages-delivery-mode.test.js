/**
 * POST /api/messages deliveryMode tests (F39)
 * Tests queue/force/immediate routing logic.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
const { buildCapsuleFromRouteState, completeCapsuleForSeal } = await import(
  '../dist/domains/cats/services/agents/invocation/CollaborationContinuityCapsule.js'
);

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
      cancelAll: mock.fn(() => ['opus']),
      cancelInvocation: mock.fn(() => ['opus']),
      isDeleting: mock.fn(() => false),
    },
    invocationRecordStore: {
      create: mock.fn(async () => ({
        outcome: 'created',
        invocationId: 'inv-stub',
      })),
      update: mock.fn(async () => {}),
      get: mock.fn(async () => null),
    },
    invocationQueue,
    queueProcessor: {
      clearPause: mock.fn(),
      onInvocationComplete: mock.fn(async () => {}),
      enqueueContinuation: mock.fn(async () => ({ outcome: 'enqueued' })),
    },
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

  it('queue mode replay with same idempotencyKey does not append duplicate message', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    const first = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '会重放',
        threadId: 'thread-1',
        deliveryMode: 'queue',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
      },
    });
    assert.equal(first.statusCode, 202);
    const firstBody = JSON.parse(first.body);

    const replay = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: '会重放',
        threadId: 'thread-1',
        deliveryMode: 'queue',
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
      },
    });
    assert.equal(replay.statusCode, 202);
    const replayBody = JSON.parse(replay.body);

    assert.equal(deps.messageStore.append.mock.calls.length, 1, 'replay should not append again');
    assert.equal(deps.invocationQueue.list('thread-1', 'user-1').length, 1, 'replay should not add a new queue row');
    assert.equal(replayBody.entryId, firstBody.entryId, 'replay should point to existing queue entry');
    assert.equal(replayBody.userMessageId, firstBody.userMessageId, 'replay should reuse original user message');
  });

  it('queue mode → same-user consecutive messages are independent entries (F175: no merge)', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    // First message
    await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '第一条', threadId: 'thread-1', deliveryMode: 'queue' },
    });

    // Second message — same user, same target → independent entry (F175)
    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '第二条', threadId: 'thread-1', deliveryMode: 'queue' },
    });

    assert.equal(res.statusCode, 202);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'queued');
    assert.equal(body.merged, false, 'F175: no merge, each message is independent');

    // Queue should have 2 separate entries
    const queue = deps.invocationQueue.list('thread-1', 'user-1');
    assert.equal(queue.length, 2);
    assert.equal(queue[0].content, '第一条');
    assert.equal(queue[1].content, '第二条');
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

    // F-parallel-cancel (cloud #6): force = scoped preempt of the TARGET invocation → cancelInvocation
    // (not cancelAll, which would also abort an unrelated side-dispatch in the same thread).
    assert.ok(
      deps.invocationTracker.cancelInvocation.mock.calls.length > 0,
      'force should cancelInvocation (scoped preempt) the active invocation',
    );

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

  it('immediate startup watchdog releases slot when routeExecution never starts provider events', async (t) => {
    t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: 0 });
    await app.close();
    deps = buildDeps({ invocationStartupWatchdogMs: 50 });
    const { messagesRoutes } = await import('../dist/routes/messages.js');
    app = Fastify();
    await app.register(messagesRoutes, deps);
    await app.ready();

    deps.invocationTracker.has.mock.mockImplementation(() => false);

    let capturedSignal;
    deps.router.routeExecution.mock.mockImplementation(
      async function* (_userId, _content, _threadId, _messageId, _cats, _intent, options) {
        capturedSignal = options.signal;
        await new Promise(() => {});
      },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '@opus', threadId: 'thread-1', deliveryMode: 'immediate' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).status, 'processing');

    t.mock.timers.tick(51);
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(capturedSignal?.aborted, true, 'watchdog should abort the stuck invocation');
    assert.equal(capturedSignal?.reason, 'startup_timeout');
    assert.ok(deps.invocationTracker.completeAll.mock.calls.length > 0, 'watchdog should release tracker slot');

    const failedUpdate = deps.invocationRecordStore.update.mock.calls.find(
      (c) => c.arguments[0] === 'inv-stub' && c.arguments[1]?.status === 'failed',
    );
    assert.ok(failedUpdate, 'watchdog should mark the invocation record failed');

    const completion = deps.queueProcessor.onInvocationComplete.mock.calls.find(
      (c) => c.arguments[0] === 'thread-1' && c.arguments[1] === 'opus' && c.arguments[2] === 'failed',
    );
    assert.ok(completion, 'watchdog should notify queue processor so queued work is not stuck');
  });

  it('default broadcast with queued leftovers but no active invocation → executes immediately', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    deps.queueProcessor = {
      isThreadBusy: mock.fn(() => true),
      isCatBusy: mock.fn(() => false),
      onInvocationComplete: mock.fn(async () => {}),
    };
    deps.invocationQueue.enqueue({
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'queued-leftover',
      source: 'user',
      targetCats: ['opus'],
      intent: 'execute',
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: 'new broadcast', threadId: 'thread-1' },
    });

    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.status, 'processing');
    assert.ok(deps.invocationRecordStore.create.mock.calls.length > 0);
    assert.equal(deps.invocationQueue.list('thread-1', 'user-1').length, 1, 'leftover queue must not grow');
  });

  it('TOCTOU degrade-to-queue replay with same idempotencyKey does not append duplicate message', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    deps.invocationTracker.tryStartThreadAll.mock.mockImplementation(() => null);

    const first = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: 'TOCTOU replay',
        threadId: 'thread-1',
        deliveryMode: 'immediate',
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
      },
    });
    assert.equal(first.statusCode, 202);
    const firstBody = JSON.parse(first.body);

    const replay = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: {
        content: 'TOCTOU replay',
        threadId: 'thread-1',
        deliveryMode: 'immediate',
        idempotencyKey: '22222222-2222-4222-8222-222222222222',
      },
    });
    assert.equal(replay.statusCode, 202);
    const replayBody = JSON.parse(replay.body);

    assert.equal(deps.messageStore.append.mock.calls.length, 1, 'replay should not append again');
    assert.equal(deps.invocationQueue.list('thread-1', 'user-1').length, 1, 'replay should not add a new queue row');
    assert.equal(replayBody.entryId, firstBody.entryId, 'replay should point to existing queue entry');
    assert.equal(replayBody.userMessageId, firstBody.userMessageId, 'replay should reuse original user message');
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

  it('immediate direct execution applies pending continuation before routeExecution', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 'thread-1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-pending',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-pending', sessionSeq: 1, reason: 'threshold' },
      },
    );
    const consumedContinuation = { threadId: 'thread-1', catId: 'opus', userId: 'user-1', capsule };
    deps.sessionContinuationCoordinator = {
      prepareInvocationContext: mock.fn(async ({ content }) => ({
        content: `CONTINUATION\n\n${content}`,
        consumedContinuation,
        sessionPolicy: 'resume',
      })),
      commitInvocationOutcome: mock.fn(async () => {}),
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '用户继续', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(deps.sessionContinuationCoordinator.prepareInvocationContext.mock.calls.length, 1);
    assert.deepEqual(deps.sessionContinuationCoordinator.prepareInvocationContext.mock.calls[0].arguments[0], {
      threadId: 'thread-1',
      catId: 'opus',
      userId: 'user-1',
      content: '用户继续',
    });
    assert.equal(deps.router.routeExecution.mock.calls[0].arguments[1], 'CONTINUATION\n\n用户继续');

    assert.equal(deps.sessionContinuationCoordinator.commitInvocationOutcome.mock.calls.length, 1);
    const commitInput = deps.sessionContinuationCoordinator.commitInvocationOutcome.mock.calls[0].arguments[0];
    assert.equal(commitInput.finalStatus, 'succeeded');
    assert.equal(commitInput.consumedContinuation, consumedContinuation);
  });

  it('immediate direct execution restores consumed continuation through coordinator on failure', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 'thread-1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-pending-fail',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-pending-fail', sessionSeq: 1, reason: 'threshold' },
      },
    );
    const consumedContinuation = { threadId: 'thread-1', catId: 'opus', userId: 'user-1', capsule };
    deps.sessionContinuationCoordinator = {
      prepareInvocationContext: mock.fn(async ({ content }) => ({
        content: `CONTINUATION\n\n${content}`,
        consumedContinuation,
        sessionPolicy: 'resume',
      })),
      commitInvocationOutcome: mock.fn(async () => {}),
    };
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      throw new Error('route failed');
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '用户继续失败', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(deps.sessionContinuationCoordinator.commitInvocationOutcome.mock.calls.length, 1);
    const commitInput = deps.sessionContinuationCoordinator.commitInvocationOutcome.mock.calls[0].arguments[0];
    assert.equal(commitInput.finalStatus, 'failed');
    assert.equal(commitInput.consumedContinuation, consumedContinuation);
  });

  it('immediate execution schedules continuation when route emits seal capsule and succeeds', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 'thread-1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-seal',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-1', sessionSeq: 1, reason: 'threshold' },
      },
    );
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      yield {
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: capsule }),
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '触发 seal', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(deps.queueProcessor.enqueueContinuation.mock.calls.length, 1);
    const call = deps.queueProcessor.enqueueContinuation.mock.calls[0].arguments[0];
    assert.equal(call.threadId, 'thread-1');
    assert.equal(call.userId, 'user-1');
    assert.equal(call.catId, 'opus');
    assert.equal(call.capsule.seal.sessionId, 'sess-1');
  });

  it('immediate success persists produced continuation even when it was already queued', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 'thread-1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-seal-queued',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-queued', sessionSeq: 1, reason: 'threshold' },
      },
    );
    deps.sessionContinuationCoordinator = {
      prepareInvocationContext: mock.fn(async ({ content }) => ({ content, sessionPolicy: 'resume' })),
      commitInvocationOutcome: mock.fn(async () => {}),
    };
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      yield {
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: capsule }),
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '触发 seal 并排队', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(deps.queueProcessor.enqueueContinuation.mock.calls.length, 1);
    assert.equal(deps.sessionContinuationCoordinator.commitInvocationOutcome.mock.calls.length, 1);
    const commitInput = deps.sessionContinuationCoordinator.commitInvocationOutcome.mock.calls[0].arguments[0];
    assert.equal(commitInput.finalStatus, 'succeeded');
    assert.deepEqual(Array.from(commitInput.producedCapsules ?? []), [capsule]);
  });

  it('immediate success does not auto-enqueue produced continuation for reborn sessions', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 'thread-1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-reborn-seal',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-reborn', sessionSeq: 1, reason: 'threshold' },
      },
    );
    deps.sessionContinuationCoordinator = {
      prepareInvocationContext: mock.fn(async ({ content }) => ({ content, sessionPolicy: 'reborn' })),
      resolveSessionStrategy: mock.fn(async () => 'reborn'),
      commitInvocationOutcome: mock.fn(async () => {}),
    };
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      yield {
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: capsule }),
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '触发 reborn seal', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((r) => setTimeout(r, 50));

    assert.deepEqual(deps.sessionContinuationCoordinator.resolveSessionStrategy.mock.calls[0].arguments, [
      'thread-1',
      'opus',
      'user-1',
    ]);
    assert.equal(deps.queueProcessor.enqueueContinuation.mock.calls.length, 0);
    assert.equal(deps.sessionContinuationCoordinator.commitInvocationOutcome.mock.calls.length, 1);
    const commitInput = deps.sessionContinuationCoordinator.commitInvocationOutcome.mock.calls[0].arguments[0];
    assert.equal(commitInput.finalStatus, 'succeeded');
    assert.deepEqual(Array.from(commitInput.producedCapsules ?? []), [capsule]);
  });

  it('immediate multi-cat execution schedules continuation for the capsule owner cat', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    deps.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['opus', 'codex'],
      intent: { intent: 'execute' },
    }));
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 'thread-1',
        catId: 'codex',
        mode: 'parallel',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-codex-seal',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-codex', sessionSeq: 1, reason: 'threshold' },
      },
    );
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      yield {
        type: 'system_info',
        catId: 'codex',
        content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: capsule }),
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '触发 codex seal', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(deps.queueProcessor.enqueueContinuation.mock.calls.length, 1);
    const call = deps.queueProcessor.enqueueContinuation.mock.calls[0].arguments[0];
    assert.equal(call.threadId, 'thread-1');
    assert.equal(call.userId, 'user-1');
    assert.equal(call.catId, 'codex');
    assert.equal(call.capsule.seal.sessionId, 'sess-codex');
  });

  it('immediate multi-cat execution schedules continuation for every sealed cat', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false);
    deps.router.resolveTargetsAndIntent.mock.mockImplementation(async () => ({
      targetCats: ['opus', 'codex'],
      intent: { intent: 'execute' },
    }));
    const opusCapsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 'thread-1',
        catId: 'opus',
        mode: 'parallel',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-opus-seal',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-opus', sessionSeq: 1, reason: 'threshold' },
      },
    );
    const codexCapsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 'thread-1',
        catId: 'codex',
        mode: 'parallel',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-codex-seal',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-codex', sessionSeq: 1, reason: 'threshold' },
      },
    );
    deps.router.routeExecution.mock.mockImplementation(async function* () {
      yield {
        type: 'system_info',
        catId: 'opus',
        content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: opusCapsule }),
        timestamp: Date.now(),
      };
      yield {
        type: 'system_info',
        catId: 'codex',
        content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: codexCapsule }),
        timestamp: Date.now(),
      };
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      yield { type: 'done', catId: 'codex', timestamp: Date.now() };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '触发多猫 seal', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    await new Promise((r) => setTimeout(r, 50));

    assert.equal(deps.queueProcessor.enqueueContinuation.mock.calls.length, 2);
    const calls = deps.queueProcessor.enqueueContinuation.mock.calls
      .map((call) => call.arguments[0])
      .sort((a, b) => a.catId.localeCompare(b.catId));
    assert.equal(calls[0].catId, 'codex');
    assert.equal(calls[0].capsule.seal.sessionId, 'sess-codex');
    assert.equal(calls[1].catId, 'opus');
    assert.equal(calls[1].capsule.seal.sessionId, 'sess-opus');
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
      deps.invocationTracker.cancelInvocation.mock.calls.length > 0,
      'multipart deliveryMode=force should cancelInvocation (scoped preempt) the active invocation',
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
      // External cancel happens here (e.g., force-send fromco-creator)
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

describe('POST /api/messages magic word instrumentation (F227 砚砚 P1 — detect→callback→messageId)', () => {
  let app;
  let deps;
  let magicWordCalls;

  beforeEach(async () => {
    magicWordCalls = [];
    deps = buildDeps({
      onMagicWordDetected: (hits, threadId, catId, messageId, ownerUserId, messageExcerpt) => {
        magicWordCalls.push({ hits, threadId, catId, messageId, ownerUserId, messageExcerpt });
      },
    });
    const { messagesRoutes } = await import('../dist/routes/messages.js');
    app = Fastify();
    await app.register(messagesRoutes, deps);
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it('fires onMagicWordDetected with the PERSISTED messageId (not guessed)', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true); // queue path

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '这个方案是脚手架，得重写', threadId: 'thread-1', deliveryMode: 'queue' },
    });
    assert.equal(res.statusCode, 202);
    const persistedMessageId = JSON.parse(res.body).userMessageId;

    // tryDetectMagicWords is fire-and-forget (async dynamic import) — let it settle.
    await new Promise((r) => setTimeout(r, 80));

    assert.equal(magicWordCalls.length, 1, 'callback should fire exactly once');
    const call = magicWordCalls[0];
    assert.equal(call.hits[0].word, '脚手架');
    assert.equal(call.threadId, 'thread-1');
    // The whole point of the instrumentation-gap fix: messageId === persisted user message id
    assert.equal(call.messageId, persistedMessageId);
    assert.equal(call.ownerUserId, 'user-1', 'F227 P1: owner = the authenticated sender (queued path)');
    assert.ok(call.messageExcerpt?.includes('脚手架'), 'excerpt carries 原话 context');
  });

  it('does not fire the callback when the message has no magic word', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => true);

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '普通消息，没有触发词', threadId: 'thread-1', deliveryMode: 'queue' },
    });
    assert.equal(res.statusCode, 202);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(magicWordCalls.length, 0);
  });

  it('fires on the IMMEDIATE path too with the persisted messageId (砚砚 R2 P1: both paths)', async () => {
    deps.invocationTracker.has.mock.mockImplementation(() => false); // immediate path (no active invocation)

    const res = await app.inject({
      method: 'POST',
      url: '/api/messages',
      headers: { 'x-cat-cafe-user': 'user-1', 'content-type': 'application/json' },
      payload: { content: '这个直接重写吧，脚手架', threadId: 'thread-1', deliveryMode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);
    const persistedMessageId = JSON.parse(res.body).userMessageId;

    await new Promise((r) => setTimeout(r, 80));

    assert.equal(magicWordCalls.length, 1, 'immediate path should also fire the callback');
    assert.equal(magicWordCalls[0].hits[0].word, '脚手架');
    assert.equal(magicWordCalls[0].messageId, persistedMessageId);
    assert.equal(magicWordCalls[0].ownerUserId, 'user-1', 'F227 P1: owner = the authenticated sender (immediate path)');
  });
});
