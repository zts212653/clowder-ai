/**
 * PR-3a (docs/plans/2026-11-05-hub-pr3-background-thread-contract.md §2.3): the four stop/repair
 * paths that end a cat's turn outside the QueueProcessor must close it the way
 * failUncontrollableInvocation does — child turn terminal first, then R settled from its draft and
 * published to the owner's user room — with `canceled` instead of `failed`.
 *
 *   1. process-owned Stop  (executions/live cancel, controlSource process_owner)
 *   2. inactive reconcile  (executions/live cancel, no tracker, no process owner)
 *   3. per-cat cancel, orphan record branch (POST /cancel/:catId)
 *   4. force-reset
 *
 * Real Message/Draft/InvocationRecord/TurnExecution stores and the real process-wide response
 * producer registry; the live sources (tracker, process owners, QueueProcessor reservations) are
 * scripted so each journey reaches exactly one path.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { DraftStore } = await import('../dist/domains/cats/services/stores/ports/DraftStore.js');
const { InvocationRecordStore } = await import('../dist/domains/cats/services/stores/ports/InvocationRecordStore.js');
const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);
const { queueRoutes } = await import('../dist/routes/queue.js');
const { responseProducers } = await import(
  '../dist/domains/cats/services/agents/invocation/response-producer-registry.js'
);

const USER = 'stop-owner';
const THREAD = 'stop-thread';

async function harness() {
  const messageStore = new MessageStore();
  const recordStore = new InvocationRecordStore();
  const turnStore = new InMemoryTurnExecutionStore();
  const draftStore = new DraftStore();
  const invocationQueue = new InvocationQueue();
  const slots = new Map(); // `${catId}` -> { executionId, userId }
  const tombstones = new Map(); // `${catId}` -> { executionId, userId } of a Stopped slot still tearing down
  const reservations = new Map(); // `${catId}` -> parent execution id this process still runs
  const owners = [];
  const ownerSnapshot = { complete: true };
  const termination = { stopped: true };
  // Stands in for a live route of this process that will still commit the claimed turns' R.
  const routeClaims = responseProducers.openRouteScope();
  const emitted = [];
  const broadcasts = [];
  const lockReleases = [];
  const slotReleases = [];
  const prestartRetirements = [];
  const invocationTracker = {
    has: (threadId, catId) => threadId === THREAD && (catId === undefined ? slots.size > 0 : slots.has(catId)),
    getUserId: (_threadId, catId) => slots.get(catId)?.userId ?? null,
    getExecutionId: (_threadId, catId) => slots.get(catId)?.executionId,
    getSlotState: (_threadId, catId) => (slots.has(catId) ? 'active' : tombstones.has(catId) ? 'canceled' : 'absent'),
    getCanceledSlotIdentity: (_threadId, catId) => tombstones.get(catId),
    getActiveSlots: (threadId) =>
      threadId === THREAD ? [...slots.keys()].map((catId) => ({ catId, startedAt: Date.now() - 1_000 })) : [],
    cancel: () => ({ cancelled: false, catIds: [], executionIds: [] }),
    cancelAll: (threadId, userId) => {
      const catIds = [];
      const executionIdByCatId = {};
      for (const [catId, slot] of slots) {
        if (threadId !== THREAD || slot.userId !== userId) continue;
        catIds.push(catId);
        executionIdByCatId[catId] = slot.executionId;
        slots.delete(catId);
      }
      return { catIds, executionIds: Object.values(executionIdByCatId), executionIdByCatId };
    },
  };
  const queueProcessor = {
    canReleaseSlotForUser: () => true,
    hasProcessingSlotReservation: (threadId, catId, executionId) =>
      threadId === THREAD &&
      reservations.has(catId) &&
      (executionId === undefined || reservations.get(catId) === executionId),
    releaseSlot: (_threadId, catId) => slotReleases.push(catId),
    retirePrestartProcessingGroup: async (_threadId, catId) => {
      prestartRetirements.push(catId);
      return 'retired';
    },
    retireThreadPrestartProcessingGroups: async () => ({ outcome: 'none', retiredCatIds: [] }),
    retirePendingPrivateInputs: async () => {},
    suppressAutoResume: () => {},
    hasActiveExecution: () => false,
    isCatBusy: () => false,
    requestDrain: async () => {},
  };
  const app = Fastify({ logger: false });
  await app.register(queueRoutes, {
    threadStore: { get: async (id) => ({ id, title: 'stop', createdBy: USER }) },
    invocationQueue,
    queueProcessor,
    invocationTracker,
    socketManager: {
      broadcastAgentMessage: (message, threadId) => broadcasts.push({ message, threadId }),
      broadcastToRoom() {},
      emitToUser: (userId, event, payload) => emitted.push({ userId, event, payload }),
    },
    messageStore,
    invocationRecordStore: recordStore,
    turnExecutionStore: turnStore,
    draftStore,
    agentSessionMutex: {
      forceReleaseByScope: (scope, options) => {
        lockReleases.push({ scope, options });
        return { releasedHolders: 0, rejectedWaiters: 0, catIds: [] };
      },
    },
    cliExecutionOwnerService: {
      listLive: async () => ({ owners: ownerSnapshot.complete ? [...owners] : [], complete: ownerSnapshot.complete }),
      terminateExact: async () =>
        termination.stopped
          ? { matched: 1, signaled: 1, complete: true, stopped: true }
          : { matched: 1, signaled: 0, complete: false, stopped: false },
    },
  });
  await app.ready();

  let sequence = 0;
  /**
   * One running parent run, one running child turn per cat, each with a processing R and a draft.
   * `withoutTurn` leaves the child turn out of the turn store; `withoutResponse` admits no R.
   */
  function seedRun({ catIds = ['opus'], userId = USER, withoutTurn = false, withoutResponse = false } = {}) {
    sequence += 1;
    const created = recordStore.create({
      threadId: THREAD,
      userId,
      targetCats: catIds,
      intent: 'execute',
      idempotencyKey: `stop-run-${sequence}`,
      actionLeaseCarrier: { kind: 'none' },
    });
    const parentId = created.invocationId;
    recordStore.update(parentId, { status: 'running' });
    const startedAt = Date.now() - 5_000;
    const turns = {};
    for (const catId of catIds) {
      const childId = `turn-${catId}-${sequence}`;
      if (!withoutTurn) {
        turnStore.createRunning({
          invocationId: childId,
          parentInvocationId: parentId,
          threadId: THREAD,
          userId,
          catId,
          executionKind: 'ordinary',
          startedAt,
        });
      }
      const response = withoutResponse
        ? { id: undefined }
        : messageStore.append(
            canonicalTestMessageInput({
              userId,
              threadId: THREAD,
              catId,
              content: '',
              mentions: [],
              timestamp: startedAt,
              idempotencyKey: `message-lifecycle-response:${childId}`,
              lifecycle: {
                kind: 'response',
                orderKey: `${startedAt}:${childId}`,
                invocationId: childId,
                targetId: catId,
                inputEntryIds: [`entry-${childId}`],
                inputMessageIds: [],
                status: 'processing',
                startedAt,
              },
            }),
          );
      if (!withoutResponse)
        draftStore.upsert({
          userId,
          threadId: THREAD,
          invocationId: childId,
          catId,
          content: `${catId} streamed so far`,
          updatedAt: Date.now(),
        });
      turns[catId] = { childId, responseId: response.id };
    }
    return { parentId, turns };
  }

  const stopLive = (executionId, catId) =>
    app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD}/executions/live/${executionId}/cancel`,
      headers: { 'x-cat-cafe-user': USER },
      payload: { catId },
    });
  const cancelCat = (catId) =>
    app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD}/cancel/${catId}`,
      headers: { 'x-cat-cafe-user': USER },
    });
  const forceReset = () =>
    app.inject({
      method: 'POST',
      url: `/api/threads/${THREAD}/force-reset`,
      headers: { 'x-cat-cafe-user': USER },
    });
  const lifecycleSnapshots = (messageId) =>
    emitted.filter((item) => item.event === 'message_lifecycle_updated' && item.payload.message.id === messageId);
  const responseOf = (messageId) => messageStore.getById(messageId);
  const threadRoom = () => broadcasts.filter(({ threadId }) => threadId === THREAD).map(({ message }) => message);

  return {
    app,
    messageStore,
    recordStore,
    turnStore,
    draftStore,
    invocationQueue,
    slots,
    tombstones,
    reservations,
    owners,
    ownerSnapshot,
    termination,
    /** A live route still claims this turn's R. */
    claimResponse: (run, catId) => routeClaims.enter(run.turns[catId].childId),
    releaseResponse: (run, catId) => routeClaims.leave(run.turns[catId].childId),
    emitted,
    lockReleases,
    slotReleases,
    prestartRetirements,
    seedRun,
    stopLive,
    cancelCat,
    forceReset,
    lifecycleSnapshots,
    responseOf,
    threadRoom,
    close: () => {
      routeClaims.leaveAll();
      return app.close();
    },
  };
}

