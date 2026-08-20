/**
 * Queue Management API tests (F39 Task 4)
 * Tests: GET/DELETE/POST/PATCH queue endpoints with auth + isolation.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');

async function terminalizeFixtureCarrier(deps, queueProcessor, carrier, userId, threadId) {
  if ((await queueProcessor.finalizeRemovedEntry(carrier, 'user_cancel')) === false) return false;
  for (const messageId of [carrier.messageId, ...carrier.mergedMessageIds].filter(Boolean)) {
    try {
      const canceled = await deps.messageStore.markCanceled(messageId);
      if (canceled?.deliveryTransitioned === true) {
        deps.socketManager.emitToUser(userId, 'message_deleted', { messageId, threadId, deletedBy: userId });
      }
    } catch {
      return false;
    }
  }
  try {
    await deps.queueCustodyCoordinator.withdrawEntry(carrier);
    return true;
  } catch {
    return false;
  }
}

/** Build deps with stubs */
function buildDeps(overrides = {}) {
  const invocationQueue = new InvocationQueue();
  let deps;
  const queueProcessor = {
    canReleaseSlotForUser: mock.fn(() => true),
    processNext: mock.fn(async () => ({ started: false })),
    isPaused: mock.fn(() => false),
    getPauseReason: mock.fn(() => undefined),
    clearPause: mock.fn(() => {}),
    releaseSlot: mock.fn(() => {}),
    releaseThread: mock.fn(() => {}),
    finalizeRemovedEntry: mock.fn(async () => true),
  };
  queueProcessor.processExactSteerReservation = mock.fn(async (threadId, userId) =>
    queueProcessor.processNext(threadId, userId),
  );
  const managedCommandWakeRecovery = {
    retireCarrier: mock.fn(async () => 0),
    retireThread: mock.fn(async () => ({ retired: 0, messageIds: [] })),
  };
  deps = {
    threadStore: {
      get: mock.fn(async (id) => ({
        id,
        title: 'Test Thread',
        createdBy: 'system', // default: public thread
      })),
    },
    invocationQueue,
    queueProcessor,
    invocationTracker: {
      has: mock.fn(() => false),
      getUserId: mock.fn(() => null),
      getExecutionId: mock.fn(() => undefined),
      cancel: mock.fn(() => ({ cancelled: false, catIds: [] })),
      getActiveSlots: mock.fn(() => []),
    },
    resolveCarrierCapability: mock.fn(() => ({
      provider: 'openai_codex',
      carrier: 'codex_app_server',
      deliverySemantics: 'exact_active_turn',
    })),
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    messageStore: {
      markCanceled: mock.fn(async () => ({ deliveryStatus: 'canceled', deliveryTransitioned: true })),
      getById: mock.fn(async () => null),
    },
    queueCustodyCoordinator: {
      persistEntry: mock.fn(async () => {}),
      withdrawEntry: mock.fn(async () => true),
      findReminderAttempt: mock.fn(async () => undefined),
      requestReminder: mock.fn(async () => true),
    },
    agentSessionMutex: {
      forceReleaseByScope: mock.fn(() => ({ releasedHolders: 0, rejectedWaiters: 0, catIds: [] })),
    },
    managedCommandWakeRecovery,
    getManagedCommandWakeRecovery: () => managedCommandWakeRecovery,
    ...overrides,
  };
  queueProcessor.retirePrestartProcessingGroup = mock.fn(async (threadId, _catId, userId) => {
    const inflight = invocationQueue.findProcessingByCat(threadId, _catId);
    if (!inflight || inflight.userId !== userId) return 'state_changed';
    const carriers = invocationQueue.getProcessingGroupAcrossUsers(threadId, inflight.id);
    if (!carriers) return 'state_changed';
    for (const carrier of carriers) {
      if (!(await terminalizeFixtureCarrier(deps, queueProcessor, carrier, userId, threadId))) {
        return 'terminalization_failed';
      }
    }
    return invocationQueue.removeProcessingGroupAcrossUsers(threadId, inflight.id) ? 'retired' : 'state_changed';
  });
  return deps;
}

/** Enqueue a test entry */
function enqueueEntry(queue, overrides = {}) {
  return queue.enqueue({
    threadId: 't1',
    userId: 'user-a',
    content: 'hello',
    source: 'user',
    ownerAuthProvenance: 'unknown',
    targetCats: ['opus'],
    intent: 'execute',
    ...overrides,
  });
}

function asyncGate() {
  let enter;
  let release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  return { entered, blocked, enter, release };
}

