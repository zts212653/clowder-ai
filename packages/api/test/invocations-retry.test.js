/**
 * Invocations Retry Tests (ADR-008 S2)
 * POST /api/invocations/:id/retry — 实际执行 retry 全路径
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { invocationsRoutes } from '../dist/routes/invocations.js';

/** Stub AgentRouter: routeExecution yields one text message then returns */
function createMockRouter(options = {}) {
  const { shouldThrow } = options;
  return {
    routeExecution: async function* (_userId, _msg, _threadId, _userMsgId, _cats, _intent, _opts) {
      if (shouldThrow) {
        throw new Error('Agent execution failed');
      }
      yield { type: 'text', catId: 'opus', content: 'retry response', timestamp: Date.now() };
    },
    resolveTargetsAndIntent: async () => ({
      targetCats: ['opus'],
      intent: { intent: 'execute', explicit: false, promptTags: [] },
    }),
    ackCollectedCursors: async () => {},
  };
}

/** Stub SocketManager: records broadcasts for assertions */
function createMockSocketManager() {
  const messages = [];
  return {
    broadcastAgentMessage(msg, threadId) {
      messages.push({ type: 'agent', msg, threadId });
    },
    broadcastToRoom(room, event, data) {
      messages.push({ type: 'room', room, event, data });
    },
    getMessages() {
      return messages;
    },
  };
}

/**
 * Helper: set up a Fastify app with invocationsRoutes + a 'failed' InvocationRecord
 * that has a stored user message linked to it.
 */
async function setupRetryScenario(routerOverride, trackerOverride) {
  const invocationRecordStore = new InvocationRecordStore();
  const messageStore = new MessageStore();
  const invocationTracker = trackerOverride ?? new InvocationTracker();
  const socketManager = createMockSocketManager();
  const router = routerOverride ?? createMockRouter();

  // Pre-populate: store a user message and create a failed invocation record
  const storedMsg = messageStore.append({
    userId: 'user-1',
    catId: null,
    content: '@布偶猫 hello retry',
    mentions: ['opus'],
    timestamp: Date.now(),
    threadId: 'thread-1',
  });

  const createResult = invocationRecordStore.create({
    threadId: 'thread-1',
    userId: 'user-1',
    targetCats: ['opus'],
    intent: 'execute',
    idempotencyKey: 'key-retry-1',
  });
  // Backfill userMessageId + transition through proper lifecycle: queued → running → failed
  invocationRecordStore.update(createResult.invocationId, {
    userMessageId: storedMsg.id,
    status: 'running',
  });
  invocationRecordStore.update(createResult.invocationId, {
    status: 'failed',
    error: 'CLI timeout',
  });

  const app = Fastify();
  await app.register(invocationsRoutes, {
    invocationRecordStore,
    messageStore,
    socketManager,
    router,
    invocationTracker,
  });
  await app.ready();

  return { app, invocationRecordStore, messageStore, socketManager, invocationId: createResult.invocationId };
}