function processOwner(run, catId, userId = USER) {
  return {
    executionId: run.parentId,
    invocationId: run.turns[catId].childId,
    threadId: THREAD,
    catId,
    userId,
    startedAt: Date.now() - 5_000,
  };
}

/** The four assertions every path owes a stopped turn. */
function assertCanceledAndPublished(h, run, catId, { userId = USER, reason = 'user_cancel' } = {}) {
  const { childId, responseId } = run.turns[catId];
  assert.equal(h.turnStore.get(childId).status, 'canceled', `${catId} child turn terminal`);
  assert.equal(h.turnStore.get(childId).terminalReason, reason);
  const response = h.responseOf(responseId);
  assert.equal(response.lifecycle.status, 'canceled', `${catId} R terminal`);
  assert.equal(response.lifecycle.reason, reason);
  assert.equal(response.content, `${catId} streamed so far`, 'R keeps what its draft streamed');
  assert.deepEqual(
    h.draftStore.getByThread(userId, THREAD).filter((draft) => draft.invocationId === childId),
    [],
  );
  const snapshots = h.lifecycleSnapshots(responseId);
  assert.equal(snapshots.length, 1, `${catId} R published once to the user room`);
  assert.equal(snapshots[0].userId, userId);
  assert.equal(snapshots[0].payload.threadId, THREAD);
  assert.equal(snapshots[0].payload.message.lifecycle.status, 'canceled');
}