describe('Queue Management API', () => {
  let app;
  let deps;

  beforeEach(async () => {
    deps = buildDeps();
    const { queueRoutes } = await import('../dist/routes/queue.js');
    app = Fastify();
    await app.register(queueRoutes, deps);
    await app.ready();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  // ── Auth ──

  it('returns 401 when userId header missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
    });
    assert.equal(res.statusCode, 401);
  });

  it('returns 404 when thread not found', async () => {
    deps.threadStore.get.mock.mockImplementation(async () => null);
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('returns 403 when userId does not match thread owner', async () => {
    deps.threadStore.get.mock.mockImplementation(async () => ({
      id: 't1',
      title: 'Private',
      createdBy: 'user-b', // not system, not user-a
    }));
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(res.statusCode, 403);
  });

  it('allows access when createdBy is system (default thread)', async () => {
    // Default: createdBy='system' — any user can access
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(res.statusCode, 200);
  });

  // ── User isolation (scopeKey) ──

  it('GET /queue returns only requesting user entries', async () => {
    enqueueEntry(deps.invocationQueue, { userId: 'user-a', content: 'a msg' });
    enqueueEntry(deps.invocationQueue, { userId: 'user-b', content: 'b msg', targetCats: ['codex'] });

    // user-a sees only their entry
    const resA = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const bodyA = JSON.parse(resA.body);
    assert.equal(bodyA.queue.length, 1);
    assert.equal(bodyA.queue[0].content, 'a msg');

    // user-b sees only their entry
    const resB = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-b' },
    });
    const bodyB = JSON.parse(resB.body);
    assert.equal(bodyB.queue.length, 1);
    assert.equal(bodyB.queue[0].content, 'b msg');
  });

  it('GET /queue hydrates independent per-target read states for F5', async () => {
    const queued = enqueueEntry(deps.invocationQueue, {
      content: 'two targets',
      targetCats: ['opus', 'codex'],
      messageId: 'msg-1',
    });
    deps.invocationQueue.markQueuedSeen('t1', 'user-a', queued.entry.id, 'opus', 'inv-opus');

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(body.queue[0].targetStates, {
      opus: 'seen',
      codex: 'queued',
    });
  });

  it('GET /queue projects the exact provider carrier for each active target', async () => {
    deps.invocationTracker.getActiveSlots.mock.mockImplementation(() => [{ catId: 'opus', startedAt: 100 }]);
    deps.invocationTracker.getUserId.mock.mockImplementation(() => 'user-a');
    deps.invocationTracker.getExecutionId.mock.mockImplementation(() => 'inv-active');

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);

    assert.deepEqual(body.activeInvocations[0].freshnessCarrierCapability, {
      provider: 'openai_codex',
      carrier: 'codex_app_server',
      deliverySemantics: 'exact_active_turn',
    });
  });

  it('GET /queue hydrates notified, failed, and partially handled targets independently', async () => {
    const queued = enqueueEntry(deps.invocationQueue, {
      content: 'three targets',
      targetCats: ['opus', 'codex', 'gpt52'],
      messageId: 'msg-1',
    });
    deps.invocationQueue.markQueuedNotified('t1', 'user-a', queued.entry.id, 'opus');
    deps.invocationQueue.markQueuedSeen('t1', 'user-a', queued.entry.id, 'codex', 'inv-codex');
    deps.invocationQueue.markQueuedFailedForCatAcrossUsers('t1', 'codex', 'inv-codex');
    deps.invocationQueue.markQueuedSeen('t1', 'user-a', queued.entry.id, 'gpt52', 'inv-gpt52');
    deps.invocationQueue.markQueuedHandledForCatAcrossUsers('t1', 'gpt52', 'inv-gpt52');

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(body.queue[0].targetStates, {
      opus: 'notified',
      codex: 'failed',
      gpt52: 'handled',
    });
    assert.deepEqual(body.queue[0].targetCats, ['opus', 'codex'], 'handled target must not be scheduled again');
  });

  it('DELETE /queue/:entryId returns 404 for another user entry', async () => {
    const r = enqueueEntry(deps.invocationQueue, { userId: 'user-a' });
    // user-b tries to delete user-a's entry
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/threads/t1/queue/${r.entry.id}`,
      headers: { 'x-cat-cafe-user': 'user-b' },
    });
    assert.equal(res.statusCode, 404);
  });

  it('DELETE /queue clears only requesting user entries', async () => {
    enqueueEntry(deps.invocationQueue, { userId: 'user-a', targetCats: ['a'] });
    enqueueEntry(deps.invocationQueue, { userId: 'user-a', targetCats: ['b'] });
    enqueueEntry(deps.invocationQueue, { userId: 'user-b', targetCats: ['c'] });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.cleared.length, 2);

    // user-b's entry unaffected
    assert.equal(deps.invocationQueue.list('t1', 'user-b').length, 1);
  });

  it('POST /queue/next only processes requesting user queue', async () => {
    enqueueEntry(deps.invocationQueue, { userId: 'user-a' });
    enqueueEntry(deps.invocationQueue, { userId: 'user-b', targetCats: ['codex'] });

    deps.queueProcessor.processNext.mock.mockImplementation(async (_threadId, userId) => {
      // Simulate processing user's queue
      return { started: true, entry: { userId } };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/t1/queue/next',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.started, true);

    // Verify processNext was called with user-a
    const call = deps.queueProcessor.processNext.mock.calls[0];
    assert.equal(call.arguments[0], 't1');
    assert.equal(call.arguments[1], 'user-a');
  });

  it('POST /queue/:entryId/remind persists a non-interrupting attempt for the exact active invocation', async () => {
    const queued = enqueueEntry(deps.invocationQueue, { targetCats: ['opus'] });
    deps.invocationTracker.has.mock.mockImplementation(() => true);
    deps.invocationTracker.getUserId.mock.mockImplementation(() => 'user-a');
    deps.invocationTracker.getExecutionId.mock.mockImplementation(() => 'inv-active');

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/remind`,
      headers: { 'x-cat-cafe-user': 'user-a' },
      payload: { targetCatId: 'opus' },
    });
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 200);
    assert.equal(body.state, 'requested');
    assert.equal(body.invocationId, 'inv-active');
    const call = deps.queueCustodyCoordinator.requestReminder.mock.calls[0];
    assert.equal(call.arguments[0].id, queued.entry.id);
    assert.equal(call.arguments[1], 'opus');
    assert.equal(call.arguments[2], 'inv-active');
    assert.equal(typeof call.arguments[3], 'string');
    assert.equal(deps.invocationTracker.cancel.mock.calls.length, 0, 'remind must never interrupt current work');
    assert.equal(deps.queueProcessor.processNext.mock.calls.length, 0, 'remind must never spawn or reorder work');
  });

  it('POST /queue/:entryId/remind refuses to invent delivery when no invocation is active', async () => {
    const queued = enqueueEntry(deps.invocationQueue, { targetCats: ['opus'] });
    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/remind`,
      headers: { 'x-cat-cafe-user': 'user-a' },
      payload: { targetCatId: 'opus' },
    });

    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).code, 'NO_ACTIVE_INVOCATION');
    assert.equal(deps.queueCustodyCoordinator.requestReminder.mock.calls.length, 0);
  });

  it('POST /queue/:entryId/remind fails closed for unsupported and undeclared carriers', async () => {
    const queued = enqueueEntry(deps.invocationQueue, { targetCats: ['opus'] });
    deps.invocationTracker.has.mock.mockImplementation(() => true);
    deps.invocationTracker.getUserId.mock.mockImplementation(() => 'user-a');
    deps.invocationTracker.getExecutionId.mock.mockImplementation(() => 'inv-active');
    deps.resolveCarrierCapability.mock.mockImplementationOnce(() => ({
      provider: 'anthropic',
      carrier: 'claude_print_sdk',
      deliverySemantics: 'unsupported',
    }));

    const unsupported = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/remind`,
      headers: { 'x-cat-cafe-user': 'user-a' },
      payload: { targetCatId: 'opus' },
    });
    deps.resolveCarrierCapability.mock.mockImplementation(() => undefined);
    const undeclared = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/remind`,
      headers: { 'x-cat-cafe-user': 'user-a' },
      payload: { targetCatId: 'opus' },
    });

    assert.equal(unsupported.statusCode, 409);
    assert.equal(JSON.parse(unsupported.body).code, 'REMINDER_UNSUPPORTED_CARRIER');
    assert.equal(undeclared.statusCode, 409);
    assert.equal(JSON.parse(undeclared.body).code, 'REMINDER_CAPABILITY_UNDECLARED');
    assert.equal(deps.queueCustodyCoordinator.requestReminder.mock.calls.length, 0);
  });

  it('POST /queue/:entryId/remind returns the existing exact attempt idempotently', async () => {
    const queued = enqueueEntry(deps.invocationQueue, { targetCats: ['opus'] });
    deps.invocationTracker.has.mock.mockImplementation(() => true);
    deps.invocationTracker.getUserId.mock.mockImplementation(() => 'user-a');
    deps.invocationTracker.getExecutionId.mock.mockImplementation(() => 'inv-active');
    deps.queueCustodyCoordinator.findReminderAttempt.mock.mockImplementation(async () => ({
      id: 'reminder-existing',
      targetCatId: 'opus',
      invocationId: 'inv-active',
      state: 'delivered',
      requestedAt: 1,
      deliveredAt: 2,
    }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/remind`,
      headers: { 'x-cat-cafe-user': 'user-a' },
      payload: { targetCatId: 'opus' },
    });
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 200);
    assert.equal(body.reminderId, 'reminder-existing');
    assert.equal(body.state, 'delivered');
    assert.equal(body.idempotent, true);
    assert.equal(deps.queueCustodyCoordinator.requestReminder.mock.calls.length, 0);
  });

  // ── Functional: GET paused state (P1-2 fix) ──

  it('GET /queue returns paused=true when queueProcessor reports paused', async () => {
    enqueueEntry(deps.invocationQueue);
    // Stub isPaused to return true
    deps.queueProcessor.isPaused = mock.fn(() => true);
    deps.queueProcessor.getPauseReason = mock.fn(() => 'canceled');

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.paused, true);
  });

  it('GET /queue returns paused=false when queueProcessor reports not paused', async () => {
    enqueueEntry(deps.invocationQueue);
    deps.queueProcessor.isPaused = mock.fn(() => false);
    deps.queueProcessor.getPauseReason = mock.fn(() => undefined);

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.paused, false);
  });

  it('GET /queue returns pauseReason when paused', async () => {
    enqueueEntry(deps.invocationQueue);
    deps.queueProcessor.isPaused = mock.fn(() => true);
    deps.queueProcessor.getPauseReason = mock.fn(() => 'failed');

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.paused, true);
    assert.equal(body.pauseReason, 'failed');
  });

  // ── Functional: GET ──

  it('GET /queue returns entries', async () => {
    enqueueEntry(deps.invocationQueue, { content: 'first', targetCats: ['a'] });
    enqueueEntry(deps.invocationQueue, { content: 'second', targetCats: ['b'] });

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.queue.length, 2);
    assert.equal(body.queue[0].content, 'first');
  });

  // ── Functional: DELETE entry ──

  it('DELETE /queue/:entryId withdraws actionable custody without deleting author history', async () => {
    const r = enqueueEntry(deps.invocationQueue, {
      ownerAuthProvenance: 'strict',
      messageId: 'msg-withdrawn',
    });
    deps.invocationQueue.backfillMessageId('t1', 'user-a', r.entry.id, 'msg-withdrawn-merged');
    const terminalCustody = {
      version: 1,
      entryId: r.entry.id,
      revision: 2,
      ownerAuthProvenance: 'strict',
      intent: 'execute',
      status: 'terminal',
      allTargetCats: ['opus'],
      pendingTargetCats: [],
      notifiedByCatIds: [],
      seenByCatIds: [],
      seenInvocationIdByCatId: {},
      failedByCatIds: [],
      handledByCatIds: [],
      withdrawnByCatIds: ['opus'],
      withdrawnAtByCatId: { opus: 20 },
      priority: 'normal',
      createdAt: r.entry.createdAt,
      updatedAt: 20,
    };
    deps.messageStore.getById.mock.mockImplementation(async (messageId) =>
      messageId === 'msg-withdrawn' || messageId === 'msg-withdrawn-merged'
        ? { id: messageId, queueCustody: terminalCustody }
        : null,
    );

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/threads/t1/queue/${r.entry.id}`,
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(Object.hasOwn(JSON.parse(res.body).removed, 'ownerAuthProvenance'), false);
    assert.equal(deps.invocationQueue.list('t1', 'user-a').length, 0);

    // Should emit queue_updated
    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const updateCall = emitCalls.find((c) => c.arguments[1] === 'queue_updated');
    assert.ok(updateCall);
    assert.equal(updateCall.arguments[2].action, 'removed');
    assert.deepEqual(updateCall.arguments[2].queue, []);
    assert.deepEqual(
      updateCall.arguments[2].messageReceipts.map((projection) => projection.messageId),
      ['msg-withdrawn', 'msg-withdrawn-merged'],
    );
    assert.deepEqual(updateCall.arguments[2].messageReceipts[0].queueReceipt.targets, [
      { catId: 'opus', state: 'withdrawn', withdrawnAt: 20 },
    ]);
    assert.equal(deps.queueCustodyCoordinator.withdrawEntry.mock.calls.length, 1);
    assert.equal(deps.queueCustodyCoordinator.withdrawEntry.mock.calls[0].arguments[0].id, r.entry.id);
    assert.equal(deps.messageStore.markCanceled.mock.calls.length, 0);
    const deleted = deps.socketManager.emitToUser.mock.calls.find((call) => call.arguments[1] === 'message_deleted');
    assert.equal(deleted, undefined);
  });

  it('DELETE /queue/:entryId restores the actionable entry when durable withdrawal fails', async () => {
    const r = enqueueEntry(deps.invocationQueue, { ownerAuthProvenance: 'strict' });
    deps.queueCustodyCoordinator.withdrawEntry.mock.mockImplementation(async () => {
      throw new Error('custody store unavailable');
    });

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/threads/t1/queue/${r.entry.id}`,
      headers: { 'x-cat-cafe-user': 'user-a' },
    });

    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).code, 'QUEUE_WITHDRAWAL_FAILED');
    const terminalReceiptPublication = deps.socketManager.emitToUser.mock.calls.find(
      (call) => call.arguments[1] === 'queue_updated' && call.arguments[2].messageReceipts?.length > 0,
    );
    assert.equal(terminalReceiptPublication, undefined);
    assert.deepEqual(
      deps.invocationQueue.list('t1', 'user-a').map((entry) => entry.id),
      [r.entry.id],
    );
  });

  it('DELETE /queue/:entryId rejects processing entry (409)', async () => {
    enqueueEntry(deps.invocationQueue);
    deps.invocationQueue.markProcessing('t1', 'user-a');

    const entries = deps.invocationQueue.list('t1', 'user-a');
    const processingEntry = entries.find((e) => e.status === 'processing');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/threads/t1/queue/${processingEntry.id}`,
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(res.statusCode, 409);
  });

  // ── Functional: POST next ──

  it('POST /queue/next triggers next entry processing', async () => {
    deps.queueProcessor.processNext.mock.mockImplementation(async () => ({
      started: true,
      entry: {
        ...enqueueEntry(deps.invocationQueue, { ownerAuthProvenance: 'strict' }).entry,
        id: 'e1',
      },
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/t1/queue/next',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.started, true);
    assert.equal(Object.hasOwn(body.entry, 'ownerAuthProvenance'), false);
  });

  it('POST /queue/next returns started=false when empty', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/t1/queue/next',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.started, false);
  });

  // ── Functional: DELETE clear ──

  it('DELETE /queue clears all entries for user', async () => {
    const first = enqueueEntry(deps.invocationQueue, {
      targetCats: ['a'],
      ownerAuthProvenance: 'strict',
      messageId: 'msg-clear-a',
    });
    const second = enqueueEntry(deps.invocationQueue, { targetCats: ['b'], messageId: 'msg-clear-b' });
    const custodyByMessageId = new Map([
      [
        'msg-clear-a',
        {
          version: 1,
          entryId: first.entry.id,
          revision: 2,
          ownerAuthProvenance: 'strict',
          intent: 'execute',
          status: 'terminal',
          allTargetCats: ['a'],
          pendingTargetCats: [],
          notifiedByCatIds: [],
          seenByCatIds: [],
          seenInvocationIdByCatId: {},
          failedByCatIds: [],
          handledByCatIds: [],
          withdrawnByCatIds: ['a'],
          withdrawnAtByCatId: { a: 30 },
          priority: 'normal',
          createdAt: first.entry.createdAt,
          updatedAt: 30,
        },
      ],
      [
        'msg-clear-b',
        {
          version: 1,
          entryId: second.entry.id,
          revision: 2,
          ownerAuthProvenance: 'unknown',
          intent: 'execute',
          status: 'terminal',
          allTargetCats: ['b'],
          pendingTargetCats: [],
          notifiedByCatIds: [],
          seenByCatIds: [],
          seenInvocationIdByCatId: {},
          failedByCatIds: [],
          handledByCatIds: [],
          withdrawnByCatIds: ['b'],
          withdrawnAtByCatId: { b: 31 },
          priority: 'normal',
          createdAt: second.entry.createdAt,
          updatedAt: 31,
        },
      ],
    ]);
    deps.messageStore.getById.mock.mockImplementation(async (messageId) => {
      const queueCustody = custodyByMessageId.get(messageId);
      return queueCustody ? { id: messageId, queueCustody } : null;
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);
    assert.equal(body.cleared.length, 2);
    assert.equal(
      body.cleared.some((entry) => Object.hasOwn(entry, 'ownerAuthProvenance')),
      false,
    );
    assert.equal(deps.invocationQueue.list('t1', 'user-a').length, 0);

    // Should emit queue_updated with action='cleared'
    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const updateCall = emitCalls.find((c) => c.arguments[1] === 'queue_updated');
    assert.ok(updateCall);
    assert.equal(updateCall.arguments[2].action, 'cleared');
    assert.deepEqual(
      updateCall.arguments[2].messageReceipts.map((projection) => projection.messageId),
      ['msg-clear-a', 'msg-clear-b'],
    );
    assert.equal(deps.queueCustodyCoordinator.withdrawEntry.mock.calls.length, 2);
    assert.equal(deps.messageStore.markCanceled.mock.calls.length, 0);
    const deleted = deps.socketManager.emitToUser.mock.calls.find((call) => call.arguments[1] === 'message_deleted');
    assert.equal(deleted, undefined);
  });

  it('DELETE /queue retires each exact managed-wake producer after durable carrier withdrawal', async () => {
    const events = [];
    deps.queueCustodyCoordinator.withdrawEntry.mock.mockImplementation(async (entry) => {
      events.push(`withdraw:${entry.id}`);
      return true;
    });
    deps.managedCommandWakeRecovery.retireCarrier.mock.mockImplementation(async (messageIds, reason) => {
      events.push(`retire:${messageIds.join(',')}:${reason}`);
      return 1;
    });
    const { entry } = enqueueEntry(deps.invocationQueue, {
      targetCats: ['codex-sol'],
      messageId: 'message-managed-wake',
      source: 'agent',
      sourceCategory: 'scheduled',
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(events, [`withdraw:${entry.id}`, 'retire:message-managed-wake:withdrawn']);
    assert.equal(deps.invocationQueue.list('t1', 'user-a').length, 0);
  });

  it('DELETE /queue reports partial durable withdrawal and keeps every unsettled entry actionable', async () => {
    const first = enqueueEntry(deps.invocationQueue, { targetCats: ['a'], ownerAuthProvenance: 'strict' });
    const second = enqueueEntry(deps.invocationQueue, { targetCats: ['b'] });
    const third = enqueueEntry(deps.invocationQueue, { targetCats: ['c'] });
    let calls = 0;
    deps.queueCustodyCoordinator.withdrawEntry.mock.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) throw new Error('custody store unavailable');
      return true;
    });

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 503);
    assert.equal(body.code, 'QUEUE_WITHDRAWAL_PARTIAL');
    assert.deepEqual(
      body.cleared.map((entry) => entry.id),
      [first.entry.id],
    );
    assert.deepEqual(
      deps.invocationQueue.list('t1', 'user-a').map((entry) => entry.id),
      [second.entry.id, third.entry.id],
    );
  });

  // ── Functional: PATCH move ──

  it('PATCH /queue/:entryId/move up swaps with previous entry', async () => {
    enqueueEntry(deps.invocationQueue, { content: 'first', targetCats: ['a'] });
    const r2 = enqueueEntry(deps.invocationQueue, { content: 'second', targetCats: ['b'] });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/t1/queue/${r2.entry.id}/move`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { direction: 'up' },
    });
    assert.equal(res.statusCode, 200);

    const queue = deps.invocationQueue.list('t1', 'user-a');
    assert.equal(queue[0].content, 'second');
    assert.equal(queue[1].content, 'first');

    // Should emit queue_updated with action='reordered'
    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const updateCall = emitCalls.find((c) => c.arguments[1] === 'queue_updated');
    assert.ok(updateCall);
    assert.equal(updateCall.arguments[2].action, 'reordered');
  });

  it('PATCH /queue/:entryId/move down swaps with next entry', async () => {
    const r1 = enqueueEntry(deps.invocationQueue, { content: 'first', targetCats: ['a'] });
    enqueueEntry(deps.invocationQueue, { content: 'second', targetCats: ['b'] });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/t1/queue/${r1.entry.id}/move`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { direction: 'down' },
    });
    assert.equal(res.statusCode, 200);

    const queue = deps.invocationQueue.list('t1', 'user-a');
    assert.equal(queue[0].content, 'second');
  });

  it('PATCH /queue/:entryId/move rejects processing entry (409)', async () => {
    enqueueEntry(deps.invocationQueue);
    deps.invocationQueue.markProcessing('t1', 'user-a');

    const entries = deps.invocationQueue.list('t1', 'user-a');
    const processingEntry = entries.find((e) => e.status === 'processing');

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/t1/queue/${processingEntry.id}/move`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { direction: 'up' },
    });
    assert.equal(res.statusCode, 409);
  });

  it('PATCH /queue/:entryId/move rejects system continuation entries (409)', async () => {
    const continuation = enqueueEntry(deps.invocationQueue, {
      content: 'continue sealed work',
      source: 'agent',
      sourceCategory: 'continuation',
      continuationKey: 't1:opus:inv-1:sess-1:1',
      autoExecute: true,
    });
    enqueueEntry(deps.invocationQueue, { content: 'user work', targetCats: ['codex'] });

    const res = await app.inject({
      method: 'PATCH',
      url: `/api/threads/t1/queue/${continuation.entry.id}/move`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { direction: 'down' },
    });
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 409);
    assert.equal(body.code, 'ENTRY_POSITION_LOCKED');
    assert.equal(deps.invocationQueue.list('t1', 'user-a')[0].id, continuation.entry.id);
  });

  // ── Functional: POST steer ──

  it('POST /queue/steer-batch reserves exact A+B before one cancel and never marks unselected C', async () => {
    const a = enqueueEntry(deps.invocationQueue, { content: 'a', ownerAuthProvenance: 'strict' }).entry;
    const b = enqueueEntry(deps.invocationQueue, { content: 'b', ownerAuthProvenance: 'strict' }).entry;
    const c = enqueueEntry(deps.invocationQueue, { content: 'c', ownerAuthProvenance: 'strict' }).entry;
    deps.invocationTracker.has = mock.fn(() => true);
    deps.invocationTracker.getUserId = mock.fn(() => 'user-a');
    deps.invocationTracker.cancel = mock.fn(() => {
      const byId = new Map(deps.invocationQueue.list('t1', 'user-a').map((entry) => [entry.id, entry]));
      assert.deepEqual(byId.get(a.id).steerRequestedByCatIds, ['opus'], 'A reserved before cancel');
      assert.deepEqual(byId.get(b.id).steerRequestedByCatIds, ['opus'], 'B reserved before cancel');
      assert.equal(byId.get(c.id).steerRequestedByCatIds, undefined, 'C remains outside reservation');
      return { cancelled: true, catIds: ['opus'], executionIds: ['inv-active'] };
    });
    deps.queueProcessor.processNext = mock.fn(async () => ({ started: true, entry: a }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/t1/queue/steer-batch',
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { entryIds: [a.id, b.id] },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().entryIds, [a.id, b.id]);
    assert.equal(deps.invocationTracker.cancel.mock.calls.length, 1);
    assert.equal(deps.queueProcessor.processNext.mock.calls.length, 1);
    assert.equal(deps.queueCustodyCoordinator.persistEntry.mock.calls.length, 2);

    const projected = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(projected.statusCode, 200);
    assert.ok(projected.json().queue.every((entry) => !Object.hasOwn(entry, 'exactSteerBatch')));
  });

  it('POST /queue/steer does not preempt when the reservation CAS loses', async () => {
    // Single-entry steer used to preempt first and reserve second, so a losing
    // CAS returned STEER_STATE_CHANGED *after* the running turn was already
    // cancelled: the user lost the work, did not get the steer, and was told to
    // retry. steer-batch already reserved before cancelling; this makes the
    // single path agree.
    const target = enqueueEntry(deps.invocationQueue, { content: 'steer me', ownerAuthProvenance: 'strict' }).entry;
    deps.invocationTracker.has = mock.fn(() => true);
    deps.invocationTracker.getUserId = mock.fn(() => 'user-a');
    deps.invocationTracker.cancel = mock.fn(() => ({ cancelled: true, catIds: ['opus'], executionIds: ['inv-a'] }));
    // The entry moves out from under the request between lookup and reservation.
    deps.invocationQueue.reserveExactUserEntry = mock.fn(() => ({ outcome: 'rejected', reason: 'state_changed' }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${target.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {},
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'STEER_STATE_CHANGED');
    assert.equal(
      deps.invocationTracker.cancel.mock.calls.length,
      0,
      'a refused steer must not have cancelled the running turn',
    );
  });

  it('POST /queue/:entryId/steer does not preempt when reservation persistence fails', async () => {
    // Reserving only in memory just moved the split transaction: a rejected
    // durable write would still have landed after the running turn was killed.
    // steer-batch persists its reservation before preempting; this must match.
    const target = enqueueEntry(deps.invocationQueue, { content: 'steer me', ownerAuthProvenance: 'strict' }).entry;
    deps.invocationTracker.has = mock.fn(() => true);
    deps.invocationTracker.getUserId = mock.fn(() => 'user-a');
    deps.invocationTracker.cancel = mock.fn(() => ({ cancelled: true, catIds: ['opus'], executionIds: ['inv-a'] }));
    deps.queueCustodyCoordinator.persistEntry = mock.fn(async () => {
      throw new Error('durable reservation rejected');
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${target.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {},
    });

    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, 'STEER_RESERVATION_PERSIST_FAILED');
    assert.equal(
      deps.invocationTracker.cancel.mock.calls.length,
      0,
      'an unpersistable reservation must not have cancelled the running turn',
    );
    const after = deps.invocationQueue.list('t1', 'user-a').find((entry) => entry.id === target.id);
    assert.equal(after.steerRequestedByCatIds, undefined, 'the local reservation marker must be rolled back');
  });

  it('POST /queue/:entryId/steer fences ordinary dequeue while its durable reservation is persisting', async () => {
    const target = enqueueEntry(deps.invocationQueue, {
      content: 'steer me',
      ownerAuthProvenance: 'strict',
    }).entry;
    const persistGate = asyncGate();
    let firstPersist = true;
    deps.queueCustodyCoordinator.persistEntry = mock.fn(async () => {
      if (!firstPersist) return;
      firstPersist = false;
      persistGate.enter();
      await persistGate.blocked;
    });
    deps.invocationTracker.has = mock.fn(() => true);
    deps.invocationTracker.getUserId = mock.fn(() => 'user-a');
    deps.invocationTracker.cancel = mock.fn(() => ({
      cancelled: true,
      catIds: ['opus'],
      executionIds: ['inv-active'],
    }));
    deps.queueProcessor.processNext = mock.fn(async () => ({ started: true, entry: target }));

    const responsePromise = app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${target.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {},
    });
    await persistGate.entered;

    assert.equal(
      deps.invocationQueue.markProcessing('t1', 'user-a'),
      null,
      'ordinary dequeue must not claim the entry while Steer awaits durable persistence',
    );
    assert.equal(deps.invocationTracker.cancel.mock.calls.length, 0, 'preemption has not begun before persistence');

    const [withdraw, clear] = await Promise.all([
      app.inject({
        method: 'DELETE',
        url: `/api/threads/t1/queue/${target.id}`,
        headers: { 'x-cat-cafe-user': 'user-a' },
      }),
      app.inject({
        method: 'DELETE',
        url: '/api/threads/t1/queue',
        headers: { 'x-cat-cafe-user': 'user-a' },
      }),
    ]);
    assert.equal(withdraw.statusCode, 409);
    assert.equal(withdraw.json().code, 'ENTRY_STEERING');
    assert.equal(clear.statusCode, 409);
    assert.equal(clear.json().code, 'ENTRY_STEERING');

    persistGate.release();
    const res = await responsePromise;
    assert.equal(res.statusCode, 200);
    const processExactArgs = deps.queueProcessor.processExactSteerReservation.mock.calls[0].arguments;
    assert.deepEqual(processExactArgs.slice(0, 3), ['t1', 'user-a', target.id]);
    assert.equal(
      processExactArgs[3],
      deps.invocationQueue.getEntrySnapshot('t1', 'user-a', target.id).exactSteerBatch.reservationId,
      'the route must pass the same exact reservation identity across the persistence await',
    );
  });

  it('POST /queue/:entryId/steer retains exact ownership across the preemption await', async () => {
    const inflight = enqueueEntry(deps.invocationQueue, {
      content: 'inflight',
      ownerAuthProvenance: 'strict',
      targetCats: ['opus'],
    }).entry;
    deps.invocationQueue.markProcessing('t1', 'user-a');
    const target = enqueueEntry(deps.invocationQueue, {
      content: 'steer after preemption',
      ownerAuthProvenance: 'strict',
      targetCats: ['opus'],
    }).entry;
    const preemptionGate = asyncGate();
    deps.invocationTracker.has = mock.fn(() => false);
    deps.queueProcessor.finalizeRemovedEntry = mock.fn(async (removed) => {
      assert.equal(removed.id, inflight.id);
      preemptionGate.enter();
      await preemptionGate.blocked;
      return true;
    });
    deps.queueProcessor.processExactSteerReservation = mock.fn(async (threadId, userId, entryId, reservationId) => ({
      started: Boolean(deps.invocationQueue.claimExactSteerReservation(threadId, userId, entryId, reservationId)),
      entry: deps.invocationQueue.getEntrySnapshot(threadId, userId, entryId),
    }));

    const responsePromise = app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${target.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {},
    });
    await preemptionGate.entered;

    assert.equal(deps.invocationQueue.markProcessing('t1', 'user-a'), null);
    assert.equal(deps.invocationQueue.markProcessingById('t1', target.id), false);
    preemptionGate.release();

    const res = await responsePromise;
    assert.equal(res.statusCode, 200);
    const reserved = deps.invocationQueue.getEntrySnapshot('t1', 'user-a', target.id);
    const reservationId = reserved.exactSteerBatch.reservationId;
    assert.equal(deps.invocationQueue.claimExactSteerReservation('t1', 'user-a', target.id, 'wrong'), null);
    assert.equal(reserved.status, 'processing');
    assert.equal(deps.queueProcessor.processExactSteerReservation.mock.calls[0].arguments[3], reservationId);
  });

  it('POST /queue/:entryId/steer durably clears the reservation when preemption is refused', async () => {
    const target = enqueueEntry(deps.invocationQueue, { content: 'steer me', ownerAuthProvenance: 'strict' }).entry;
    deps.invocationTracker.has = mock.fn(() => true);
    // Another user owns the running turn, so preemption is refused after the
    // reservation has already been persisted.
    deps.invocationTracker.getUserId = mock.fn(() => 'someone-else');
    deps.invocationTracker.cancel = mock.fn(() => ({ cancelled: false, catIds: [] }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${target.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {},
    });

    assert.equal(res.statusCode, 409);
    assert.equal(deps.invocationTracker.cancel.mock.calls.length, 0);
    const after = deps.invocationQueue.list('t1', 'user-a').find((entry) => entry.id === target.id);
    assert.equal(after.steerRequestedByCatIds, undefined, 'a refused steer must not leave the entry reserved');
    // The release itself must be durable, not only in memory.
    const persistCalls = deps.queueCustodyCoordinator.persistEntry.mock.calls.length;
    assert.ok(persistCalls >= 2, `reservation and its release must both persist (saw ${persistCalls})`);
  });

  it('POST /queue/steer-batch rejects an ineligible member atomically before cancel', async () => {
    const a = enqueueEntry(deps.invocationQueue, { content: 'a', ownerAuthProvenance: 'strict' }).entry;
    const freshness = enqueueEntry(deps.invocationQueue, {
      content: 'freshness',
      ownerAuthProvenance: 'strict',
      sourceCategory: 'freshness',
      freshnessClosureId: 'closure-1',
    }).entry;
    deps.invocationTracker.has = mock.fn(() => true);

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/t1/queue/steer-batch',
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { entryIds: [a.id, freshness.id] },
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'BATCH_ENTRY_INELIGIBLE');
    assert.equal(deps.invocationTracker.cancel.mock.calls.length, 0);
    assert.equal(deps.queueProcessor.processNext.mock.calls.length, 0);
    assert.ok(deps.invocationQueue.list('t1', 'user-a').every((entry) => !entry.steerRequestedByCatIds));
  });

  it('POST /queue/steer-batch releases the whole reservation when durable reservation persistence fails', async () => {
    const a = enqueueEntry(deps.invocationQueue, { content: 'a', ownerAuthProvenance: 'strict' }).entry;
    const b = enqueueEntry(deps.invocationQueue, { content: 'b', ownerAuthProvenance: 'strict' }).entry;
    deps.queueCustodyCoordinator.persistEntry = mock.fn(async () => {
      throw new Error('custody unavailable');
    });
    deps.invocationTracker.has = mock.fn(() => true);

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/t1/queue/steer-batch',
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { entryIds: [a.id, b.id] },
    });

    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, 'BATCH_RESERVATION_PERSIST_FAILED');
    assert.equal(deps.invocationTracker.cancel.mock.calls.length, 0);
    assert.ok(deps.invocationQueue.list('t1', 'user-a').every((entry) => !entry.steerRequestedByCatIds));
  });

  it('POST /queue/:entryId/steer rejects promote because Steer has one cancel-and-restart meaning', async () => {
    const queued = enqueueEntry(deps.invocationQueue, { content: 'queued correction' });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { mode: 'promote' },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(deps.invocationQueue.list('t1', 'user-a')[0].id, queued.entry.id);
  });

  it('POST /queue/:entryId/steer defaults to immediate cancel-and-restart for the same entry', async () => {
    const queued = enqueueEntry(deps.invocationQueue, {
      content: 'queued correction',
      ownerAuthProvenance: 'strict',
    });
    deps.invocationTracker.has = mock.fn(() => true);
    deps.invocationTracker.getUserId = mock.fn(() => 'user-a');
    deps.invocationTracker.cancel = mock.fn(() => ({
      cancelled: true,
      catIds: ['opus'],
      executionIds: ['inv-active'],
    }));
    deps.queueProcessor.processNext = mock.fn(async () => ({ started: true, entry: queued.entry }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {},
    });

    assert.equal(res.statusCode, 200);
    assert.equal(Object.hasOwn(JSON.parse(res.body).entry, 'ownerAuthProvenance'), false);
    assert.equal(deps.invocationTracker.cancel.mock.calls.length, 1);
    assert.equal(deps.queueProcessor.processNext.mock.calls.length, 1);
  });

  it('POST /queue/:entryId/steer publishes the cleared receipt when immediate restart cannot begin', async () => {
    const queued = enqueueEntry(deps.invocationQueue, { content: 'queued correction' });
    deps.invocationTracker.has = mock.fn(() => true);
    deps.invocationTracker.getUserId = mock.fn(() => 'user-a');
    deps.invocationTracker.cancel = mock.fn(() => ({
      cancelled: true,
      catIds: ['opus'],
      executionIds: ['inv-active'],
    }));
    deps.queueProcessor.processNext = mock.fn(async () => ({ started: false }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {},
    });

    assert.equal(res.statusCode, 409);
    const updates = deps.socketManager.emitToUser.mock.calls
      .filter((call) => call.arguments[1] === 'queue_updated')
      .map((call) => call.arguments[2]);
    assert.equal(updates.at(-1)?.action, 'steer_failed');
    assert.equal(updates.at(-1)?.queue[0].targetStates.opus, 'queued');
  });

  it('POST /queue/:entryId/steer returns 409 when entry is processing', async () => {
    enqueueEntry(deps.invocationQueue);
    deps.invocationQueue.markProcessing('t1', 'user-a');
    const entries = deps.invocationQueue.list('t1', 'user-a');
    const processingEntry = entries.find((e) => e.status === 'processing');

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${processingEntry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {},
    });
    assert.equal(res.statusCode, 409);
  });

  it('POST /queue/:entryId/steer immediate cancels active invocation and starts processing', async () => {
    const r1 = enqueueEntry(deps.invocationQueue, { content: 'first' });
    enqueueEntry(deps.invocationQueue, { content: 'second' });

    deps.invocationTracker.has = mock.fn(() => true);
    deps.invocationTracker.getUserId = mock.fn(() => 'user-a');
    deps.invocationTracker.cancel = mock.fn(() => ({
      cancelled: true,
      catIds: ['codex'],
      executionIds: ['inv-active'],
    }));
    deps.queueProcessor.processNext = mock.fn(async () => ({ started: true, entry: { id: r1.entry.id } }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${r1.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { mode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(deps.invocationTracker.cancel.mock.calls.length, 1);
    assert.equal(deps.queueProcessor.processNext.mock.calls.length, 1);
    assert.deepEqual(deps.agentSessionMutex.forceReleaseByScope.mock.calls[0].arguments, [
      { threadId: 't1', userId: 'user-a', catId: 'opus' },
      { preserveHolderExecutionIds: ['inv-active'] },
    ]);
    // Bugfix: steer must broadcast cancel+done so frontend clears old invocation's "正在回复中"
    const broadcastCalls = deps.socketManager.broadcastAgentMessage.mock.calls;
    assert.ok(broadcastCalls.length >= 2, 'should broadcast system_info + done for canceled invocation');
    const doneCall = broadcastCalls.find((c) => c.arguments[0].type === 'done');
    assert.ok(doneCall, 'should broadcast done event to clear frontend loading state');
    assert.equal(doneCall.arguments[0].isFinal, true);
  });

  it('POST /queue/:entryId/steer immediate releases QueueProcessor mutex after cancel (P2 race)', async () => {
    const r1 = enqueueEntry(deps.invocationQueue, { content: 'first' });
    enqueueEntry(deps.invocationQueue, { content: 'second' });

    deps.invocationTracker.has = mock.fn(() => true);
    deps.invocationTracker.getUserId = mock.fn(() => 'user-a');
    deps.invocationTracker.cancel = mock.fn(() => ({ cancelled: true, catIds: ['codex'] }));

    let locked = true;
    deps.queueProcessor.releaseSlot = mock.fn(() => {
      locked = false;
    });
    deps.queueProcessor.processNext = mock.fn(async () => {
      if (locked) return { started: false };
      return { started: true, entry: { id: r1.entry.id } };
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${r1.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { mode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(deps.queueProcessor.releaseSlot.mock.calls.length, 1);
  });

  it('POST /queue/:entryId/steer immediate TOMBSTONES a pre-start in-flight entry instead of force-releasing (race-safe, 云端 R3 P1)', async () => {
    // In-flight entry A occupies the opus per-cat slot (processing), e.g. its executeEntry is in the
    // pre-start create-await window so invocationTracker.has(opus) is false. The user steers a second
    // opus entry B. Force-releasing A's slot would double-start opus once create returns; instead
    // steer must TOMBSTONE A (removeProcessed) so executeEntry self-aborts, and NOT force-release.
    const a = enqueueEntry(deps.invocationQueue, { content: 'inflight', targetCats: ['opus'] });
    deps.invocationQueue.markProcessing('t1', 'user-a'); // A → processing (holds opus slot)
    const b = enqueueEntry(deps.invocationQueue, { content: 'steered', targetCats: ['opus'] });

    deps.invocationTracker.has = mock.fn(() => false); // pre-start: tracker not yet registered
    deps.queueProcessor.processExactSteerReservation = mock.fn(async () => ({ started: true, entry: b.entry }));
    // Precondition: A holds the opus slot (in-flight).
    assert.equal(deps.invocationQueue.findProcessingByCat('t1', 'opus')?.id, a.entry.id);

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${b.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { mode: 'immediate' },
    });

    // Durable retirement finishes before B becomes the exact replacement owner.
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.started, true);

    // A was tombstoned (removed) so executeEntry self-aborts at its post-startAll guard.
    assert.equal(deps.invocationQueue.findProcessingByCat('t1', 'opus'), null, 'in-flight A must be tombstoned');
    // Race-safe: NO force slot-release, NO cancel of a non-existent tracker invocation.
    assert.equal(deps.queueProcessor.releaseSlot.mock.calls.length, 0, 'must NOT force-release a pre-start slot');
    assert.equal(deps.invocationTracker.cancel.mock.calls.length, 0);
    // B was promoted to run next.
    assert.equal(deps.invocationQueue.list('t1', 'user-a')[0].id, b.entry.id);
  });

  it('POST /queue/:entryId/steer immediate must NOT tombstone ANOTHER user’s pre-start entry (云端 R4 P1-b cross-user)', async () => {
    // user-b holds the opus slot via an in-flight (pre-start) entry; user-a steers their own opus
    // entry. The cross-user guard must reject (INVOCATION_ACTIVE) and leave user-b's entry intact —
    // one user cannot interrupt another's in-flight invocation by steering their own.
    const other = enqueueEntry(deps.invocationQueue, {
      userId: 'user-b',
      content: 'other-inflight',
      targetCats: ['opus'],
    });
    deps.invocationQueue.markProcessing('t1', 'user-b'); // user-b's entry → processing (holds opus slot)
    const mine = enqueueEntry(deps.invocationQueue, { userId: 'user-a', content: 'mine', targetCats: ['opus'] });

    deps.invocationTracker.has = mock.fn(() => false); // pre-start: tracker not yet registered

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${mine.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { mode: 'immediate' },
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'INVOCATION_ACTIVE');
    // user-b's in-flight entry must NOT be tombstoned.
    assert.equal(
      deps.invocationQueue.findProcessingByCat('t1', 'opus')?.id,
      other.entry.id,
      "other user's entry intact",
    );
  });

  it('POST /queue/:entryId/steer immediate NEVER force-releases an occupied slot — always tombstones (云端 R6: age unsound)', async () => {
    // 云端 R3–R6 converged: an occupied slot with has()=false is always "executeEntry pending in
    // create-await"; steer cannot tell a slow-but-live create from a hung one (create awaits an
    // unbounded Redis eval), so NO age threshold is sound. Even an "old" processing entry must be
    // tombstoned (not force-released) — a force-release would double-start if create later resumes.
    enqueueEntry(deps.invocationQueue, { userId: 'user-a', content: 'old-inflight', targetCats: ['opus'] });
    deps.invocationQueue.markProcessing('t1', 'user-a');
    const old = deps.invocationQueue.findProcessingByCat('t1', 'opus');
    old.processingStartedAt = Date.now() - 60 * 60_000; // 1h old — still must NOT force-release
    const steered = enqueueEntry(deps.invocationQueue, { userId: 'user-a', content: 'steered', targetCats: ['opus'] });

    deps.invocationTracker.has = mock.fn(() => false);
    deps.queueProcessor.processExactSteerReservation = mock.fn(async () => ({ started: true, entry: steered.entry }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${steered.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { mode: 'immediate' },
    });

    // Sound: durable retire + exact start, regardless of entry age. NO force-release (double-start risk).
    assert.equal(res.statusCode, 200);
    assert.equal(deps.queueProcessor.releaseSlot.mock.calls.length, 0, 'must NEVER force-release by age');
  });

  it('POST /queue/:entryId/steer immediate marks the TOMBSTONED user message canceled (云端 R7 P1 F117)', async () => {
    // Tombstoning an in-flight user entry must mirror withdraw/clear F117 cleanup: its message would
    // otherwise stay permanently 'queued' (undelivered + excluded from context) since executeEntry
    // self-aborts before its markDelivered block.
    enqueueEntry(deps.invocationQueue, { userId: 'user-a', content: 'inflight', targetCats: ['opus'] });
    deps.invocationQueue.markProcessing('t1', 'user-a');
    const inflight = deps.invocationQueue.findProcessingByCat('t1', 'opus');
    inflight.messageId = 'msg-inflight'; // user message backing the in-flight entry
    const steered = enqueueEntry(deps.invocationQueue, { userId: 'user-a', content: 'steered', targetCats: ['opus'] });

    deps.invocationTracker.has = mock.fn(() => false);
    deps.queueProcessor.processExactSteerReservation = mock.fn(async () => ({ started: true, entry: steered.entry }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${steered.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { mode: 'immediate' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(deps.messageStore.markCanceled.mock.calls.length, 1, 'tombstoned message must be marked canceled');
    assert.equal(deps.messageStore.markCanceled.mock.calls[0].arguments[0], 'msg-inflight');
    const del = deps.socketManager.emitToUser.mock.calls.find((c) => c.arguments[1] === 'message_deleted');
    assert.ok(del, 'message_deleted must be emitted');
    assert.equal(del.arguments[2].messageId, 'msg-inflight');
  });

  it('POST /queue/:entryId/steer immediate does NOT emit message_deleted when cancel CAS is a no-op', async () => {
    // If the message was already canceled/delivered, the receipt reports applied=false.
    // The transition gate must suppress the message_deleted emit — otherwise the client would
    // flash-delete a delivered message or duplicate-delete an already-canceled one.
    enqueueEntry(deps.invocationQueue, { userId: 'user-a', content: 'inflight', targetCats: ['opus'] });
    deps.invocationQueue.markProcessing('t1', 'user-a');
    const inflight = deps.invocationQueue.findProcessingByCat('t1', 'opus');
    inflight.messageId = 'msg-already-delivered';
    const steered = enqueueEntry(deps.invocationQueue, { userId: 'user-a', content: 'steered', targetCats: ['opus'] });

    deps.invocationTracker.has = mock.fn(() => false);
    deps.queueProcessor.processExactSteerReservation = mock.fn(async () => ({ started: true, entry: steered.entry }));
    deps.messageStore.markCanceled = mock.fn(async () => ({
      deliveryStatus: 'delivered',
      deliveryTransitioned: false,
    }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${steered.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { mode: 'immediate' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(deps.messageStore.markCanceled.mock.calls.length, 1, 'markCanceled must be called');
    const del = deps.socketManager.emitToUser.mock.calls.find((c) => c.arguments[1] === 'message_deleted');
    assert.equal(del, undefined, 'message_deleted must NOT be emitted when cancel is a no-op');
  });

  it('POST /queue/:entryId/steer immediate scopes cancel broadcast to steered cat only (P1 cloud review)', async () => {
    const r1 = enqueueEntry(deps.invocationQueue, { content: 'first', targetCats: ['opus'] });
    enqueueEntry(deps.invocationQueue, { content: 'second' });

    deps.invocationTracker.has = mock.fn(() => true);
    deps.invocationTracker.getUserId = mock.fn(() => 'user-a');
    // cancel returns multi-cat catIds (co-dispatched), but steer targets only opus
    deps.invocationTracker.cancel = mock.fn(() => ({ cancelled: true, catIds: ['opus', 'codex'] }));
    deps.queueProcessor.processNext = mock.fn(async () => ({ started: true, entry: { id: r1.entry.id } }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${r1.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { mode: 'immediate' },
    });
    assert.equal(res.statusCode, 200);

    // done should only be broadcast for opus (the steered cat), NOT codex
    const broadcastCalls = deps.socketManager.broadcastAgentMessage.mock.calls;
    const doneCalls = broadcastCalls.filter((c) => c.arguments[0].type === 'done');
    assert.equal(doneCalls.length, 1, 'should broadcast exactly 1 done event (steered cat only)');
    assert.equal(doneCalls[0].arguments[0].catId, 'opus');
    // codex should NOT receive a done event
    const codexDone = broadcastCalls.find((c) => c.arguments[0].type === 'done' && c.arguments[0].catId === 'codex');
    assert.equal(codexDone, undefined, 'codex should NOT receive cancel done when not steered');
  });

  it('POST /queue/:entryId/steer returns 404 for another user entry', async () => {
    const r = enqueueEntry(deps.invocationQueue, { userId: 'user-a' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${r.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-b', 'content-type': 'application/json' },
      payload: {},
    });
    assert.equal(res.statusCode, 404);
  });

  // ── F122B AC-B9: Per-cat cancel ──

  it('POST /cancel/:catId cancels active cat and broadcasts done (AC-B9)', async () => {
    deps.invocationTracker.has = mock.fn(() => true);
    deps.invocationTracker.cancel = mock.fn(() => ({
      cancelled: true,
      catIds: ['opus'],
      executionIds: ['inv-active'],
    }));

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/t1/cancel/opus',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.cancelled, true);
    assert.deepEqual(deps.invocationTracker.cancel.mock.calls[0].arguments, ['t1', 'opus', 'user-a', 'user_cancel']);
    assert.deepEqual(deps.agentSessionMutex.forceReleaseByScope.mock.calls[0].arguments, [
      { threadId: 't1', userId: 'user-a', catId: 'opus' },
      { preserveHolderExecutionIds: ['inv-active'] },
    ]);

    // Should broadcast done for opus
    const doneCalls = deps.socketManager.broadcastAgentMessage.mock.calls.filter((c) => c.arguments[0].type === 'done');
    assert.equal(doneCalls.length, 1);
    assert.equal(doneCalls[0].arguments[0].catId, 'opus');
  });

  it('POST /cancel/:catId returns 404 when cat is not active (AC-B9)', async () => {
    deps.invocationTracker.has = mock.fn(() => false);

    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/t1/cancel/codex',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'CAT_NOT_ACTIVE');
  });

  // ── F175 Task 6: PATCH /queue/reorder ──

  it('PATCH /queue/reorder sets positions on multiple entries (F175)', async () => {
    const r1 = enqueueEntry(deps.invocationQueue, { content: 'a' });
    const r2 = enqueueEntry(deps.invocationQueue, { content: 'b' });
    const r3 = enqueueEntry(deps.invocationQueue, { content: 'c' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/t1/queue/reorder',
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {
        positions: [
          { entryId: r3.entry.id, position: 0 },
          { entryId: r1.entry.id, position: 1 },
          { entryId: r2.entry.id, position: 2 },
        ],
      },
    });
    assert.equal(res.statusCode, 200);

    const next = deps.invocationQueue.peekOldestAcrossUsers('t1');
    assert.equal(next.content, 'c', 'entry c should be first after reorder');

    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const updateCall = emitCalls.find((c) => c.arguments[1] === 'queue_updated');
    assert.ok(updateCall);
    assert.equal(updateCall.arguments[2].action, 'reordered');
  });

  it('PATCH /queue/reorder rejects position on processing entry (F175)', async () => {
    enqueueEntry(deps.invocationQueue, { content: 'a' });
    deps.invocationQueue.markProcessing('t1', 'user-a');
    const entries = deps.invocationQueue.list('t1', 'user-a');
    const processingEntry = entries.find((e) => e.status === 'processing');

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/t1/queue/reorder',
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { positions: [{ entryId: processingEntry.id, position: 0 }] },
    });
    assert.equal(res.statusCode, 400);
  });

  it('PATCH /queue/reorder rejects position on system continuation entry (F175)', async () => {
    const continuation = enqueueEntry(deps.invocationQueue, {
      content: 'continue sealed work',
      source: 'agent',
      sourceCategory: 'continuation',
      continuationKey: 't1:opus:inv-1:sess-1:1',
      autoExecute: true,
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/t1/queue/reorder',
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { positions: [{ entryId: continuation.entry.id, position: 99 }] },
    });
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 409);
    assert.equal(body.code, 'ENTRY_POSITION_LOCKED');
    assert.equal(deps.invocationQueue.list('t1', 'user-a')[0].id, continuation.entry.id);
  });

  it('PATCH /queue/reorder rejects invalid body (F175)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/t1/queue/reorder',
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { positions: 'not-an-array' },
    });
    assert.equal(res.statusCode, 400);
  });

  it('P2-4: PATCH /queue/reorder does not partial-write on failure', async () => {
    const r1 = enqueueEntry(deps.invocationQueue, { content: 'a' });
    enqueueEntry(deps.invocationQueue, { content: 'b' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/t1/queue/reorder',
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {
        positions: [
          { entryId: r1.entry.id, position: 5 },
          { entryId: 'nonexistent', position: 0 },
        ],
      },
    });
    assert.equal(res.statusCode, 400);

    const entries = deps.invocationQueue.list('t1', 'user-a');
    const first = entries.find((e) => e.id === r1.entry.id);
    assert.equal(first.position, undefined, 'first entry position should NOT be written when batch fails');
  });
});
