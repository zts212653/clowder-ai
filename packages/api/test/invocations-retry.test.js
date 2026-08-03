/**
 * Invocations Retry Tests (ADR-008 S2)
 * POST /api/invocations/:id/retry — 实际执行 retry 全路径
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationTracker } from '../dist/domains/cats/services/agents/invocation/InvocationTracker.js';
import { QueueProcessor } from '../dist/domains/cats/services/agents/invocation/QueueProcessor.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { invocationsRoutes } from '../dist/routes/invocations.js';

/** Stub AgentRouter: routeExecution yields one visible turn and its terminal success witness. */
function createMockRouter(options = {}) {
  const { shouldThrow } = options;
  const routeOptions = [];
  return {
    routeOptions,
    routeExecution: async function* (_userId, _msg, _threadId, _userMsgId, _cats, _intent, opts) {
      routeOptions.push(opts);
      if (shouldThrow) {
        throw new Error('Agent execution failed');
      }
      yield { type: 'text', catId: 'opus', content: 'retry response', timestamp: Date.now() };
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
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
async function setupRetryScenario(routerOverride, trackerOverride, queueProcessorOverride) {
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
    actionLeaseCarrier: { kind: 'none' },
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
    ...(queueProcessorOverride ? { queueProcessor: queueProcessorOverride } : {}),
  });
  await app.ready();

  return { app, invocationRecordStore, messageStore, socketManager, router, invocationId: createResult.invocationId };
}

describe('POST /api/invocations/:id/retry (ADR-008 S2)', () => {
  it('retry failed → 202 + record transitions running→succeeded', async () => {
    const { app, invocationRecordStore, router, invocationId } = await setupRetryScenario();

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
    assert.equal(router.routeOptions[0]?.humanDispositionInvocationOrigin, 'direct_owner');
  });

  it('retry acquires its replacement through QueueProcessor joint ownership', async () => {
    const tracker = new InvocationTracker();
    const acquireCalls = [];
    const queueProcessor = {
      acquireExternalExecution(threadId, catIds, userId, options) {
        acquireCalls.push([threadId, catIds, userId, options]);
        return tracker.startAll(threadId, catIds, userId, options.executionId);
      },
      onInvocationComplete: async () => {},
    };
    const { app, invocationId } = await setupRetryScenario(undefined, tracker, queueProcessor);

    const res = await app.inject({ method: 'POST', url: `/api/invocations/${invocationId}/retry` });

    assert.equal(res.statusCode, 202);
    assert.deepEqual(acquireCalls, [
      ['thread-1', ['opus'], 'user-1', { mode: 'replacement', executionId: invocationId }],
    ]);
  });

  it('retry claim loss preserves the queued pre-start reservation', async () => {
    const tracker = new InvocationTracker();
    const queueProcessor = new QueueProcessor({
      invocationTracker: tracker,
      log: { info() {}, warn() {}, error() {} },
    });
    const slotKey = JSON.stringify(['thread-1', 'opus']);
    const queuedReservation = {
      startedAt: Date.now(),
      entryId: 'queued-entry',
      userId: 'user-1',
    };
    queueProcessor.processingSlots.set(slotKey, queuedReservation);

    const { app, invocationRecordStore, invocationId } = await setupRetryScenario(undefined, tracker, queueProcessor);
    const originalUpdate = invocationRecordStore.update.bind(invocationRecordStore);
    invocationRecordStore.update = async (id, data) => {
      if (data.expectedStatus) return null;
      return originalUpdate(id, data);
    };

    const res = await app.inject({ method: 'POST', url: `/api/invocations/${invocationId}/retry` });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'INVOCATION_NOT_RETRYABLE');
    assert.equal(
      queueProcessor.processingSlots.get(slotKey),
      queuedReservation,
      'a retry that loses the durable claim must not retire unrelated queued ownership',
    );
    assert.equal(tracker.has('thread-1', 'opus'), false);
    await app.close();
  });

  it('retry ownership refusal restores an originally failed durable claim', async () => {
    const queueProcessor = {
      acquireExternalExecution() {
        return null;
      },
    };
    const { app, invocationRecordStore, invocationId } = await setupRetryScenario(undefined, undefined, queueProcessor);

    const res = await app.inject({ method: 'POST', url: `/api/invocations/${invocationId}/retry` });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'INVOCATION_OWNER_CHANGED');
    const record = invocationRecordStore.get(invocationId);
    assert.equal(record.status, 'failed');
    assert.equal(record.error, 'CLI timeout');
    await app.close();
  });

  it('retry ownership refusal re-reads and retries a transient rollback miss', async () => {
    const queueProcessor = {
      acquireExternalExecution() {
        return null;
      },
    };
    const { app, invocationRecordStore, invocationId } = await setupRetryScenario(undefined, undefined, queueProcessor);
    const originalUpdate = invocationRecordStore.update.bind(invocationRecordStore);
    let rollbackAttempts = 0;
    invocationRecordStore.update = async (id, data) => {
      if (data.expectedStatus === 'running' && data.status === 'failed') {
        rollbackAttempts += 1;
        if (rollbackAttempts === 1) return null;
      }
      return originalUpdate(id, data);
    };

    const res = await app.inject({ method: 'POST', url: `/api/invocations/${invocationId}/retry` });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'INVOCATION_OWNER_CHANGED');
    assert.equal(rollbackAttempts, 2, 'a still-running claim must be terminalized after a transient CAS miss');
    const record = invocationRecordStore.get(invocationId);
    assert.equal(record.status, 'failed');
    assert.equal(record.error, 'CLI timeout');
    await app.close();
  });

  it('F254 D1.2b: retry clears stale read evidence before reusing the retry id for handled closure', async () => {
    const completionCalls = [];
    const clearCalls = [];
    const queueProcessor = {
      hasQueuedNonAgentForThread: () => false,
      getQueuedFreshnessMessagesForCat: () => [],
      hasActiveOrQueuedAgentForCat: () => false,
      hasPendingForCat: () => false,
      enqueueRaw: () => ({ ok: true }),
      clearQueuedSeenInvocationForCats: (...args) => {
        clearCalls.push(args);
        return 1;
      },
      onInvocationComplete: async (...args) => {
        completionCalls.push(args);
      },
    };
    const router = createMockRouter();
    router.routeExecution = async function* () {
      assert.equal(
        clearCalls.length,
        1,
        'stale retry evidence must be cleared before provider execution can read queue',
      );
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    };

    const { app, invocationRecordStore, invocationId } = await setupRetryScenario(router, undefined, queueProcessor);

    const res = await app.inject({
      method: 'POST',
      url: `/api/invocations/${invocationId}/retry`,
    });

    assert.equal(res.statusCode, 202);
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(completionCalls.length, 1);
    assert.deepEqual(clearCalls, [['thread-1', ['opus'], invocationId]]);
    assert.deepEqual(
      completionCalls[0],
      ['thread-1', 'opus', 'succeeded', invocationId, ['opus']],
      'retry clears stale seen evidence before running, then uses the retry record id for current-attempt reads',
    );
    assert.deepEqual(invocationRecordStore.get(invocationId).successfulCatIds, ['opus']);
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

  it('passes an authoritative A2A slot claim and durable deferral into retry execution', async () => {
    const tracker = new InvocationTracker();
    const queue = new InvocationQueue();
    let observedClaim;
    const router = createMockRouter();
    router.routeExecution = async function* (_userId, _msg, threadId, _userMsgId, _cats, _intent, options) {
      tracker.startAll(threadId, ['codex'], 'external-owner', 'external-codex');
      observedClaim = options.trackA2ASlot(threadId, 'codex', 'user-1', options.invocationController);
      const enqueue = options.deferA2AEnqueue({
        threadId,
        userId: 'user-1',
        content: '@codex review complete',
        source: 'agent',
        sourceCategory: 'a2a',
        targetCats: ['codex'],
        callerCatId: 'opus',
        messageId: 'msg-retry-handoff',
        a2aTriggerMessageId: 'msg-retry-handoff',
        autoExecute: true,
        priority: 'normal',
        intent: 'execute',
      });
      assert.equal(enqueue.outcome, 'enqueued');
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    };
    const queueProcessor = {
      enqueueRaw: (entry) => queue.enqueue(entry),
      hasQueuedNonAgentForThread: () => false,
      getQueuedFreshnessMessagesForCat: () => [],
      hasActiveOrQueuedAgentForCat: () => false,
      hasPendingForCat: () => false,
      clearQueuedSeenInvocationForCats: () => {},
      markPromptMessagesSeen: async () => {},
      onInvocationComplete: async () => {},
    };
    const { app, invocationId } = await setupRetryScenario(router, tracker, queueProcessor);

    const res = await app.inject({ method: 'POST', url: `/api/invocations/${invocationId}/retry` });
    assert.equal(res.statusCode, 202);
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(observedClaim, false, 'external Codex owner must reject inline retry A2A execution');
    const deferred = queue.list('thread-1', 'user-1');
    assert.equal(deferred.length, 1);
    assert.deepEqual(deferred[0].targetCats, ['codex']);
    assert.equal(deferred[0].messageId, 'msg-retry-handoff');
    assert.equal(deferred[0].ownerAuthProvenance, 'compatibility_fallback');
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
      actionLeaseCarrier: { kind: 'none' },
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
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
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
      actionLeaseCarrier: { kind: 'none' },
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
      actionLeaseCarrier: { kind: 'none' },
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
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
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
      actionLeaseCarrier: { kind: 'none' },
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