describe('PR-3a path 1: process-owned Stop settles R', () => {
  it('cancels the child turn and R, publishes R to the owner room, keeps the thread-room done, ends the parent', async (t) => {
    const h = await harness();
    t.after(h.close);
    const run = h.seedRun();
    h.owners.push(processOwner(run, 'opus'));

    const response = await h.stopLive(run.parentId, 'opus');

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().cancelled, true);
    assertCanceledAndPublished(h, run, 'opus');
    assert.ok(h.turnStore.get(run.turns.opus.childId).providerTeardownAt > 0, 'teardown proof kept');
    const done = h.threadRoom().filter((message) => message.type === 'done');
    assert.equal(done.length, 1);
    assert.equal(done[0].invocationId, run.parentId);
    assert.equal(done[0].turnInvocationId, run.turns.opus.childId);
    assert.equal(done[0].errorCode, 'cancelled');
    assert.equal(h.recordStore.get(run.parentId).status, 'canceled');
    assert.deepEqual(h.turnStore.listResponsePending(), []);
  });

  it('settles a scheduler-owned run under its owner and publishes R to that owner room', async (t) => {
    const h = await harness();
    t.after(h.close);
    const run = h.seedRun({ userId: 'scheduler' });
    h.owners.push(processOwner(run, 'opus', 'scheduler'));

    const response = await h.stopLive(run.parentId, 'opus');

    assert.equal(response.statusCode, 200, response.body);
    assertCanceledAndPublished(h, run, 'opus', { userId: 'scheduler' });
  });

  it('leaves R and the parent to the in-process QueueProcessor execution, whose own commit then applies', async (t) => {
    const h = await harness();
    t.after(h.close);
    const run = h.seedRun();
    h.owners.push(processOwner(run, 'opus'));
    // A tracker Stop already tombstoned the slot; this process's route still commits R.
    h.tombstones.set('opus', { executionId: run.parentId, userId: USER });
    h.claimResponse(run, 'opus');

    const response = await h.stopLive(run.parentId, 'opus');

    assert.equal(response.statusCode, 200, response.body);
    const { childId, responseId } = run.turns.opus;
    assert.equal(h.turnStore.get(childId).status, 'canceled', 'the stopped provider proof is still recorded');
    assert.equal(h.responseOf(responseId).lifecycle.status, 'processing', 'R belongs to the live producer');
    assert.equal(h.lifecycleSnapshots(responseId).length, 0);
    assert.equal(h.recordStore.get(run.parentId).status, 'running', 'the producer finally owns the parent');
    assert.equal(h.threadRoom().filter((message) => message.type === 'done').length, 1);

    const producerCommit = await h.messageStore.commitLifecycleResponseTerminal(responseId, {
      invocationId: childId,
      status: 'canceled',
      completedAt: Date.now(),
      reason: 'user_cancel',
      content: 'the producer final body',
      mentions: [],
    });
    assert.equal(producerCommit.kind, 'applied', 'the producer never meets a stop-written conflicting terminal');
  });

  it('keeps the parent running while a sibling cat of the run is still active', async (t) => {
    const h = await harness();
    t.after(h.close);
    const run = h.seedRun({ catIds: ['opus', 'codex'] });
    h.owners.push(processOwner(run, 'opus'));
    h.slots.set('codex', { executionId: run.parentId, userId: USER });

    const response = await h.stopLive(run.parentId, 'opus');

    assert.equal(response.statusCode, 200, response.body);
    assertCanceledAndPublished(h, run, 'opus');
    assert.equal(h.recordStore.get(run.parentId).status, 'running');
    assert.equal(h.turnStore.get(run.turns.codex.childId).status, 'running');
    assert.equal(h.responseOf(run.turns.codex.responseId).lifecycle.status, 'processing');
  });

  it('never releases locks or touches R of a replacement execution the same cat already started', async (t) => {
    const h = await harness();
    t.after(h.close);
    const old = h.seedRun();
    const replacement = h.seedRun();
    h.owners.push(processOwner(old, 'opus'));
    h.slots.set('opus', { executionId: replacement.parentId, userId: USER });
    h.reservations.set('opus', replacement.parentId);

    const response = await h.stopLive(old.parentId, 'opus');

    assert.equal(response.statusCode, 200, response.body);
    assertCanceledAndPublished(h, old, 'opus');
    assert.equal(h.turnStore.get(replacement.turns.opus.childId).status, 'running');
    assert.equal(h.responseOf(replacement.turns.opus.responseId).lifecycle.status, 'processing');
    assert.equal(h.lifecycleSnapshots(replacement.turns.opus.responseId).length, 0);
    assert.equal(h.recordStore.get(replacement.parentId).status, 'running');
    assert.deepEqual(h.lockReleases, [], 'the replacement holds the live session lock');
    assert.deepEqual(h.slotReleases, []);
  });

  it('a racing writer that ended R first keeps its terminal; Stop publishes it and still succeeds', async (t) => {
    const h = await harness();
    t.after(h.close);
    const run = h.seedRun();
    h.owners.push(processOwner(run, 'opus'));
    const { childId, responseId } = run.turns.opus;
    const commit = h.messageStore.commitLifecycleResponseTerminal.bind(h.messageStore);
    const results = [];
    let raced = false;
    h.messageStore.commitLifecycleResponseTerminal = async (id, patch) => {
      if (!raced) {
        raced = true;
        // The QueueProcessor route commits between Stop's read of R and its own commit.
        const first = await commit(id, {
          invocationId: childId,
          status: 'completed',
          completedAt: patch.completedAt,
          content: 'the route finished first',
          mentions: [],
        });
        assert.equal(first.kind, 'applied');
      }
      const result = await commit(id, patch);
      results.push(result);
      return result;
    };

    const response = await h.stopLive(run.parentId, 'opus');

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(
      results.map((result) => [result.kind, result.reason]),
      [['conflict', 'different_terminal']],
    );
    const stored = h.responseOf(responseId);
    assert.equal(stored.lifecycle.status, 'completed', 'never overwritten');
    assert.equal(stored.content, 'the route finished first');
    const snapshots = h.lifecycleSnapshots(responseId);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].payload.message.lifecycle.status, 'completed');
    assert.deepEqual(h.turnStore.listResponsePending(), []);
  });
});

