/**
 * Queue Management API tests (F39 Task 4)
 * Tests: GET/DELETE/POST/PATCH queue endpoints with auth + isolation.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';
import { canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

const { InvocationQueue, queueEntryOwnerId, queueEntryTargetCats } = await import(
  '../dist/domains/cats/services/agents/invocation/InvocationQueue.js'
);

async function terminalizeFixtureCarrier(deps, queueProcessor, carrier, userId, threadId) {
  if ((await queueProcessor.finalizeRemovedEntry(carrier, 'user_cancel')) === false) return false;
  for (const messageId of carrier.payload.messageId ? [carrier.payload.messageId] : []) {
    try {
      const canceled = await deps.messageStore.markCanceled(messageId);
      if (canceled?.deliveryTransitioned === true) {
        deps.socketManager.emitToUser(userId, 'message_deleted', { messageId, threadId, deletedBy: userId });
      }
    } catch {
      return false;
    }
  }
  return Boolean(
    await deps.invocationQueue.removeProcessedAcrossUsersDurable(
      threadId,
      carrier.id,
      'interrupted',
      'invocation_cancelled',
    ),
  );
}

/** Build deps with stubs */
function buildDeps(overrides = {}) {
  const invocationQueue = new InvocationQueue();
  const threadFixture = {
    id: 't1',
    title: 'Test Thread',
    createdBy: 'system',
    participants: ['opus', 'codex'],
  };
  let deps;
  const queueProcessor = {
    canReleaseSlotForUser: mock.fn(() => true),
    hasProcessingSlotReservation: mock.fn((threadId, catId) =>
      Boolean(invocationQueue.findProcessingByCat(threadId, catId)),
    ),
    processNext: mock.fn(async () => ({ started: false })),
    releaseSlot: mock.fn(() => {}),
    releaseThread: mock.fn(() => {}),
    requestDrain: mock.fn(async () => {}),
    finalizeRemovedEntry: mock.fn(async () => true),
    appendExactEntry: mock.fn(async () => ({ outcome: 'appended', entry: {}, acceptedTargetIds: ['opus'] })),
    tryAutoAppendExactEntry: mock.fn(async () => ({ outcome: 'appended', entry: {}, acceptedTargetIds: ['opus'] })),
  };
  queueProcessor.processClaimedSteerEntries = mock.fn(async (threadId, userId, entryIds) => ({
    started: true,
    entry: invocationQueue.getEntrySnapshot(threadId, userId, entryIds[0]),
  }));
  queueProcessor.processExactSteerReservation = mock.fn(async (threadId, userId) =>
    queueProcessor.processNext(threadId, userId),
  );
  const managedCommandWakeRecovery = {
    retireCarrier: mock.fn(async () => 0),
    retireThread: mock.fn(async () => ({ retired: 0, messageIds: [] })),
  };
  deps = {
    threadStore: {
      get: mock.fn(async (id) => ({ ...threadFixture, id, participants: [...threadFixture.participants] })),
      addParticipants: mock.fn(async (_threadId, catIds) => {
        for (const catId of catIds) {
          if (!threadFixture.participants.includes(catId)) threadFixture.participants.push(catId);
        }
      }),
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
    isCatAvailable: mock.fn(() => true),
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    messageStore: {
      markCanceled: mock.fn(async () => ({ deliveryStatus: 'canceled', deliveryTransitioned: true })),
      getById: mock.fn(async () => null),
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
    if (!inflight || queueEntryOwnerId(inflight) !== userId) return 'state_changed';
    const carriers = invocationQueue.getProcessingGroupAcrossUsers(threadId, inflight.id);
    if (!carriers) return 'state_changed';
    for (const carrier of carriers) {
      if (!(await terminalizeFixtureCarrier(deps, queueProcessor, carrier, userId, threadId))) {
        return 'terminalization_failed';
      }
    }
    return 'retired';
  });
  return deps;
}

let durableSourceSequence = 0;

/** Enqueue one canonical durable ledger row for route tests. */
function enqueueEntry(queue, overrides = {}) {
  durableSourceSequence += 1;
  return queue.enqueueDurableNow(
    canonicalTestQueueInput({
      threadId: 't1',
      userId: 'user-a',
      kind: 'conversation_input',
      content: 'hello',
      source: 'user',
      ownerAuthProvenance: 'unknown',
      targetCats: ['opus'],
      intent: 'execute',
      sourceId: `queue-api-source-${durableSourceSequence}`,
      ...overrides,
    }),
  );
}

async function enqueueDurableEntry(queue, overrides = {}) {
  durableSourceSequence += 1;
  return queue.enqueueDurable(
    canonicalTestQueueInput({
      threadId: 't1',
      userId: 'user-a',
      kind: 'conversation_input',
      content: 'hello',
      source: 'user',
      sourceId: `queue-api-source-${durableSourceSequence}`,
      ownerAuthProvenance: 'unknown',
      targetCats: ['opus'],
      intent: 'execute',
      ...overrides,
    }),
  );
}

function mockSourceMessage(deps, messageId, overrides = {}) {
  const source = {
    id: messageId,
    threadId: 't1',
    userId: 'user-a',
    content: 'hello',
    from: { kind: 'user', userId: 'user-a' },
    deliveryStatus: 'queued',
    timestamp: 1,
    ...overrides,
  };
  deps.messageStore.getById.mock.mockImplementation(async (id) => (id === messageId ? source : null));
  return source;
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

async function markHeadProcessing(queue, userId = 'user-a') {
  const head = queue.peekNextQueued('t1', userId);
  assert.ok(head);
  const targetCatId = queueEntryTargetCats(head)[0] ?? 'opus';
  const claimed = await queue.markProcessingDurable('t1', userId, {
    entryId: head.id,
    targetCats: [targetCatId],
  });
  assert.ok(claimed);
  return queue.getEntrySnapshot('t1', userId, head.id);
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

  it('GET /queue projects one pending source row and never manufactures delivery state', async () => {
    enqueueEntry(deps.invocationQueue, {
      content: 'two targets',
      targetCats: ['opus', 'codex'],
      messageId: 'msg-1',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 200);
    assert.equal(body.queue.length, 1);
    assert.deepEqual(body.queue[0].targetCats, ['opus', 'codex']);
    assert.equal('targetStates' in body.queue[0], false);
    assert.equal('recoveryActions' in body.queue[0], false);
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

  it('GET /queue projects Append only from the exact supporting Active Run dispatcher', async () => {
    const queued = enqueueEntry(deps.invocationQueue, { ownerAuthProvenance: 'strict', messageId: 'message-1' });
    const activeRun = {
      threadId: 't1',
      targetId: 'opus',
      invocationId: 'turn-1',
      responseMessageId: 'response-1',
      inputEntryIds: ['entry-old'],
      inputMessageIds: ['message-old'],
      privateInputEntryIds: [],
      startedAt: 100,
    };
    deps.invocationTracker.getActiveSlots.mock.mockImplementation(() => [{ catId: 'opus', startedAt: 100, activeRun }]);
    deps.invocationTracker.getUserId.mock.mockImplementation(() => 'user-a');
    deps.invocationTracker.getAgentClientActiveRunDispatcher = mock.fn(() => ({
      invocationId: 'turn-1',
      capabilities: { append: true, steer: true },
      handle: { provider: 'openai_codex', carrier: 'codex_app_server', threadId: 'native-1', turnId: 'turn-1' },
      dispatch: async () => ({ accepted: true, handle: {} }),
    }));

    const available = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(available.body);
    assert.equal(body.queueRevision, deps.invocationQueue.snapshotRevision('t1', 'user-a'));
    assert.deepEqual(body.queue[0].lifecycleActions.append, {
      kind: 'append',
      expectedQueueRevision: body.queueRevision,
      expectedRuns: [{ targetId: 'opus', invocationId: 'turn-1', responseMessageId: 'response-1' }],
    });

    deps.invocationTracker.getAgentClientActiveRunDispatcher.mock.mockImplementation(() => undefined);
    const unsupported = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(JSON.parse(unsupported.body).queue[0].lifecycleActions, undefined);
    assert.equal(deps.invocationQueue.list('t1', 'user-a')[0].id, queued.entry.id);
  });

  it('POST /queue/:entryId/append forwards only the echoed server fences', async () => {
    const queued = enqueueEntry(deps.invocationQueue, { ownerAuthProvenance: 'strict', messageId: 'message-1' });
    const payload = {
      expectedQueueRevision: deps.invocationQueue.snapshotRevision('t1', 'user-a'),
      expectedRuns: [{ targetId: 'opus', invocationId: 'turn-1', responseMessageId: 'response-1' }],
    };
    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/append`,
      headers: { 'x-cat-cafe-user': 'user-a' },
      payload,
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(deps.queueProcessor.appendExactEntry.mock.calls[0].arguments[0], {
      threadId: 't1',
      userId: 'user-a',
      entryId: queued.entry.id,
      ...payload,
    });
  });

  it('POST /queue/:entryId/continue appends to the exact active run without canceling it', async () => {
    const queued = await enqueueDurableEntry(deps.invocationQueue, { targetCats: [] });
    deps.invocationTracker.has.mock.mockImplementation((_threadId, catId) => catId === 'opus');
    deps.invocationTracker.getUserId.mock.mockImplementation(() => 'user-a');
    deps.invocationTracker.getExecutionId.mock.mockImplementation(() => 'turn-1');

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/continue`,
      headers: { 'x-cat-cafe-user': 'user-a' },
      payload: { targetCatId: 'opus' },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().outcome, 'appended');
    assert.deepEqual(deps.queueProcessor.tryAutoAppendExactEntry.mock.calls[0].arguments[0], {
      threadId: 't1',
      userId: 'user-a',
      entryId: queued.entry.id,
    });
    assert.equal(deps.invocationTracker.cancel.mock.calls.length, 0);
    const bound = deps.invocationQueue.getEntrySnapshot('t1', 'user-a', queued.entry.id);
    assert.deepEqual(bound?.targets, ['opus']);
    assert.equal(bound?.delivery.authorIntentByTarget?.opus?.requested, 'continue_current');
    assert.equal(bound?.delivery.authorIntentByTarget?.opus?.boundParentInvocationId, 'turn-1');
  });

  it('POST /queue/:entryId/continue keeps unsupported active carriers as next work without canceling', async () => {
    const queued = await enqueueDurableEntry(deps.invocationQueue, { targetCats: [] });
    deps.invocationTracker.has.mock.mockImplementation((_threadId, catId) => catId === 'codex');
    deps.invocationTracker.getUserId.mock.mockImplementation(() => 'user-a');
    deps.invocationTracker.getExecutionId.mock.mockImplementation(() => 'turn-kimi');
    deps.resolveCarrierCapability.mock.mockImplementation(() => ({
      provider: 'other',
      carrier: 'other',
      deliverySemantics: 'unsupported',
    }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/continue`,
      headers: { 'x-cat-cafe-user': 'user-a' },
      payload: { targetCatId: 'codex' },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      outcome: 'queued',
      targetCatId: 'codex',
      effective: 'next_work',
      reason: 'unsupported_carrier',
    });
    assert.equal(deps.queueProcessor.tryAutoAppendExactEntry.mock.calls.length, 0);
    assert.equal(deps.invocationTracker.cancel.mock.calls.length, 0);
    assert.equal(deps.queueProcessor.requestDrain.mock.calls.length, 1);
    const bound = deps.invocationQueue.getEntrySnapshot('t1', 'user-a', queued.entry.id);
    assert.deepEqual(bound?.targets, ['codex']);
    assert.equal(bound?.delivery.authorIntentByTarget?.codex?.requested, 'continue_current');
    assert.equal(bound?.delivery.authorIntentByTarget?.codex?.fallbackReason, 'unsupported_carrier');
  });

  it('POST /queue/:entryId/targets atomically merges targets into one source row', async () => {
    const messageId = 'message-steer-targets';
    const queued = await enqueueDurableEntry(deps.invocationQueue, {
      sourceId: messageId,
      messageId,
      targetCats: ['opus'],
    });
    assert.equal(await deps.invocationQueue.setPositionDurable('t1', 'user-a', queued.entry.id, 3), true);
    mockSourceMessage(deps, messageId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/targets`,
      headers: { 'x-cat-cafe-user': 'user-a' },
      payload: {
        sourceRecordId: messageId,
        observedPendingTargetIds: ['opus'],
        targets: [
          { targetCatId: 'opus', strategy: 'guide_reply', membershipAtOpen: 'member' },
          { targetCatId: 'codex', strategy: 'interrupt_reply', membershipAtOpen: 'member' },
        ],
      },
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(
      res.json().targets.map((target) => ({ targetCatId: target.targetCatId, strategy: target.strategy })),
      [
        { targetCatId: 'opus', strategy: 'guide_reply' },
        { targetCatId: 'codex', strategy: 'interrupt_reply' },
      ],
    );
    const rows = deps.invocationQueue.list('t1', 'user-a');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].targets, ['opus', 'codex']);
    assert.equal(rows[0].position, 3, 'target edits preserve source FIFO position');
    assert.equal(deps.queueProcessor.requestDrain.mock.calls.length, 1);
  });

  it('POST /queue/:entryId/targets atomically binds a targetless source row', async () => {
    const messageId = 'message-steer-targetless-fanout';
    const queued = await enqueueDurableEntry(deps.invocationQueue, {
      sourceId: messageId,
      messageId,
      targetCats: [],
    });
    mockSourceMessage(deps, messageId);

    const payload = {
      sourceRecordId: messageId,
      observedPendingTargetIds: [],
      targets: [
        { targetCatId: 'opus', strategy: 'guide_reply', membershipAtOpen: 'member' },
        { targetCatId: 'codex', strategy: 'interrupt_reply', membershipAtOpen: 'member' },
      ],
    };
    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/targets`,
      headers: { 'x-cat-cafe-user': 'user-a' },
      payload,
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(
      res.json().targets.map((target) => ({
        entryId: target.entryId,
        targetCatId: target.targetCatId,
        strategy: target.strategy,
      })),
      [
        { entryId: queued.entry.id, targetCatId: 'opus', strategy: 'guide_reply' },
        { entryId: queued.entry.id, targetCatId: 'codex', strategy: 'interrupt_reply' },
      ],
    );
    const rows = deps.invocationQueue.list('t1', 'user-a');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].targets, ['opus', 'codex']);

    const replay = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/targets`,
      headers: { 'x-cat-cafe-user': 'user-a' },
      payload,
    });
    assert.equal(replay.statusCode, 200, replay.body);
    assert.equal(deps.invocationQueue.list('t1', 'user-a').length, 1);
  });

  it('POST /queue/:entryId/targets admits a newly selected available member into the thread at confirmation', async () => {
    const messageId = 'message-steer-new-participant';
    const queued = await enqueueDurableEntry(deps.invocationQueue, {
      sourceId: messageId,
      messageId,
      targetCats: [],
    });
    mockSourceMessage(deps, messageId);

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/targets`,
      headers: { 'x-cat-cafe-user': 'user-a' },
      payload: {
        sourceRecordId: messageId,
        observedPendingTargetIds: [],
        targets: [{ targetCatId: 'kimi', strategy: 'interrupt_reply', membershipAtOpen: 'admit' }],
      },
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().targets, [
      { entryId: queued.entry.id, targetCatId: 'kimi', strategy: 'interrupt_reply' },
    ]);
    assert.deepEqual(deps.threadStore.addParticipants.mock.calls[0].arguments, ['t1', ['kimi']]);
    assert.deepEqual((await deps.threadStore.get('t1')).participants, ['opus', 'codex', 'kimi']);
    const membershipEvent = deps.socketManager.emitToUser.mock.calls.find(
      (call) => call.arguments[1] === 'thread_updated',
    );
    assert.deepEqual(membershipEvent?.arguments[2], {
      threadId: 't1',
      participants: ['opus', 'codex', 'kimi'],
    });
  });

  it('POST /queue/:entryId/targets skips a target that became unavailable', async () => {
    const messageId = 'message-steer-unavailable';
    const queued = await enqueueDurableEntry(deps.invocationQueue, {
      sourceId: messageId,
      messageId,
      targetCats: ['opus'],
    });
    mockSourceMessage(deps, messageId);
    deps.isCatAvailable.mock.mockImplementation((catId) => catId !== 'codex');

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/targets`,
      headers: { 'x-cat-cafe-user': 'user-a' },
      payload: {
        sourceRecordId: messageId,
        observedPendingTargetIds: ['opus'],
        targets: [
          { targetCatId: 'opus', strategy: 'guide_reply', membershipAtOpen: 'member' },
          { targetCatId: 'codex', strategy: 'interrupt_reply', membershipAtOpen: 'member' },
        ],
      },
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().targets, [{ targetCatId: 'opus', strategy: 'guide_reply', entryId: queued.entry.id }]);
    assert.deepEqual(deps.invocationQueue.list('t1', 'user-a')[0].targets, ['opus']);
  });

  it('POST /queue/:entryId/targets normalizes stale unsupported guide requests to interrupt', async () => {
    const messageId = 'message-steer-unsupported';
    const queued = await enqueueDurableEntry(deps.invocationQueue, {
      sourceId: messageId,
      messageId,
      targetCats: ['opus'],
    });
    mockSourceMessage(deps, messageId);
    deps.resolveCarrierCapability.mock.mockImplementation(() => ({
      provider: 'anthropic',
      carrier: 'claude_print_sdk',
      deliverySemantics: 'unsupported',
    }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/targets`,
      headers: { 'x-cat-cafe-user': 'user-a' },
      payload: {
        sourceRecordId: messageId,
        observedPendingTargetIds: ['opus'],
        targets: [{ targetCatId: 'opus', strategy: 'guide_reply', membershipAtOpen: 'member' }],
      },
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().targets, [
      { targetCatId: 'opus', strategy: 'interrupt_reply', entryId: queued.entry.id },
    ]);
  });

  it('POST /queue/:entryId/targets treats a target delivered while the modal was open as an idempotent no-op', async () => {
    const messageId = 'message-steer-terminal';
    const queued = await enqueueDurableEntry(deps.invocationQueue, {
      sourceId: messageId,
      messageId,
      targetCats: ['opus', 'codex'],
    });
    const source = mockSourceMessage(deps, messageId, {
      lifecycle: {
        kind: 'source',
        sourceId: messageId,
        dispatchRefs: [
          {
            targetId: 'opus',
            phase: 'dispatched',
            statusMessageId: 'response-opus',
            dispatchedAt: 1234,
          },
        ],
      },
    });
    const claimed = await deps.invocationQueue.claimExactSteerEntryDurable('t1', 'user-a', queued.entry.id, 'opus');
    assert.equal(claimed.outcome, 'claimed');
    assert.ok(await deps.invocationQueue.commitClaimedAdoptionDurable('t1', 'user-a', queued.entry.id, 'opus'));
    assert.equal(source.lifecycle.dispatchRefs[0].targetId, 'opus');

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/targets`,
      headers: { 'x-cat-cafe-user': 'user-a' },
      payload: {
        sourceRecordId: messageId,
        observedPendingTargetIds: ['opus', 'codex'],
        targets: [
          { targetCatId: 'opus', strategy: 'interrupt_reply', membershipAtOpen: 'member' },
          { targetCatId: 'codex', strategy: 'interrupt_reply', membershipAtOpen: 'member' },
        ],
      },
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().skippedAlreadyDispatched, ['opus']);
    assert.deepEqual(res.json().targets, [
      { targetCatId: 'codex', strategy: 'interrupt_reply', entryId: queued.entry.id },
    ]);
    assert.deepEqual(deps.invocationQueue.list('t1', 'user-a')[0].targets, ['codex']);
  });

  it('GET /queue/:entryId/targets joins pending Queue targets with delivered History refs', async () => {
    const messageId = 'message-steer-target-context';
    const queued = await enqueueDurableEntry(deps.invocationQueue, {
      sourceId: messageId,
      messageId,
      targetCats: ['opus', 'codex'],
    });
    mockSourceMessage(deps, messageId, {
      lifecycle: {
        kind: 'source',
        sourceId: messageId,
        dispatchRefs: [
          {
            targetId: 'opus',
            phase: 'settled',
            statusMessageId: 'response-opus',
            dispatchedAt: 1234,
          },
        ],
      },
    });
    const claimed = await deps.invocationQueue.claimExactSteerEntryDurable('t1', 'user-a', queued.entry.id, 'opus');
    assert.equal(claimed.outcome, 'claimed');
    assert.ok(await deps.invocationQueue.commitClaimedAdoptionDurable('t1', 'user-a', queued.entry.id, 'opus'));

    const res = await app.inject({
      method: 'GET',
      url: `/api/threads/t1/queue/${queued.entry.id}/targets`,
      headers: { 'x-cat-cafe-user': 'user-a' },
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json(), {
      sourceRecordId: messageId,
      targets: [
        { targetCatId: 'codex', state: 'pending', actionable: true },
        {
          targetCatId: 'opus',
          state: 'settled',
          actionable: false,
          dispatchedAt: 1234,
          statusMessageId: 'response-opus',
        },
      ],
    });
  });

  it('POST /queue/:entryId/targets skips a member removed after the modal snapshot', async () => {
    const messageId = 'message-steer-removed-member';
    const queued = await enqueueDurableEntry(deps.invocationQueue, {
      sourceId: messageId,
      messageId,
      targetCats: ['opus'],
    });
    mockSourceMessage(deps, messageId);
    deps.threadStore.get.mock.mockImplementation(async (id) => ({
      id,
      title: 'Test Thread',
      createdBy: 'system',
      participants: ['codex'],
    }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/targets`,
      headers: { 'x-cat-cafe-user': 'user-a' },
      payload: {
        sourceRecordId: messageId,
        observedPendingTargetIds: ['opus'],
        targets: [{ targetCatId: 'opus', strategy: 'interrupt_reply', membershipAtOpen: 'member' }],
      },
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().targets, []);
    assert.equal(deps.invocationQueue.list('t1', 'user-a').length, 0);
    assert.equal(deps.threadStore.addParticipants.mock.calls.length, 0);
  });

  it('GET /queue projects one pending row with the complete target set', async () => {
    const queued = enqueueEntry(deps.invocationQueue, {
      content: 'three targets',
      targetCats: ['opus', 'codex', 'gpt52'],
      messageId: 'msg-1',
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 200);
    assert.equal(body.queue.length, 1);
    assert.deepEqual(body.queue[0].targetCats, ['opus', 'codex', 'gpt52']);
    assert.equal('targetStates' in body.queue[0], false);
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

  it('does not expose a thread-wide manual Continue endpoint', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/threads/t1/queue/next',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(res.statusCode, 404);
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
    const persisted = deps.invocationQueue.getEntrySnapshot('t1', 'user-a', queued.entry.id);
    assert.equal(persisted.delivery.reminderAttempts.length, 1);
    assert.equal(persisted.delivery.reminderAttempts[0].id, body.reminderId);
    assert.equal(persisted.delivery.reminderAttempts[0].invocationId, 'inv-active');
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
    assert.equal(
      deps.invocationQueue.getEntrySnapshot('t1', 'user-a', queued.entry.id).delivery.reminderAttempts,
      undefined,
    );
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
    assert.equal(
      deps.invocationQueue.getEntrySnapshot('t1', 'user-a', queued.entry.id).delivery.reminderAttempts,
      undefined,
    );
  });

  it('POST /queue/:entryId/remind returns the existing exact attempt idempotently', async () => {
    const queued = enqueueEntry(deps.invocationQueue, { targetCats: ['opus'] });
    deps.invocationTracker.has.mock.mockImplementation(() => true);
    deps.invocationTracker.getUserId.mock.mockImplementation(() => 'user-a');
    deps.invocationTracker.getExecutionId.mock.mockImplementation(() => 'inv-active');
    await deps.invocationQueue.requestReminderDurable(
      't1',
      'user-a',
      queued.entry.id,
      'opus',
      'inv-active',
      'reminder-existing',
      1,
    );
    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/remind`,
      headers: { 'x-cat-cafe-user': 'user-a' },
      payload: { targetCatId: 'opus' },
    });
    const body = JSON.parse(res.body);

    assert.equal(res.statusCode, 200);
    assert.equal(body.reminderId, 'reminder-existing');
    assert.equal(body.state, 'requested');
    assert.equal(body.idempotent, true);
    assert.equal(
      deps.invocationQueue.getEntrySnapshot('t1', 'user-a', queued.entry.id).delivery.reminderAttempts.length,
      1,
    );
  });

  it('GET /queue does not project thread-wide pause state', async () => {
    enqueueEntry(deps.invocationQueue);

    const res = await app.inject({
      method: 'GET',
      url: '/api/threads/t1/queue',
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    const body = JSON.parse(res.body);
    assert.equal(Object.hasOwn(body, 'paused'), false);
    assert.equal(Object.hasOwn(body, 'pauseReason'), false);
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

  it('DELETE /queue/:entryId withdraws the pending row and cancels its hidden source', async () => {
    const r = enqueueEntry(deps.invocationQueue, {
      ownerAuthProvenance: 'strict',
      messageId: 'msg-withdrawn',
    });

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
    assert.equal('messageReceipts' in updateCall.arguments[2], false);
    assert.deepEqual(deps.messageStore.markCanceled.mock.calls[0].arguments, ['msg-withdrawn']);
    const deleted = deps.socketManager.emitToUser.mock.calls.find((call) => call.arguments[1] === 'message_deleted');
    assert.equal(deleted, undefined);
  });

  it('DELETE /queue/:entryId restores the actionable entry when durable withdrawal fails', async () => {
    const r = enqueueEntry(deps.invocationQueue, { ownerAuthProvenance: 'strict', messageId: 'msg-fail' });
    deps.messageStore.markCanceled.mock.mockImplementation(async () => {
      throw new Error('message store unavailable');
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

  it('DELETE /queue/:entryId rejects a live reversible claim (409)', async () => {
    enqueueEntry(deps.invocationQueue);
    await markHeadProcessing(deps.invocationQueue);

    const entries = deps.invocationQueue.list('t1', 'user-a');
    const processingEntry = entries.find((e) => e.status === 'claimed');

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/threads/t1/queue/${processingEntry.id}`,
      headers: { 'x-cat-cafe-user': 'user-a' },
    });
    assert.equal(res.statusCode, 409);
  });

  // ── Functional: DELETE clear ──

  it('DELETE /queue clears all entries for user', async () => {
    enqueueEntry(deps.invocationQueue, {
      targetCats: ['a'],
      ownerAuthProvenance: 'strict',
      messageId: 'msg-clear-a',
    });
    enqueueEntry(deps.invocationQueue, { targetCats: ['b'], messageId: 'msg-clear-b' });

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
    assert.equal('messageReceipts' in updateCall.arguments[2], false);
    assert.deepEqual(
      deps.messageStore.markCanceled.mock.calls.map((call) => call.arguments[0]),
      ['msg-clear-a', 'msg-clear-b'],
    );
    const deleted = deps.socketManager.emitToUser.mock.calls.find((call) => call.arguments[1] === 'message_deleted');
    assert.equal(deleted, undefined);
  });

  it('DELETE /queue retires each exact managed-wake producer after durable carrier withdrawal', async () => {
    const events = [];
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
    assert.deepEqual(events, ['retire:message-managed-wake:withdrawn']);
    assert.equal(deps.invocationQueue.list('t1', 'user-a').length, 0);
  });

  it('DELETE /queue reports partial durable withdrawal and keeps every unsettled entry actionable', async () => {
    const first = enqueueEntry(deps.invocationQueue, {
      targetCats: ['a'],
      ownerAuthProvenance: 'strict',
      messageId: 'msg-partial-a',
    });
    const second = enqueueEntry(deps.invocationQueue, { targetCats: ['b'], messageId: 'msg-partial-b' });
    const third = enqueueEntry(deps.invocationQueue, { targetCats: ['c'], messageId: 'msg-partial-c' });
    let calls = 0;
    deps.messageStore.markCanceled.mock.mockImplementation(async () => {
      calls += 1;
      if (calls === 2) throw new Error('message store unavailable');
      return { deliveryStatus: 'canceled', deliveryTransitioned: true };
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
    assert.equal(queue[0].payload.content, 'second');
    assert.equal(queue[1].payload.content, 'first');

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
    assert.equal(queue[0].payload.content, 'second');
  });

  it('PATCH /queue/:entryId/move rejects a live reversible claim (409)', async () => {
    enqueueEntry(deps.invocationQueue);
    await markHeadProcessing(deps.invocationQueue);

    const entries = deps.invocationQueue.list('t1', 'user-a');
    const processingEntry = entries.find((e) => e.status === 'claimed');

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

  it('POST /queue/steer does not preempt when the durable claim loses', async () => {
    const target = (
      await enqueueDurableEntry(deps.invocationQueue, {
        content: 'steer me',
        ownerAuthProvenance: 'strict',
      })
    ).entry;
    deps.invocationTracker.has = mock.fn(() => true);
    deps.invocationTracker.getUserId = mock.fn(() => 'user-a');
    deps.invocationTracker.cancel = mock.fn(() => ({ cancelled: true, catIds: ['opus'], executionIds: ['inv-a'] }));
    deps.invocationQueue.claimExactSteerEntryDurable = mock.fn(async () => ({
      outcome: 'rejected',
      reason: 'entry_processing',
    }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${target.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {},
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json().code, 'ENTRY_PROCESSING');
    assert.equal(
      deps.invocationTracker.cancel.mock.calls.length,
      0,
      'a refused steer must not have cancelled the running turn',
    );
  });

  it('POST /queue/:entryId/steer binds a targetless message to the selected current-thread member', async () => {
    const queued = await enqueueDurableEntry(deps.invocationQueue, {
      content: 'pick one member',
      ownerAuthProvenance: 'strict',
      targetCats: [],
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { targetCatId: 'codex' },
    });

    assert.equal(res.statusCode, 200);
    assert.deepEqual(deps.queueProcessor.processClaimedSteerEntries.mock.calls[0].arguments, [
      't1',
      'user-a',
      [queued.entry.id],
      'codex',
    ]);
  });

  it('POST /queue/:entryId/steer rejects a targetless message without a current-thread member selection', async () => {
    const queued = await enqueueDurableEntry(deps.invocationQueue, { targetCats: [] });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {},
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'STEER_TARGET_REQUIRED');
  });

  it('POST /queue/:entryId/steer rejects a member outside the current thread before reservation', async () => {
    const queued = await enqueueDurableEntry(deps.invocationQueue, { targetCats: [] });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { targetCatId: 'outsider' },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().code, 'INVALID_STEER_TARGET');
    assert.equal(deps.invocationQueue.getEntrySnapshot('t1', 'user-a', queued.entry.id)?.status, 'queued');
  });

  it('POST /queue/:entryId/steer does not preempt when the durable claim store fails', async () => {
    const target = (
      await enqueueDurableEntry(deps.invocationQueue, {
        content: 'steer me',
        ownerAuthProvenance: 'strict',
      })
    ).entry;
    deps.invocationTracker.has = mock.fn(() => true);
    deps.invocationTracker.getUserId = mock.fn(() => 'user-a');
    deps.invocationTracker.cancel = mock.fn(() => ({ cancelled: true, catIds: ['opus'], executionIds: ['inv-a'] }));
    deps.invocationQueue.claimExactSteerEntryDurable = mock.fn(async () => {
      throw new Error('ledger unavailable');
    });

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${target.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {},
    });

    assert.equal(res.statusCode, 503);
    assert.equal(res.json().code, 'STEER_CLAIM_FAILED');
    assert.equal(
      deps.invocationTracker.cancel.mock.calls.length,
      0,
      'an unpersistable reservation must not have cancelled the running turn',
    );
    const after = deps.invocationQueue.list('t1', 'user-a').find((entry) => entry.id === target.id);
    assert.equal(after.status, 'queued');
  });

  it('POST /queue/:entryId/steer keeps the ledger claim across the preemption await', async () => {
    const inflight = (
      await enqueueDurableEntry(deps.invocationQueue, {
        content: 'inflight',
        ownerAuthProvenance: 'strict',
        targetCats: ['opus'],
      })
    ).entry;
    await markHeadProcessing(deps.invocationQueue);
    const target = (
      await enqueueDurableEntry(deps.invocationQueue, {
        content: 'steer after preemption',
        ownerAuthProvenance: 'strict',
        targetCats: ['opus'],
      })
    ).entry;
    const preemptionGate = asyncGate();
    deps.invocationTracker.has = mock.fn(() => false);
    deps.queueProcessor.finalizeRemovedEntry = mock.fn(async (removed) => {
      assert.equal(removed.id, inflight.id);
      preemptionGate.enter();
      await preemptionGate.blocked;
      return true;
    });
    const responsePromise = app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${target.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {},
    });
    await preemptionGate.entered;

    assert.equal(deps.invocationQueue.getEntrySnapshot('t1', 'user-a', target.id)?.status, 'claimed');
    assert.equal(await deps.invocationQueue.markProcessingByIdDurable('t1', target.id, 'opus'), null);
    preemptionGate.release();

    const res = await responsePromise;
    assert.equal(res.statusCode, 200);
    assert.deepEqual(deps.queueProcessor.processClaimedSteerEntries.mock.calls[0].arguments, [
      't1',
      'user-a',
      [target.id],
      'opus',
    ]);
  });

  it('POST /queue/:entryId/steer restores the claimed row when preemption is refused', async () => {
    const target = (
      await enqueueDurableEntry(deps.invocationQueue, {
        content: 'steer me',
        ownerAuthProvenance: 'strict',
      })
    ).entry;
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
    assert.equal(after.status, 'queued');
    assert.equal(after.steerRequestedByCatIds, undefined);
  });

  it('POST /queue/:entryId/steer rejects promote because Steer has one cancel-and-restart meaning', async () => {
    const queued = await enqueueDurableEntry(deps.invocationQueue, { content: 'queued correction' });

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
    const queued = await enqueueDurableEntry(deps.invocationQueue, {
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

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {},
    });

    assert.equal(res.statusCode, 200);
    assert.equal(Object.hasOwn(JSON.parse(res.body).entry, 'ownerAuthProvenance'), false);
    assert.equal(deps.invocationTracker.cancel.mock.calls.length, 1);
    assert.equal(deps.queueProcessor.processClaimedSteerEntries.mock.calls.length, 1);
  });

  it('POST /queue/:entryId/steer restores the pending target when immediate restart cannot begin', async () => {
    const queued = await enqueueDurableEntry(deps.invocationQueue, { content: 'queued correction' });
    deps.invocationTracker.has = mock.fn(() => true);
    deps.invocationTracker.getUserId = mock.fn(() => 'user-a');
    deps.invocationTracker.cancel = mock.fn(() => ({
      cancelled: true,
      catIds: ['opus'],
      executionIds: ['inv-active'],
    }));
    deps.queueProcessor.processClaimedSteerEntries = mock.fn(async () => ({ started: false }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${queued.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {},
    });

    assert.equal(res.statusCode, 503);
    const updates = deps.socketManager.emitToUser.mock.calls
      .filter((call) => call.arguments[1] === 'queue_updated')
      .map((call) => call.arguments[2]);
    assert.equal(updates.at(-1)?.action, 'steer_failed');
    assert.deepEqual(updates.at(-1)?.queue[0].targetCats, ['opus']);
    assert.equal('targetStates' in updates.at(-1)?.queue[0], false);
  });

  it('POST /queue/:entryId/steer returns 409 when entry is processing', async () => {
    await enqueueDurableEntry(deps.invocationQueue);
    await markHeadProcessing(deps.invocationQueue);
    const entries = deps.invocationQueue.list('t1', 'user-a');
    const processingEntry = entries.find((e) => e.status === 'claimed');

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${processingEntry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: {},
    });
    assert.equal(res.statusCode, 409);
  });

  it('POST /queue/:entryId/steer immediate cancels active invocation and starts processing', async () => {
    const r1 = await enqueueDurableEntry(deps.invocationQueue, { content: 'first' });
    await enqueueDurableEntry(deps.invocationQueue, { content: 'second' });

    deps.invocationTracker.has = mock.fn(() => true);
    deps.invocationTracker.getUserId = mock.fn(() => 'user-a');
    deps.invocationTracker.cancel = mock.fn(() => ({
      cancelled: true,
      catIds: ['codex'],
      executionIds: ['inv-active'],
    }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${r1.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { mode: 'immediate' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(deps.invocationTracker.cancel.mock.calls.length, 1);
    assert.equal(deps.queueProcessor.processClaimedSteerEntries.mock.calls.length, 1);
    assert.deepEqual(deps.agentSessionMutex.forceReleaseByScope.mock.calls[0].arguments, [
      { threadId: 't1', userId: 'user-a', catId: 'opus' },
      { preserveHolderExecutionIds: ['inv-active'] },
    ]);
    // The durable canceled response owns the visible terminal; transport emits
    // one done event so the frontend clears the old invocation without a
    // duplicate centered cancellation notice.
    const broadcastCalls = deps.socketManager.broadcastAgentMessage.mock.calls;
    assert.ok(broadcastCalls.length >= 1, 'should broadcast done for canceled invocation');
    const doneCall = broadcastCalls.find((c) => c.arguments[0].type === 'done');
    assert.ok(doneCall, 'should broadcast done event to clear frontend loading state');
    assert.equal(doneCall.arguments[0].isFinal, true);
  });

  it('POST /queue/:entryId/steer immediate releases QueueProcessor mutex after cancel (P2 race)', async () => {
    const r1 = await enqueueDurableEntry(deps.invocationQueue, { content: 'first' });
    await enqueueDurableEntry(deps.invocationQueue, { content: 'second' });

    deps.invocationTracker.has = mock.fn(() => true);
    deps.invocationTracker.getUserId = mock.fn(() => 'user-a');
    deps.invocationTracker.cancel = mock.fn(() => ({ cancelled: true, catIds: ['codex'] }));

    let locked = true;
    deps.queueProcessor.releaseSlot = mock.fn(() => {
      locked = false;
    });
    deps.queueProcessor.processClaimedSteerEntries = mock.fn(async () => ({
      started: !locked,
      entry: r1.entry,
    }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${r1.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { mode: 'immediate' },
    });
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(deps.queueProcessor.releaseSlot.mock.calls.length, 1);
  });

  it('POST /queue/:entryId/steer immediate TOMBSTONES a pre-start in-flight entry instead of force-releasing (race-safe, 云端 R3 P1)', async () => {
    // In-flight entry A occupies the opus per-cat slot (processing), e.g. its executeEntry is in the
    // pre-start create-await window so invocationTracker.has(opus) is false. The user steers a second
    // opus entry B. Force-releasing A's slot would double-start opus once create returns; instead
    // steer must TOMBSTONE A (removeProcessed) so executeEntry self-aborts, and NOT force-release.
    const a = await enqueueDurableEntry(deps.invocationQueue, { content: 'inflight', targetCats: ['opus'] });
    await markHeadProcessing(deps.invocationQueue); // A → processing (holds opus slot)
    const b = await enqueueDurableEntry(deps.invocationQueue, { content: 'steered', targetCats: ['opus'] });

    deps.invocationTracker.has = mock.fn(() => false); // pre-start: tracker not yet registered
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
    assert.equal(
      deps.invocationQueue.list('t1', 'user-a').some((entry) => entry.id === a.entry.id),
      false,
      'in-flight A must be tombstoned',
    );
    assert.equal(deps.invocationQueue.findProcessingByCat('t1', 'opus')?.id, b.entry.id);
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
    const other = await enqueueDurableEntry(deps.invocationQueue, {
      userId: 'user-b',
      content: 'other-inflight',
      targetCats: ['opus'],
    });
    await markHeadProcessing(deps.invocationQueue, 'user-b'); // user-b's entry → processing (holds opus slot)
    const mine = await enqueueDurableEntry(deps.invocationQueue, {
      userId: 'user-a',
      content: 'mine',
      targetCats: ['opus'],
    });

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
    await enqueueDurableEntry(deps.invocationQueue, {
      userId: 'user-a',
      content: 'old-inflight',
      targetCats: ['opus'],
    });
    await markHeadProcessing(deps.invocationQueue);
    const old = deps.invocationQueue.findProcessingByCat('t1', 'opus');
    old.processingStartedAt = Date.now() - 60 * 60_000; // 1h old — still must NOT force-release
    const steered = await enqueueDurableEntry(deps.invocationQueue, {
      userId: 'user-a',
      content: 'steered',
      targetCats: ['opus'],
    });

    deps.invocationTracker.has = mock.fn(() => false);

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
    await enqueueDurableEntry(deps.invocationQueue, {
      userId: 'user-a',
      content: 'inflight',
      targetCats: ['opus'],
      messageId: 'msg-inflight',
    });
    await markHeadProcessing(deps.invocationQueue);
    const inflight = deps.invocationQueue.findProcessingByCat('t1', 'opus');
    assert.equal(inflight.payload.messageId, 'msg-inflight');
    const steered = await enqueueDurableEntry(deps.invocationQueue, {
      userId: 'user-a',
      content: 'steered',
      targetCats: ['opus'],
    });

    deps.invocationTracker.has = mock.fn(() => false);

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
    await enqueueDurableEntry(deps.invocationQueue, {
      userId: 'user-a',
      content: 'inflight',
      targetCats: ['opus'],
      messageId: 'msg-already-delivered',
    });
    await markHeadProcessing(deps.invocationQueue);
    const inflight = deps.invocationQueue.findProcessingByCat('t1', 'opus');
    assert.equal(inflight.payload.messageId, 'msg-already-delivered');
    const steered = await enqueueDurableEntry(deps.invocationQueue, {
      userId: 'user-a',
      content: 'steered',
      targetCats: ['opus'],
    });

    deps.invocationTracker.has = mock.fn(() => false);
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
    const r1 = await enqueueDurableEntry(deps.invocationQueue, { content: 'first', targetCats: ['opus'] });
    await enqueueDurableEntry(deps.invocationQueue, { content: 'second' });

    deps.invocationTracker.has = mock.fn(() => true);
    deps.invocationTracker.getUserId = mock.fn(() => 'user-a');
    // cancel returns multi-cat catIds (co-dispatched), but steer targets only opus
    deps.invocationTracker.cancel = mock.fn(() => ({ cancelled: true, catIds: ['opus', 'codex'] }));

    const res = await app.inject({
      method: 'POST',
      url: `/api/threads/t1/queue/${r1.entry.id}/steer`,
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { mode: 'immediate' },
    });
    assert.equal(res.statusCode, 200, res.body);

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
    const r = await enqueueDurableEntry(deps.invocationQueue, { userId: 'user-a' });
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

  it('POST /cancel/:catId leaves an executing Queue reservation for normal completion to drain', async () => {
    await enqueueDurableEntry(deps.invocationQueue, { content: 'currently executing' });
    await markHeadProcessing(deps.invocationQueue);
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

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(
      deps.queueProcessor.releaseSlot.mock.calls.length,
      0,
      'the canceled execute promise still owns retirement and the following Queue drain',
    );
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
    assert.equal(next.payload.content, 'c', 'entry c should be first after reorder');

    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const updateCall = emitCalls.find((c) => c.arguments[1] === 'queue_updated');
    assert.ok(updateCall);
    assert.equal(updateCall.arguments[2].action, 'reordered');
  });

  it('PATCH /queue/reorder rejects position on a live reversible claim (F175)', async () => {
    enqueueEntry(deps.invocationQueue, { content: 'a' });
    await markHeadProcessing(deps.invocationQueue);
    const entries = deps.invocationQueue.list('t1', 'user-a');
    const processingEntry = entries.find((e) => e.status === 'claimed');

    const res = await app.inject({
      method: 'PATCH',
      url: '/api/threads/t1/queue/reorder',
      headers: { 'x-cat-cafe-user': 'user-a', 'content-type': 'application/json' },
      payload: { positions: [{ entryId: processingEntry.id, position: 0 }] },
    });
    assert.equal(res.statusCode, 409);
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
