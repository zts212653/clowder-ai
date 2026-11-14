/**
 * Issue #1894 boundaries: an ordinary A2A `message_wake` becomes manually operable
 * through the existing Queue controls while the same row keeps its producer
 * identity, and every carrier that was not part of this fix keeps its refusal.
 *
 * These are HTTP/domain boundary tests. The real QueueProcessor journey lives in
 * issue1894-a2a-steer-journey.test.js and must not be duplicated here.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import Fastify from 'fastify';
import { canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

const { InvocationQueue, queueEntryTargetCats } = await import(
  '../dist/domains/cats/services/agents/invocation/InvocationQueue.js'
);

function buildDeps() {
  const invocationQueue = new InvocationQueue();
  const thread = {
    id: 't1',
    title: 'Issue 1894',
    createdBy: 'system',
    participants: ['opus', 'codex'],
  };
  const messages = new Map();
  const managedCommandWakeRecovery = {
    retireCarrier: mock.fn(async () => 0),
    retireThread: mock.fn(async () => ({ retired: 0, messageIds: [] })),
  };
  const queueProcessor = {
    canReleaseSlotForUser: mock.fn(() => true),
    hasProcessingSlotReservation: mock.fn(() => false),
    processNext: mock.fn(async () => ({ started: false })),
    releaseSlot: mock.fn(() => {}),
    releaseThread: mock.fn(() => {}),
    requestDrain: mock.fn(async () => {}),
    finalizeRemovedEntry: mock.fn(async () => true),
    registerCallerDispatchSteerChanges: mock.fn(() => {}),
    registerCallerDispatchQueueWithdrawal: mock.fn(() => {}),
    appendExactEntry: mock.fn(async () => ({ outcome: 'appended', entry: {}, acceptedTargetIds: ['opus'] })),
    tryAutoAppendExactEntry: mock.fn(async () => ({ outcome: 'appended', entry: {}, acceptedTargetIds: ['opus'] })),
    processClaimedSteerEntries: mock.fn(async (threadId, userId, entryIds) => ({
      started: true,
      entry: invocationQueue.getEntrySnapshot(threadId, userId, entryIds[0]),
    })),
    retirePrestartProcessingGroup: mock.fn(async () => 'state_changed'),
  };
  return {
    threadStore: {
      get: mock.fn(async (id) => ({ ...thread, id, participants: [...thread.participants] })),
      addParticipants: mock.fn(async () => {}),
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
      activeInvocationGuidance: 'supported',
      deliverySemantics: 'exact_active_turn',
    })),
    isCatAvailable: mock.fn(() => true),
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    messageStore: {
      getById: mock.fn(async (id) => messages.get(id) ?? null),
      markCanceled: mock.fn(async () => ({ deliveryStatus: 'canceled', deliveryTransitioned: true })),
    },
    agentSessionMutex: {
      forceReleaseByScope: mock.fn(() => ({ releasedHolders: 0, rejectedWaiters: 0, catIds: [] })),
    },
    managedCommandWakeRecovery,
    getManagedCommandWakeRecovery: () => managedCommandWakeRecovery,
    messages,
  };
}

let sourceSequence = 0;

/** One canonical History message; the Queue row references it by exact id. */
function putSource(deps, overrides = {}) {
  sourceSequence += 1;
  const id = overrides.id ?? `issue1894-source-${sourceSequence}`;
  const source = {
    id,
    threadId: 't1',
    userId: 'user-a',
    content: `peer follow-up ${sourceSequence}`,
    from: { kind: 'agent', catId: 'codex' },
    deliveryStatus: 'queued',
    timestamp: 1,
    lifecycle: { kind: 'input', dispatchRefs: [] },
    ...overrides,
  };
  deps.messages.set(id, source);
  return source;
}

/** Ordinary A2A wake: agent-authored History message plus one message_wake row. */
async function enqueueA2AWake(deps, overrides = {}) {
  const source = putSource(deps, overrides.source);
  const input = {
    threadId: 't1',
    userId: 'user-a',
    kind: 'message_wake',
    from: { kind: 'agent', catId: 'codex' },
    content: source.content,
    sourceId: source.id,
    messageId: source.id,
    sourceCategory: 'a2a',
    ownerAuthProvenance: 'strict',
    targetCats: ['opus'],
    intent: 'execute',
    autoExecute: true,
    a2aParentInvocationId: 'caller-invocation',
    a2aTriggerMessageId: source.id,
    ...overrides.input,
  };
  const result = await deps.invocationQueue.enqueueDurable(canonicalTestQueueInput(input));
  assert.equal(result.outcome, 'enqueued', JSON.stringify(result));
  return { entry: result.entry, source };
}