describe('PR-3a path 2: reconciling an inactive run settles R', () => {
  it('cancels the child turn and R, publishes R, keeps the thread-room done, ends the parent', async (t) => {
    const h = await harness();
    t.after(h.close);
    const run = h.seedRun();

    const response = await h.stopLive(run.parentId, 'opus');

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { ok: true, cancelled: false, reconciled: true });
    assertCanceledAndPublished(h, run, 'opus');
    assert.equal(h.turnStore.get(run.turns.opus.childId).providerTeardownAt, undefined, 'no teardown claimed');
    const done = h.threadRoom().filter((message) => message.type === 'done');
    assert.equal(done.length, 1);
    assert.equal(done[0].invocationId, run.parentId);
    assert.equal(done[0].isFinal, true);
    assert.equal(h.recordStore.get(run.parentId).status, 'canceled');
  });

  it('keeps an R that already ended as it is and republishes it', async (t) => {
    const h = await harness();
    t.after(h.close);
    const run = h.seedRun();
    const { childId, responseId } = run.turns.opus;
    const ended = await h.messageStore.commitLifecycleResponseTerminal(responseId, {
      invocationId: childId,
      status: 'completed',
      completedAt: Date.now(),
      content: 'already delivered',
      mentions: [],
    });
    assert.equal(ended.kind, 'applied');

    const response = await h.stopLive(run.parentId, 'opus');

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(h.responseOf(responseId).lifecycle.status, 'completed');
    assert.equal(h.responseOf(responseId).content, 'already delivered');
    const snapshots = h.lifecycleSnapshots(responseId);
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].payload.message.lifecycle.status, 'completed');
  });

  it('keeps the parent running while a sibling cat of the run is still active', async (t) => {
    const h = await harness();
    t.after(h.close);
    const run = h.seedRun({ catIds: ['opus', 'codex'] });
    h.slots.set('codex', { executionId: run.parentId, userId: USER });

    const response = await h.stopLive(run.parentId, 'opus');

    assert.equal(response.statusCode, 200, response.body);
    assertCanceledAndPublished(h, run, 'opus');
    assert.equal(h.recordStore.get(run.parentId).status, 'running');
    assert.equal(h.responseOf(run.turns.codex.responseId).lifecycle.status, 'processing');
  });

  it('a run with no turn yet still retires its pre-start group and publishes no R', async (t) => {
    const h = await harness();
    t.after(h.close);
    const queued = h.invocationQueue.enqueueDurableNow(
      canonicalTestQueueInput({
        threadId: THREAD,
        userId: USER,
        kind: 'conversation_input',
        content: 'not started yet',
        source: 'user',
        sourceId: 'prestart-stop',
        targetCats: ['opus'],
        intent: 'execute',
      }),
    );
    assert.equal(queued.outcome, 'enqueued');
    assert.ok(
      await h.invocationQueue.markProcessingDurable(THREAD, USER, { entryId: queued.entry.id, targetCats: ['opus'] }),
    );

    const response = await h.stopLive('prestart-parent', 'opus');

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(h.prestartRetirements, ['opus']);
    assert.equal(h.emitted.filter((item) => item.event === 'message_lifecycle_updated').length, 0);
  });
});