describe('POST /api/invocations/:id/retry (ADR-008 S2)', () => {
  it('retry failed → 202 + record transitions running→succeeded', async () => {
    const { app, invocationRecordStore, invocationId } = await setupRetryScenario();

    const res = await app.inject({
      method: 'POST',
      url: `/api/invocations/${invocationId}/retry`,
    });

    assert.equal(res.statusCode, 202);
    const body = res.json();
    assert.equal(body.status, 'retrying');
    assert.equal(body.invocationId, invocationId);

    // Wait for background execution to complete
    await new Promise((r) => setTimeout(r, 100));

    const record = invocationRecordStore.get(invocationId);
    assert.equal(record.status, 'succeeded');
  });

  it('cloud-#7: retry passes signalForCat (startAll caller parity — per-cat cancel observable)', async () => {
    // After the batchController split, controller.signal is the batch gate; a single-cat cancel
    // aborts only that cat's slot controller. The retry path must pass signalForCat so the route
    // observes per-cat signals (mirrors messages.ts / QueueProcessor), else a Stop on one cat of a
    // retried multi-cat invocation is ignored until cancel-all.
    let capturedOpts = null;
    const router = createMockRouter();
    const origRoute = router.routeExecution;
    router.routeExecution = async function* (...args) {
      capturedOpts = args[6]; // 7th positional arg = route options
      yield* origRoute(...args);
    };
    const { app, invocationId } = await setupRetryScenario(router);

    const res = await app.inject({ method: 'POST', url: `/api/invocations/${invocationId}/retry` });
    assert.equal(res.statusCode, 202);
    await new Promise((r) => setTimeout(r, 100));

    assert.ok(capturedOpts, 'routeExecution was invoked');
    assert.equal(typeof capturedOpts.signalForCat, 'function', 'retry path passes signalForCat (cloud #7)');
  });

  it('cloud-#7: retry resolves canceled (not succeeded) when the target cat is cancelled mid-run', async () => {
    // A single-cat cancel no longer aborts the batch gate, so the retry path must use the aggregate
    // resolveFinalStatus (per-cat tombstones) — otherwise a user_cancel is wrongly marked succeeded.
    const tracker = new InvocationTracker();
    const router = createMockRouter();
    router.routeExecution = async function* (_userId, _msg, threadId, _userMsgId, _cats, _intent, _opts) {
      // simulate user clicking Stop on opus mid-run (single-cat cancel, NOT cancelAll)
      tracker.cancel(threadId, 'opus', undefined, 'user_cancel');
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    };
    const { app, invocationRecordStore, invocationId } = await setupRetryScenario(router, tracker);

    const res = await app.inject({ method: 'POST', url: `/api/invocations/${invocationId}/retry` });
    assert.equal(res.statusCode, 202);
    await new Promise((r) => setTimeout(r, 100));

    const record = invocationRecordStore.get(invocationId);
    assert.equal(
      record.status,
      'canceled',
      'single-cat cancel → canceled via resolveFinalStatus, not succeeded (cloud #7)',
    );
  });

  it('retry queued → 202 + normal execution', async () => {
    const invocationRecordStore = new InvocationRecordStore();
    const messageStore = new MessageStore();
    const socketManager = createMockSocketManager();
    const router = createMockRouter();
    const invocationTracker = new InvocationTracker();

    const storedMsg = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '@布偶猫 queued msg',
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: 'thread-q',
    });

    const createResult = invocationRecordStore.create({
      threadId: 'thread-q',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'key-q',
    });
    // Backfill userMessageId, status stays 'queued'
    invocationRecordStore.update(createResult.invocationId, {
      userMessageId: storedMsg.id,
    });

    const app = Fastify();
    await app.register(invocationsRoutes, {
      invocationRecordStore,
      messageStore,
      socketManager,
      router,
      invocationTracker,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: `/api/invocations/${createResult.invocationId}/retry`,
    });
    assert.equal(res.statusCode, 202);

    await new Promise((r) => setTimeout(r, 100));
    const record = invocationRecordStore.get(createResult.invocationId);
    assert.equal(record.status, 'succeeded');
  });

  it('concurrent retry on same invocation should accept only one request', async () => {
    const invocationRecordStore = new InvocationRecordStore();
    const messageStore = new MessageStore();
    const socketManager = createMockSocketManager();
    const invocationTracker = new InvocationTracker();

    // Slow router keeps background execution in-flight to expose retry race.
    const slowRouter = {
      routeExecution: async function* () {
        await new Promise((r) => setTimeout(r, 150));
        yield { type: 'text', catId: 'opus', content: 'slow retry', timestamp: Date.now() };
      },
      resolveTargetsAndIntent: async () => ({
        targetCats: ['opus'],
        intent: { intent: 'execute', explicit: false, promptTags: [] },
      }),
      ackCollectedCursors: async () => {},
    };

    const storedMsg = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '@布偶猫 retry race',
      mentions: ['opus'],
      timestamp: Date.now(),
      threadId: 'thread-race',
    });

    const createResult = invocationRecordStore.create({
      threadId: 'thread-race',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'key-race',
    });
    invocationRecordStore.update(createResult.invocationId, {
      userMessageId: storedMsg.id,
      status: 'running',
    });
    invocationRecordStore.update(createResult.invocationId, {
      status: 'failed',
      error: 'previous failure',
    });

    const app = Fastify();
    await app.register(invocationsRoutes, {
      invocationRecordStore,
      messageStore,
      socketManager,
      router: slowRouter,
      invocationTracker,
    });
    await app.ready();

    const [r1, r2] = await Promise.all([
      app.inject({ method: 'POST', url: `/api/invocations/${createResult.invocationId}/retry` }),
      app.inject({ method: 'POST', url: `/api/invocations/${createResult.invocationId}/retry` }),
    ]);

    const statuses = [r1.statusCode, r2.statusCode].sort((a, b) => a - b);
    assert.deepEqual(statuses, [202, 409]);

    const conflict = r1.statusCode === 409 ? r1 : r2;
    const conflictBody = conflict.json();
    assert.equal(conflictBody.code, 'INVOCATION_NOT_RETRYABLE');

    await app.close();
  });

  it('retry running → 409 NOT_RETRYABLE', async () => {
    const { app, invocationRecordStore, invocationId } = await setupRetryScenario();

    // Set status to running
    invocationRecordStore.update(invocationId, { status: 'running' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/invocations/${invocationId}/retry`,
    });

    assert.equal(res.statusCode, 409);
    const body = res.json();
    assert.equal(body.code, 'INVOCATION_NOT_RETRYABLE');
    assert.equal(body.currentStatus, 'running');
  });

  it('retry succeeded → 409 NOT_RETRYABLE', async () => {
    const { app, invocationRecordStore, invocationId } = await setupRetryScenario();

    // failed → running → succeeded (proper lifecycle)
    invocationRecordStore.update(invocationId, { status: 'running' });
    invocationRecordStore.update(invocationId, { status: 'succeeded' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/invocations/${invocationId}/retry`,
    });

    assert.equal(res.statusCode, 409);
    const body = res.json();
    assert.equal(body.code, 'INVOCATION_NOT_RETRYABLE');
  });

  it('retry with userMessageId=null → 400 USER_MESSAGE_NOT_SAVED', async () => {
    const invocationRecordStore = new InvocationRecordStore();
    const messageStore = new MessageStore();
    const socketManager = createMockSocketManager();
    const router = createMockRouter();
    const invocationTracker = new InvocationTracker();

    // Create record but do NOT backfill userMessageId
    const createResult = invocationRecordStore.create({
      threadId: 'thread-null',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'key-null',
    });
    // Transition through proper lifecycle without backfilling userMessageId
    invocationRecordStore.update(createResult.invocationId, { status: 'running' });
    invocationRecordStore.update(createResult.invocationId, { status: 'failed' });

    const app = Fastify();
    await app.register(invocationsRoutes, {
      invocationRecordStore,
      messageStore,
      socketManager,
      router,
      invocationTracker,
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: `/api/invocations/${createResult.invocationId}/retry`,
    });

    assert.equal(res.statusCode, 400);
    const body = res.json();
    assert.equal(body.code, 'USER_MESSAGE_NOT_SAVED');
  });

  it('post-success ackCollectedCursors failure → record status=failed (not succeeded)', async () => {
    // P1 regression: if ackCollectedCursors throws after succeeded write,
    // the state machine guard blocks succeeded→failed, leaving record as succeeded.
    const ackFailRouter = {
      routeExecution: async function* (_u, _m, _t, _mid, _cats, _intent, _opts) {
        yield { type: 'text', catId: 'opus', content: 'ok', timestamp: Date.now() };
      },
      resolveTargetsAndIntent: async () => ({
        targetCats: ['opus'],
        intent: { intent: 'execute', explicit: false, promptTags: [] },
      }),
      ackCollectedCursors: async () => {
        throw new Error('ack cursor failure');
      },
    };

    const { app, invocationRecordStore, invocationId } = await setupRetryScenario(ackFailRouter);

    const res = await app.inject({
      method: 'POST',
      url: `/api/invocations/${invocationId}/retry`,
    });
    assert.equal(res.statusCode, 202);

    // Wait for background execution
    await new Promise((r) => setTimeout(r, 150));

    const record = invocationRecordStore.get(invocationId);
    // Must be 'failed', not 'succeeded' — the ack step threw
    assert.equal(record.status, 'failed', 'record should be failed when ackCollectedCursors throws');
    assert.match(record.error, /ack cursor failure/);
  });

  it('pre-start failure: queued→failed when running update throws', async () => {
    // P2 regression: if update(status: 'running') throws inside try block,
    // the catch tries queued→failed which the state machine must allow.
    const invocationRecordStore = new InvocationRecordStore();
    const createResult = invocationRecordStore.create({
      threadId: 'thread-prestart',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'key-prestart',
    });

    // Directly test: queued→failed should succeed (pre-start failure path)
    const updated = invocationRecordStore.update(createResult.invocationId, {
      status: 'failed',
      error: 'Redis connection refused before execution started',
    });
    assert.ok(updated, 'queued→failed should be allowed for pre-start failures');
    assert.equal(updated.status, 'failed');
    assert.match(updated.error, /Redis connection refused/);
  });

  it('retry nonexistent id → 404', async () => {
    const { app } = await setupRetryScenario();

    const res = await app.inject({
      method: 'POST',
      url: '/api/invocations/nonexistent-id/retry',
    });

    assert.equal(res.statusCode, 404);
    const body = res.json();
    assert.equal(body.code, 'INVOCATION_NOT_FOUND');
  });

  it('retry during thread delete → 409 THREAD_DELETING', async () => {
    const tracker = new InvocationTracker();
    const { app, invocationId } = await setupRetryScenario(undefined, tracker);

    // Now set thread to deleting
    const guard = tracker.guardDelete('thread-1');
    assert.ok(guard.acquired);

    const res = await app.inject({
      method: 'POST',
      url: `/api/invocations/${invocationId}/retry`,
    });

    assert.equal(res.statusCode, 409);
    const body = res.json();
    assert.equal(body.code, 'THREAD_DELETING');

    guard.release();
  });

  it('retry execution failure → record status=failed with error', async () => {
    const errorRouter = createMockRouter({ shouldThrow: true });
    const { app, invocationRecordStore, invocationId } = await setupRetryScenario(errorRouter);

    const res = await app.inject({
      method: 'POST',
      url: `/api/invocations/${invocationId}/retry`,
    });

    assert.equal(res.statusCode, 202);

    // Wait for background execution to fail
    await new Promise((r) => setTimeout(r, 100));

    const record = invocationRecordStore.get(invocationId);
    assert.equal(record.status, 'failed');
    assert.equal(record.error, 'Agent execution failed');
  });

  it('retry success should clear previous error', async () => {
    const { app, invocationRecordStore, invocationId } = await setupRetryScenario();

    const res = await app.inject({
      method: 'POST',
      url: `/api/invocations/${invocationId}/retry`,
    });

    assert.equal(res.statusCode, 202);

    await new Promise((r) => setTimeout(r, 100));

    const record = invocationRecordStore.get(invocationId);
    assert.equal(record.status, 'succeeded');
    assert.equal(record.error ?? '', '');

    await app.close();
  });
});

describe('MessageStore.getById()', () => {
  it('returns message when found', async () => {
    const store = new MessageStore();
    const msg = store.append({
      userId: 'user-1',
      catId: null,
      content: 'test message',
      mentions: [],
      timestamp: Date.now(),
    });

    const found = store.getById(msg.id);
    assert.ok(found);
    assert.equal(found.id, msg.id);
    assert.equal(found.content, 'test message');
  });

  it('returns null when not found', async () => {
    const store = new MessageStore();
    const found = store.getById('nonexistent-id');
    assert.equal(found, null);
  });
});