async function enqueueEntry(deps, input) {
  const result = await deps.invocationQueue.enqueueDurable(
    canonicalTestQueueInput({ threadId: 't1', userId: 'user-a', intent: 'execute', autoExecute: true, ...input }),
  );
  assert.equal(result.outcome, 'enqueued', JSON.stringify(result));
  return result.entry;
}

function targetsUrl(entryId) {
  return `/api/threads/t1/queue/${encodeURIComponent(entryId)}/targets`;
}

function continueUrl(entryId) {
  return `/api/threads/t1/queue/${encodeURIComponent(entryId)}/continue`;
}

function steerPost(app, entry, body = {}) {
  return app.inject({
    method: 'POST',
    url: targetsUrl(entry.id),
    headers: { 'x-cat-cafe-user': 'user-a' },
    payload: body,
  });
}

describe('Issue #1894 A2A queue steer boundaries', () => {
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

  it('opens the action dialog for an ordinary A2A wake with the exact source identity', async () => {
    const { entry, source } = await enqueueA2AWake(deps);

    const res = await app.inject({
      url: targetsUrl(entry.id),
      headers: { 'x-cat-cafe-user': 'user-a' },
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().sourceRecordId, source.id);
    assert.deepEqual(res.json().targets, [{ targetCatId: 'opus', state: 'pending', actionable: true }]);
  });

  it('keeps kind, owner and A2A provenance when the existing row gains and loses targets', async () => {
    const { entry, source } = await enqueueA2AWake(deps);

    const added = await steerPost(app, entry, {
      sourceRecordId: source.id,
      observedPendingTargetIds: ['opus'],
      targets: [
        { targetCatId: 'opus', strategy: 'guide_reply', membershipAtOpen: 'member' },
        { targetCatId: 'codex', strategy: 'guide_reply', membershipAtOpen: 'member' },
      ],
    });
    assert.equal(added.statusCode, 200, added.body);
    assert.equal(added.json().targets.length, 2);

    const widened = deps.invocationQueue.getEntrySnapshot('t1', 'user-a', entry.id);
    assert.ok(widened);
    assert.equal(widened.kind, 'message_wake');
    assert.equal(widened.sourceCategory, 'a2a');
    assert.deepEqual(widened.from, { kind: 'agent', catId: 'codex' });
    assert.equal(widened.owner.kind, 'user');
    assert.equal(widened.owner.userId, 'user-a');
    assert.equal(widened.payload.messageId, source.id);
    assert.equal(widened.payload.sourceRecordId, source.id);
    assert.equal(widened.execution.a2aTriggerMessageId, source.id);
    assert.equal(widened.execution.a2aParentInvocationId, 'caller-invocation');
    assert.deepEqual([...queueEntryTargetCats(widened)].sort(), ['codex', 'opus']);
    assert.deepEqual(deps.messages.get(source.id).lifecycle.dispatchRefs, []);

    const removed = await steerPost(app, entry, {
      sourceRecordId: source.id,
      observedPendingTargetIds: ['opus', 'codex'],
      targets: [{ targetCatId: 'codex', strategy: 'guide_reply', membershipAtOpen: 'member' }],
    });
    assert.equal(removed.statusCode, 200, removed.body);

    const narrowed = deps.invocationQueue.getEntrySnapshot('t1', 'user-a', entry.id);
    assert.ok(narrowed);
    assert.equal(narrowed.kind, 'message_wake');
    assert.equal(narrowed.sourceCategory, 'a2a');
    assert.deepEqual(queueEntryTargetCats(narrowed), ['codex']);
    assert.equal(narrowed.execution.a2aTriggerMessageId, source.id);
    assert.deepEqual(deps.messages.get(source.id).lifecycle.dispatchRefs, []);
  });

  it('never turns an unsupported guide into an interrupt', async () => {
    deps.resolveCarrierCapability.mock.mockImplementation(() => ({
      provider: 'other',
      carrier: 'other',
      activeInvocationGuidance: 'unsupported',
      deliverySemantics: 'unsupported',
    }));
    const { entry, source } = await enqueueA2AWake(deps);

    const res = await steerPost(app, entry, {
      sourceRecordId: source.id,
      observedPendingTargetIds: ['opus'],
      targets: [{ targetCatId: 'opus', strategy: 'guide_reply', membershipAtOpen: 'member' }],
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().targets[0].result.outcome, 'queued');
    assert.equal(res.json().targets[0].result.effective, 'next_work');
    assert.equal(res.json().targets[0].result.reason, 'unsupported_carrier');
    assert.equal(deps.queueProcessor.tryAutoAppendExactEntry.mock.calls.length, 0);
    assert.equal(deps.invocationTracker.cancel.mock.calls.length, 0);

    const kept = deps.invocationQueue.getEntrySnapshot('t1', 'user-a', entry.id);
    assert.ok(kept);
    assert.equal(kept.status, 'queued');
    assert.equal(kept.kind, 'message_wake');
    const intent = kept.delivery.authorIntentByTarget?.opus;
    assert.equal(intent?.requested, 'continue_current');
    assert.equal(intent?.fallbackReason, 'unsupported_carrier');
    assert.equal(typeof intent?.fallbackAt, 'number');
  });

  it('reuses the existing interrupt claim and cancel path for an A2A wake', async () => {
    const { entry, source } = await enqueueA2AWake(deps);
    deps.invocationTracker.has.mock.mockImplementation(() => true);
    deps.invocationTracker.getUserId.mock.mockImplementation(() => 'user-a');
    deps.invocationTracker.cancel.mock.mockImplementation(() => ({
      cancelled: true,
      catIds: ['opus'],
      executionIds: ['inv-active'],
    }));

    const res = await steerPost(app, entry, {
      sourceRecordId: source.id,
      observedPendingTargetIds: ['opus'],
      targets: [{ targetCatId: 'opus', strategy: 'interrupt_reply', membershipAtOpen: 'member' }],
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().targets[0].status, 200);
    assert.equal(deps.invocationTracker.cancel.mock.calls.length, 1);
    assert.deepEqual(deps.invocationTracker.cancel.mock.calls[0].arguments.slice(0, 3), ['t1', 'opus', 'user-a']);
    assert.equal(deps.queueProcessor.processClaimedSteerEntries.mock.calls.length, 1);
    assert.deepEqual(deps.queueProcessor.processClaimedSteerEntries.mock.calls[0].arguments, [
      't1',
      'user-a',
      [entry.id],
      'opus',
    ]);
  });

  it('binds an ordinary A2A wake through the real /continue intent binder', async () => {
    const { entry, source } = await enqueueA2AWake(deps);
    deps.invocationTracker.has.mock.mockImplementation(() => true);
    deps.invocationTracker.getUserId.mock.mockImplementation(() => 'user-a');
    deps.invocationTracker.getExecutionId.mock.mockImplementation(() => 'turn-1');

    const res = await app.inject({
      method: 'POST',
      url: continueUrl(entry.id),
      headers: { 'x-cat-cafe-user': 'user-a' },
      payload: { targetCatId: 'opus' },
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.json().outcome, 'appended');
    assert.equal(deps.invocationTracker.cancel.mock.calls.length, 0);
    assert.equal(deps.queueProcessor.tryAutoAppendExactEntry.mock.calls.length, 1);
    assert.deepEqual(deps.queueProcessor.tryAutoAppendExactEntry.mock.calls[0].arguments[0], {
      threadId: 't1',
      userId: 'user-a',
      entryId: entry.id,
      targetCatId: 'opus',
    });

    const bound = deps.invocationQueue.getEntrySnapshot('t1', 'user-a', entry.id);
    assert.ok(bound, 'the binder must persist the intent on the same durable row');
    assert.equal(bound.kind, 'message_wake');
    assert.equal(bound.sourceCategory, 'a2a');
    assert.equal(bound.owner.kind, 'user');
    assert.equal(bound.owner.userId, 'user-a');
    assert.deepEqual(bound.from, { kind: 'agent', catId: 'codex' });
    assert.equal(bound.payload.messageId, source.id);
    assert.equal(bound.payload.sourceRecordId, source.id);
    assert.equal(bound.execution.a2aTriggerMessageId, source.id);
    assert.equal(bound.execution.a2aParentInvocationId, 'caller-invocation');
    assert.deepEqual(queueEntryTargetCats(bound), ['opus']);
    const intent = bound.delivery.authorIntentByTarget?.opus;
    assert.equal(intent?.requested, 'continue_current');
    assert.equal(intent?.boundParentInvocationId, 'turn-1');
    assert.equal(intent?.fallbackAt, undefined);
    assert.deepEqual(deps.messages.get(source.id).lifecycle.dispatchRefs, []);
  });

  it('refuses to rebuild a vanished A2A row as a plain conversation input', async () => {
    const { entry, source } = await enqueueA2AWake(deps);
    assert.ok(await deps.invocationQueue.terminalizeEntryDurable('t1', 'user-a', entry.id));
    assert.deepEqual(deps.invocationQueue.list('t1', 'user-a'), []);

    const res = await steerPost(app, entry, {
      sourceRecordId: source.id,
      observedPendingTargetIds: ['opus'],
      targets: [
        { targetCatId: 'opus', strategy: 'guide_reply', membershipAtOpen: 'member' },
        { targetCatId: 'codex', strategy: 'guide_reply', membershipAtOpen: 'member' },
      ],
    });

    assert.equal(res.statusCode, 409, res.body);
    assert.equal(res.json().code, 'STEER_ENTRY_UNAVAILABLE');
    const durable = await deps.invocationQueue.listAllDurable('t1');
    assert.equal(
      durable.filter((row) => row.payload.sourceRecordId === source.id || row.payload.messageId === source.id).length,
      0,
      'a delivered A2A row must not be downgraded into a new queue admission',
    );
  });

  it('keeps the idempotent skip when a vanished A2A row only referenced delivered targets', async () => {
    const { entry, source } = await enqueueA2AWake(deps);
    source.lifecycle = {
      kind: 'input',
      dispatchRefs: [{ targetId: 'opus', phase: 'dispatched', dispatchedAt: 2, statusMessageId: 'response-opus' }],
    };
    assert.ok(await deps.invocationQueue.terminalizeEntryDurable('t1', 'user-a', entry.id));

    const res = await steerPost(app, entry, {
      sourceRecordId: source.id,
      observedPendingTargetIds: [],
      targets: [{ targetCatId: 'opus', strategy: 'guide_reply', membershipAtOpen: 'member' }],
    });

    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(res.json().targets, []);
    assert.deepEqual(res.json().skippedAlreadyDispatched, ['opus']);
    assert.equal(deps.invocationTracker.cancel.mock.calls.length, 0);
  });

  it('still refuses every carrier outside the ordinary A2A wake contract', async (t) => {
    const cases = [
      {
        name: 'A2A failure carrier',
        input: { sourceCategory: 'a2a_failure', from: { kind: 'agent', catId: 'codex' } },
        withSource: true,
        continueStatus: 409,
      },
      {
        name: 'scheduled wake',
        input: { sourceCategory: 'scheduled', from: { kind: 'system', service: 'scheduler' } },
        withSource: true,
        continueStatus: 409,
      },
      {
        name: 'system-pinned continuation',
        input: { sourceCategory: 'continuation', from: { kind: 'agent', catId: 'codex' } },
        withSource: true,
        continueStatus: 409,
      },
      {
        name: 'exact cloud dispatch requirement',
        input: { requiresExactCloudDispatchProvenance: true },
        withSource: true,
        continueStatus: 409,
      },
      {
        name: 'domain execution scope',
        input: {
          from: { kind: 'system', service: 'collective-work' },
          ownerAuthProvenance: 'unknown',
          executionScope: 'collective-work',
        },
        withSource: true,
        continueStatus: 409,
      },
      {
        name: 'action successor fence',
        input: {
          actionSuccessorFence: { leaseId: 'lease-1', generation: 1, dispatchId: 'dispatch-1' },
        },
        withSource: true,
        continueStatus: 409,
      },
      {
        name: 'private input',
        withSource: false,
        continueStatus: 404,
      },
    ];

    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        let entry;
        if (scenario.withSource) {
          const wake = await enqueueA2AWake(deps, { input: scenario.input });
          entry = wake.entry;
        } else {
          entry = await enqueueEntry(deps, {
            kind: 'private_input',
            from: { kind: 'user', userId: 'user-a' },
            ownerAuthProvenance: 'strict',
            targetCats: ['opus'],
            content: 'private custody',
            sourceId: 'issue1894-private-input',
          });
        }

        const opened = await app.inject({
          url: targetsUrl(entry.id),
          headers: { 'x-cat-cafe-user': 'user-a' },
        });
        assert.equal(opened.statusCode, 409, `${scenario.name}: ${opened.body}`);

        const continued = await app.inject({
          method: 'POST',
          url: continueUrl(entry.id),
          headers: { 'x-cat-cafe-user': 'user-a' },
          payload: { targetCatId: queueEntryTargetCats(entry)[0] ?? 'opus' },
        });
        assert.equal(continued.statusCode, scenario.continueStatus, `${scenario.name}: ${continued.body}`);
        assert.equal(deps.invocationTracker.cancel.mock.calls.length, 0);
      });
    }
  });
});