describe('PR-3a path 3: per-cat cancel of an orphan record settles R', () => {
  it('cancels the child turn and R, publishes R, keeps the thread-room status, ends the record', async (t) => {
    const h = await harness();
    t.after(h.close);
    const run = h.seedRun();

    const response = await h.cancelCat('opus');

    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json(), { ok: true, cancelled: true });
    assertCanceledAndPublished(h, run, 'opus');
    assert.deepEqual(
      h.threadRoom().map((message) => [message.type, message.catId]),
      [['status', 'opus']],
    );
    assert.equal(h.recordStore.get(run.parentId).status, 'canceled');
  });

  it('settles every cat of an all-orphan multi-cat record it cancels', async (t) => {
    const h = await harness();
    t.after(h.close);
    const run = h.seedRun({ catIds: ['opus', 'codex'] });

    const response = await h.cancelCat('opus');

    assert.equal(response.statusCode, 200, response.body);
    assertCanceledAndPublished(h, run, 'opus');
    assertCanceledAndPublished(h, run, 'codex');
  });

  it('touches nothing while a sibling cat of the record is still active', async (t) => {
    const h = await harness();
    t.after(h.close);
    const run = h.seedRun({ catIds: ['opus', 'codex'] });
    h.slots.set('codex', { executionId: run.parentId, userId: USER });

    const response = await h.cancelCat('opus');

    assert.equal(response.statusCode, 404, response.body);
    assert.equal(h.recordStore.get(run.parentId).status, 'running');
    assert.equal(h.turnStore.get(run.turns.opus.childId).status, 'running');
    assert.equal(h.responseOf(run.turns.opus.responseId).lifecycle.status, 'processing');
  });
});

describe('PR-3a path 4: force-reset settles R of the runs it cancels', () => {
  it('cancels every orphan run turn and R, publishes R, keeps the thread-room status', async (t) => {
    const h = await harness();
    t.after(h.close);
    const run = h.seedRun({ catIds: ['opus', 'codex'] });

    const response = await h.forceReset();

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().canceledRecords, 1);
    assertCanceledAndPublished(h, run, 'opus', { reason: 'cancel_all' });
    assertCanceledAndPublished(h, run, 'codex', { reason: 'cancel_all' });
    assert.deepEqual(
      h
        .threadRoom()
        .map((message) => [message.type, message.catId])
        .sort(),
      [
        ['status', 'codex'],
        ['status', 'opus'],
      ],
    );
    assert.equal(h.recordStore.get(run.parentId).status, 'canceled');
  });

  it('leaves the turns and R of a run it just aborted to that run’s own execution', async (t) => {
    const h = await harness();
    t.after(h.close);
    const live = h.seedRun();
    const orphan = h.seedRun({ catIds: ['codex'] });
    h.slots.set('opus', { executionId: live.parentId, userId: USER });

    const response = await h.forceReset();

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(h.turnStore.get(live.turns.opus.childId).status, 'running');
    assert.equal(h.responseOf(live.turns.opus.responseId).lifecycle.status, 'processing');
    assert.equal(h.lifecycleSnapshots(live.turns.opus.responseId).length, 0);
    assertCanceledAndPublished(h, orphan, 'codex', { reason: 'cancel_all' });
  });
});

/** The producer's own eventual commit of R, as its route makes it. */
function producerCommit(h, run, catId) {
  return h.messageStore.commitLifecycleResponseTerminal(run.turns[catId].responseId, {
    invocationId: run.turns[catId].childId,
    status: 'completed',
    completedAt: Date.now(),
    content: 'full final answer',
    mentions: [],
  });
}

/**
 * How each path is reached. The process stop needs a live owner of the run's cat to resolve to it;
 * a process stop whose termination cannot be confirmed falls back to failUncontrollableInvocation.
 */
const STOP_PATHS = {
  'process stop': (h, run) => {
    h.owners.push(processOwner(run, 'opus'));
    return h.stopLive(run.parentId, 'opus');
  },
  'inactive reconcile': (h, run) => h.stopLive(run.parentId, 'opus'),
  'per-cat orphan cancel': (h) => h.cancelCat('opus'),
  'force-reset': (h) => h.forceReset(),
  failUncontrollableInvocation: (h, run) => {
    h.owners.push(processOwner(run, 'opus'));
    h.termination.stopped = false;
    return h.stopLive(run.parentId, 'opus');
  },
};

/** What a path ends a running turn and its R with. */
const CLOSURE_TERMINAL = {
  'process stop': { status: 'canceled', reason: 'user_cancel' },
  'inactive reconcile': { status: 'canceled', reason: 'user_cancel' },
  'per-cat orphan cancel': { status: 'canceled', reason: 'user_cancel' },
  'force-reset': { status: 'canceled', reason: 'cancel_all' },
  failUncontrollableInvocation: { status: 'failed', reason: 'control_plane_unavailable' },
};

/** Endings a producer may already have written to the turn before it commits R. */
const ENDINGS = {
  succeeded: { turn: { status: 'succeeded' }, response: { status: 'interrupted', reason: 'process_restart' } },
  failed: {
    turn: { status: 'failed', terminalReason: 'provider_failed' },
    response: { status: 'failed', reason: 'provider_failed' },
  },
  canceled: {
    turn: { status: 'canceled', terminalReason: 'user_cancel' },
    response: { status: 'canceled', reason: 'user_cancel' },
  },
  interrupted: {
    turn: { status: 'interrupted', terminalReason: 'generator_returned_without_completion' },
    response: { status: 'interrupted', reason: 'generator_returned_without_completion' },
  },
};

describe('PR-3a: a turn whose R a live route still claims is left to that route', () => {
  for (const path of Object.keys(STOP_PATHS)) {
    for (const [ending, { turn }] of [['running', { turn: {} }], ...Object.entries(ENDINGS)]) {
      it(`${path}: a ${ending} turn — no turn or R written; the route's own commit applies`, async (t) => {
        const h = await harness();
        t.after(h.close);
        const run = h.seedRun();
        const { childId, responseId } = run.turns.opus;
        if (turn.status) h.turnStore.transitionTerminal(childId, { ...turn, endedAt: Date.now() - 1_000 });
        h.claimResponse(run, 'opus');

        const response = await STOP_PATHS[path](h, run);

        const uncontrolled = ['inactive reconcile', 'per-cat orphan cancel', 'force-reset'].includes(path);
        assert.equal(response.statusCode, uncontrolled ? 503 : 200, response.body);
        if (uncontrolled) assert.deepEqual(h.lockReleases, [], 'an active producer retains its session locks');
        assert.equal(h.responseOf(responseId).lifecycle.status, 'processing', 'R stays with its route');
        assert.equal(h.lifecycleSnapshots(responseId).length, 0);
        const child = h.turnStore.get(childId);
        if (turn.status) assert.equal(child.status, turn.status, 'the producer’s ending is kept');
        else if (path === 'process stop') assert.ok(child.status === 'canceled' && child.providerTeardownAt > 0);
        else assert.equal(child.status, 'running', 'the route ends its own turn');
        if (path === 'failUncontrollableInvocation' || path === 'process stop') {
          assert.equal(h.recordStore.get(run.parentId).status, 'running', 'the route ends its own run');
        }
        assert.equal(producerCommit(h, run, 'opus').kind, 'applied', 'no second writer met the route');
      });
    }
  }
});

describe('PR-3a: with no route claiming R, a stop settles it from the turn’s authoritative ending', () => {
  for (const path of Object.keys(STOP_PATHS)) {
    for (const [ending, { turn, response: expected }] of Object.entries(ENDINGS)) {
      it(`${path}: a turn that had ${ending} gives R that ending`, async (t) => {
        const h = await harness();
        t.after(h.close);
        const run = h.seedRun();
        const { childId, responseId } = run.turns.opus;
        h.turnStore.transitionTerminal(childId, { ...turn, endedAt: Date.now() - 1_000 });

        const response = await STOP_PATHS[path](h, run);

        assert.equal(response.statusCode, 200, response.body);
        assert.equal(h.turnStore.get(childId).status, turn.status, 'the turn keeps its ending');
        const stored = h.responseOf(responseId);
        assert.equal(stored.lifecycle.status, expected.status);
        assert.equal(stored.lifecycle.reason, expected.reason);
        assert.equal(stored.content, 'opus streamed so far', 'no stop explanation on an ending it did not write');
        const snapshots = h.lifecycleSnapshots(responseId);
        assert.equal(snapshots.length, 1);
        assert.equal(snapshots[0].payload.message.lifecycle.status, expected.status);
      });
    }

    it(`${path}: a running turn takes the path's own terminal`, async (t) => {
      const h = await harness();
      t.after(h.close);
      const run = h.seedRun();
      const { childId, responseId } = run.turns.opus;

      const response = await STOP_PATHS[path](h, run);

      assert.equal(response.statusCode, 200, response.body);
      const { status, reason } = CLOSURE_TERMINAL[path];
      assert.equal(h.turnStore.get(childId).status, status);
      assert.equal(h.responseOf(responseId).lifecycle.status, status);
      assert.equal(h.responseOf(responseId).lifecycle.reason, reason);
      assert.equal(h.lifecycleSnapshots(responseId).length, 1);
    });
  }

  // Neither outlives or precedes the route reliably, so neither keeps a turn from being closed.
  const NOT_WITNESSES = [
    [
      'a canceled tracker tombstone left after its route finished',
      (h, run) => h.tombstones.set('opus', { executionId: run.parentId, userId: USER }),
    ],
    ['a Queue reservation of the run held without a route claim', (h, run) => h.reservations.set('opus', run.parentId)],
  ];
  for (const [name, seed] of NOT_WITNESSES) {
    for (const path of ['process stop', 'inactive reconcile', 'per-cat orphan cancel', 'force-reset']) {
      it(`${path}: ${name} does not block settlement`, async (t) => {
        const h = await harness();
        t.after(h.close);
        const run = h.seedRun();
        seed(h, run);

        const response = await STOP_PATHS[path](h, run);

        assert.equal(response.statusCode, 200, response.body);
        assertCanceledAndPublished(h, run, 'opus', { reason: CLOSURE_TERMINAL[path].reason });
      });
    }
  }
});

describe('PR-3a: a path that never stops a process defers to a live exact CLI owner', () => {
  const WITNESSES = {
    'a live exact CLI owner, no route claim': (h, run) => h.owners.push(processOwner(run, 'opus')),
    'an owner snapshot that cannot rule an owner out': (h) => {
      h.ownerSnapshot.complete = false;
    },
  };
  for (const [name, seed] of Object.entries(WITNESSES)) {
    for (const path of ['per-cat orphan cancel', 'force-reset']) {
      it(`${path}: ${name}`, async (t) => {
        const h = await harness();
        t.after(h.close);
        const run = h.seedRun();
        seed(h, run);

        const response = await STOP_PATHS[path](h, run);

        assert.equal(response.statusCode, 200, response.body);
        assert.equal(h.responseOf(run.turns.opus.responseId).lifecycle.status, 'processing');
        assert.equal(h.turnStore.get(run.turns.opus.childId).status, 'running');
        assert.equal(producerCommit(h, run, 'opus').kind, 'applied');
      });
    }
  }

  it('per-cat orphan cancel leaves R to a live exact CLI owner (Astra #6697 R1 probe)', async (t) => {
    const h = await harness();
    t.after(h.close);
    const run = h.seedRun();
    h.owners.push(processOwner(run, 'opus'));

    const response = await h.cancelCat('opus');

    assert.equal(response.statusCode, 200, response.body);
    const stateBefore = h.responseOf(run.turns.opus.responseId).lifecycle.status;
    const late = producerCommit(h, run, 'opus');
    assert.deepEqual({ stateBefore, lateKind: late.kind }, { stateBefore: 'processing', lateKind: 'applied' });
  });
});

describe('PR-3a: a child the turn store does not know', () => {
  it('failUncontrollableInvocation settles its exact R as failed and fails the run (Astra #6697 R2 probe)', async (t) => {
    const h = await harness();
    t.after(h.close);
    const run = h.seedRun({ withoutTurn: true });

    const response = await STOP_PATHS.failUncontrollableInvocation(h, run);

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(h.recordStore.get(run.parentId).status, 'failed');
    const stored = h.responseOf(run.turns.opus.responseId);
    assert.equal(stored.lifecycle.status, 'failed', 'a repaired parent cannot strand its exact known response');
    assert.equal(stored.lifecycle.reason, 'control_plane_unavailable');
    assert.equal(stored.content, '执行控制面不可用', 'no turn record vouches for the draft, so it stays unpublished');
    assert.equal(h.turnStore.get(run.turns.opus.childId), null, 'no child record is forged');
  });

  it('a proven process stop settles its exact R as canceled and ends the run', async (t) => {
    const h = await harness();
    t.after(h.close);
    const run = h.seedRun({ withoutTurn: true });

    const response = await STOP_PATHS['process stop'](h, run);

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().cancelled, true);
    const stored = h.responseOf(run.turns.opus.responseId);
    assert.equal(stored.lifecycle.status, 'canceled');
    assert.equal(stored.lifecycle.reason, 'user_cancel');
    assert.equal(stored.content, '', 'no turn record vouches for the draft, so it stays unpublished');
    assert.equal(h.lifecycleSnapshots(run.turns.opus.responseId).length, 1);
    assert.equal(h.recordStore.get(run.parentId).status, 'canceled');
  });

  it('with no exact R there is nothing left processing, and the run ends', async (t) => {
    const h = await harness();
    t.after(h.close);
    const run = h.seedRun({ withoutTurn: true, withoutResponse: true });

    const response = await STOP_PATHS['process stop'](h, run);

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(h.emitted.filter((item) => item.event === 'message_lifecycle_updated').length, 0);
    assert.equal(h.recordStore.get(run.parentId).status, 'canceled');
  });

  it('a claimed unknown child is left to its route', async (t) => {
    const h = await harness();
    t.after(h.close);
    const run = h.seedRun({ withoutTurn: true });
    h.claimResponse(run, 'opus');

    const response = await STOP_PATHS.failUncontrollableInvocation(h, run);

    assert.equal(response.statusCode, 200, response.body);
    assert.equal(h.responseOf(run.turns.opus.responseId).lifecycle.status, 'processing');
    assert.equal(h.recordStore.get(run.parentId).status, 'running');
  });
});
