import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const {
  QueuedMessageCustodyCoordinator,
  createInitialCrossThreadQueuedMessageCustody,
  createInitialFanoutQueuedMessageCustody,
  createInitialQueuedMessageCustody,
} = await import('../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
const { projectQueueReceipt } = await import('../dist/domains/cats/services/stores/ports/queued-message-receipt.js');
const queuedTelemetry = await import('../dist/domains/cats/services/freshness/freshness-queue-telemetry.js');
const { InMemoryFreshnessClosureStore } = await import(
  '../dist/domains/cats/services/freshness/FreshnessClosureStore.js'
);
const { emitQueueUpdated } = await import('../dist/utils/queue-enrichment.js');
const { buildDispatchHandledContinuationCapsule, completeCapsuleForSeal, buildCapsuleFromRouteState } = await import(
  '../dist/domains/cats/services/agents/invocation/CollaborationContinuityCapsule.js'
);

/** Build a stub deps object for QueueProcessor */
function stubDeps(overrides = {}) {
  return {
    queue: new InvocationQueue(),
    invocationTracker: {
      start: mock.fn(() => new AbortController()),
      startAll: mock.fn(() => new AbortController()),
      complete: mock.fn(),
      completeAll: mock.fn(),
      has: mock.fn(() => false),
    },
    invocationRecordStore: {
      create: mock.fn(async () => ({
        outcome: 'created',
        invocationId: 'inv-stub',
      })),
      update: mock.fn(async () => {}),
    },
    socketManager: {
      broadcastAgentMessage: mock.fn(),
      broadcastToRoom: mock.fn(),
      emitToUser: mock.fn(),
    },
    messageStore: {
      append: mock.fn(async () => ({ id: 'msg-stub' })),
      getByIdempotencyKey: mock.fn(async () => null),
      getById: mock.fn(async () => null),
      // Whole-message selection resolves the canonical bubble group from the thread timeline.
      getByThreadAfter: mock.fn(async () => []),
      markDelivered: mock.fn(async (id) => ({
        id,
        threadId: 't1',
        content: `delivered:${id}`,
        catId: null,
        timestamp: Date.now(),
        mentions: [],
        userId: 'u1',
        deliveryStatus: 'delivered',
        deliveredAt: Date.now(),
        deliveryTransitioned: true,
      })),
    },
    log: {
      info: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
    },
    ...overrides,
    router: {
      resolveExplicitTargets: mock.fn(async (requestedCatIds) => [...requestedCatIds]),
      resolveConversationTargetsAtAdmission: mock.fn(async (requestedCatIds) =>
        requestedCatIds.length > 0 ? [...requestedCatIds] : ['opus'],
      ),
      routeExecution: mock.fn(async function* () {
        yield { type: 'done', catId: 'opus', timestamp: Date.now() };
      }),
      ackCollectedCursors: mock.fn(async () => {}),
      ...overrides.router,
    },
  };
}

/** Helper: enqueue an entry and return it */
function enqueueEntry(queue, overrides = {}) {
  const result = queue.enqueue(
    canonicalTestQueueInput({
      threadId: 't1',
      userId: 'u1',
      kind: 'conversation_input',
      content: 'hello',
      source: 'user',
      ownerAuthProvenance: 'unknown',
      targetCats: ['opus'],
      intent: 'execute',
      ...overrides,
    }),
  );
  return result.entry;
}

function enqueueCustodiedEntry(queue, messageStore, overrides = {}) {
  const { messageSource, messageUserId, ...entryOverrides } = overrides;
  const entry = enqueueEntry(queue, entryOverrides);
  const message = messageStore.append(
    canonicalTestMessageInput({
      userId: messageUserId ?? entry.userId,
      catId: null,
      content: entry.content,
      mentions: entry.targetCats,
      timestamp: entry.createdAt,
      threadId: entry.threadId,
      deliveryStatus: 'queued',
      queueCustody: createInitialQueuedMessageCustody(entry),
      ...(messageSource ? { source: messageSource } : {}),
    }),
  );
  queue.backfillMessageId(entry.threadId, entry.userId, entry.id, message.id);
  return { entry, message };
}

async function waitFor(predicate, timeoutMs = 5000, intervalMs = 10) {
  const start = Date.now();
  // biome-ignore lint: polling helper
  while (true) {
    if (predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

describe('QueueProcessor', () => {
  let deps;
  let processor;

  beforeEach(() => {
    queuedTelemetry.resetFreshnessQueueTelemetryForTest();
    deps = stubDeps();
    processor = new QueueProcessor(deps);
  });

  it('durably appends one selected Queue row through the exact Active Run append capability', async () => {
    const queue = new InvocationQueue();
    const messageStore = new MessageStore();
    const invocationTracker = new InvocationTracker();
    const { entry, message } = enqueueCustodiedEntry(queue, messageStore, {
      ownerAuthProvenance: 'strict',
      content: 'continue in this turn',
      targetCats: ['codex'],
    });
    const response = messageStore.append(
      canonicalTestMessageInput({
        userId: 'u1',
        threadId: 't1',
        catId: 'codex',
        content: '',
        mentions: [],
        timestamp: entry.createdAt + 1,
        lifecycle: {
          kind: 'response',
          orderKey: `${entry.createdAt + 1}:turn-1`,
          from: { kind: 'agent', catId: 'codex' },
          invocationId: 'turn-1',
          targetId: 'codex',
          inputEntryIds: ['entry-old'],
          inputMessageIds: ['message-old'],
          status: 'processing',
          startedAt: entry.createdAt + 1,
        },
      }),
    );
    invocationTracker.start('t1', 'codex', 'u1', ['codex'], 'parent-1');
    invocationTracker.bindLifecycleActiveRun(
      {
        threadId: 't1',
        targetId: 'codex',
        invocationId: 'turn-1',
        responseMessageId: response.id,
        inputEntryIds: ['entry-old'],
        inputMessageIds: ['message-old'],
        privateInputEntryIds: [],
        startedAt: entry.createdAt + 1,
      },
      'parent-1',
    );
    const dispatch = mock.fn(async () => ({
      accepted: true,
      handle: { provider: 'openai_codex', carrier: 'codex_app_server', threadId: 'native-1', turnId: 'turn-1' },
    }));
    invocationTracker.bindAgentClientActiveRunDispatcher(
      't1',
      'codex',
      {
        invocationId: 'turn-1',
        capabilities: { append: true, steer: true },
        handle: { provider: 'openai_codex', carrier: 'codex_app_server', threadId: 'native-1', turnId: 'turn-1' },
        dispatch,
      },
      'parent-1',
    );
    const appendDeps = stubDeps({ queue, invocationTracker, messageStore });
    appendDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore });
    const appendProcessor = new QueueProcessor(appendDeps);
    const expectedQueueRevision = queue.snapshotRevision('t1', 'u1');

    const result = await appendProcessor.appendExactEntry({
      threadId: 't1',
      userId: 'u1',
      entryId: entry.id,
      expectedQueueRevision,
      expectedRuns: [{ targetId: 'codex', invocationId: 'turn-1', responseMessageId: response.id }],
    });

    assert.equal(result.outcome, 'appended');
    assert.equal(queue.list('t1', 'u1').length, 0, 'Append transfers custody out of Queue without a new run');
    assert.deepEqual((await messageStore.getById(message.id)).lifecycle.dispatchRefs, [
      { targetId: 'codex', phase: 'dispatched', statusMessageId: response.id },
    ]);
    assert.deepEqual((await messageStore.getById(response.id)).lifecycle.inputEntryIds, ['entry-old', entry.id]);
    assert.deepEqual(dispatch.mock.calls[0].arguments, [
      { text: 'continue in this turn', messageIds: [message.id] },
      { force: false, expectedInvocationId: 'turn-1' },
    ]);
    const acceptedReceipt = projectQueueReceipt((await messageStore.getById(message.id)).queueCustody);
    const acceptedAt = acceptedReceipt.targets[0].attempts?.[0]?.activeAppendAcceptedAt;
    assert.equal(
      typeof acceptedAt,
      'number',
      'only a provider-accepted active append may publish the durable append affordance',
    );
    assert.equal(
      await appendDeps.queueCustodyCoordinator.markActiveAppendAccepted(
        entry,
        [{ targetId: 'codex', invocationId: 'turn-1' }],
        acceptedAt + 100,
      ),
      false,
      'replaying the same provider acknowledgement must be idempotent',
    );
    assert.equal(
      projectQueueReceipt((await messageStore.getById(message.id)).queueCustody).targets[0].attempts?.[0]
        ?.activeAppendAcceptedAt,
      acceptedAt,
    );

    const rejectedCarrier = enqueueCustodiedEntry(queue, messageStore, {
      ownerAuthProvenance: 'strict',
      content: 'too late for this turn',
      targetCats: ['codex'],
    });
    dispatch.mock.mockImplementation(async () => ({ accepted: false, reason: 'active_run_closed' }));
    const rejected = await appendProcessor.appendExactEntry({
      threadId: 't1',
      userId: 'u1',
      entryId: rejectedCarrier.entry.id,
      expectedQueueRevision: queue.snapshotRevision('t1', 'u1'),
      expectedRuns: [{ targetId: 'codex', invocationId: 'turn-1', responseMessageId: response.id }],
    });

    assert.deepEqual(rejected, {
      outcome: 'rejected',
      reason: 'provider_rejected',
      rejectedTargetIds: ['codex'],
    });
    const rejectedInput = await messageStore.getById(rejectedCarrier.message.id);
    const rejectedRef = rejectedInput.lifecycle.dispatchRefs.find((ref) => ref.targetId === 'codex');
    assert.equal(rejectedRef.phase, 'settled');
    assert.notEqual(rejectedRef.statusMessageId, response.id);
    assert.equal((await messageStore.getById(rejectedRef.statusMessageId)).lifecycle.kind, 'delivery_failure');
    assert.equal(
      (await messageStore.getById(response.id)).lifecycle.inputEntryIds.includes(rejectedCarrier.entry.id),
      false,
      'provider rejection must detach the unread input from the response bubble',
    );
    assert.equal(queue.list('t1', 'u1').length, 0);

    const persistenceFailureCarrier = enqueueCustodiedEntry(queue, messageStore, {
      ownerAuthProvenance: 'strict',
      content: 'keep custody queued after an admission write failure',
      targetCats: ['codex'],
    });
    const commitLifecycleAppendAdmission = messageStore.commitLifecycleAppendAdmission.bind(messageStore);
    messageStore.commitLifecycleAppendAdmission = mock.fn(async () => {
      throw new Error('injected lifecycle admission failure');
    });
    const persistenceFailure = await appendProcessor.appendExactEntry({
      threadId: 't1',
      userId: 'u1',
      entryId: persistenceFailureCarrier.entry.id,
      expectedQueueRevision: queue.snapshotRevision('t1', 'u1'),
      expectedRuns: [{ targetId: 'codex', invocationId: 'turn-1', responseMessageId: response.id }],
    });

    assert.deepEqual(persistenceFailure, { outcome: 'rejected', reason: 'lifecycle_conflict' });
    assert.equal(queue.list('t1', 'u1')[0]?.status, 'queued');
    assert.equal(
      (await messageStore.getById(persistenceFailureCarrier.message.id)).queueCustody.status,
      'queued',
      'catch rollback must restore durable Queue custody, not only the process-local row',
    );
    assert.deepEqual(
      (await messageStore.getById(persistenceFailureCarrier.message.id)).queueCustody.bodyExposures,
      undefined,
      'a pre-admission failure must not persist an append-only body-exposure witness',
    );
    assert.equal(
      invocationTracker
        .getActiveSlots('t1')
        .find((slot) => slot.catId === 'codex')
        ?.activeRun?.inputEntryIds.includes(persistenceFailureCarrier.entry.id),
      false,
      'a pre-admission failure must detach the non-durable Active Run mirror',
    );

    messageStore.commitLifecycleAppendAdmission = commitLifecycleAppendAdmission;
    const postAdmissionFailureCarrier = enqueueCustodiedEntry(queue, messageStore, {
      ownerAuthProvenance: 'strict',
      content: 'fail terminally after lifecycle admission',
      targetCats: ['codex'],
    });
    const persistEntry = appendDeps.queueCustodyCoordinator.persistEntry.bind(appendDeps.queueCustodyCoordinator);
    let persistCalls = 0;
    appendDeps.queueCustodyCoordinator.persistEntry = mock.fn(async (candidate) => {
      persistCalls += 1;
      if (persistCalls === 2) throw new Error('injected exposure persistence failure');
      return persistEntry(candidate);
    });
    const postAdmissionFailure = await appendProcessor.appendExactEntry({
      threadId: 't1',
      userId: 'u1',
      entryId: postAdmissionFailureCarrier.entry.id,
      expectedQueueRevision: queue.snapshotRevision('t1', 'u1'),
      expectedRuns: [{ targetId: 'codex', invocationId: 'turn-1', responseMessageId: response.id }],
    });

    assert.deepEqual(postAdmissionFailure, { outcome: 'rejected', reason: 'lifecycle_conflict' });
    assert.equal(
      queue.list('t1', 'u1').some((candidate) => candidate.id === postAdmissionFailureCarrier.entry.id),
      false,
      'durably admitted work must not be requeued after compensation',
    );
    const postAdmissionInput = await messageStore.getById(postAdmissionFailureCarrier.message.id);
    const postAdmissionRef = postAdmissionInput.lifecycle.dispatchRefs.find((ref) => ref.targetId === 'codex');
    assert.equal(postAdmissionRef.phase, 'settled');
    assert.notEqual(postAdmissionRef.statusMessageId, response.id);
    assert.equal(postAdmissionInput.queueCustody.status, 'terminal');
    assert.equal(
      (await messageStore.getById(response.id)).lifecycle.inputEntryIds.includes(postAdmissionFailureCarrier.entry.id),
      false,
      'post-admission compensation must detach the input from the response that never received it',
    );
    assert.equal(
      dispatch.mock.calls.length,
      2,
      'provider side effects must not start after exposure persistence fails',
    );

    appendDeps.queueCustodyCoordinator.persistEntry = persistEntry;
    dispatch.mock.mockImplementation(async () => ({
      accepted: true,
      handle: { provider: 'openai_codex', carrier: 'codex_app_server', threadId: 'native-1', turnId: 'turn-1' },
    }));
    const opusResponse = messageStore.append(
      canonicalTestMessageInput({
        userId: 'u1',
        threadId: 't1',
        catId: 'opus',
        content: '',
        mentions: [],
        timestamp: entry.createdAt + 2,
        lifecycle: {
          kind: 'response',
          orderKey: `${entry.createdAt + 2}:turn-2`,
          from: { kind: 'agent', catId: 'opus' },
          invocationId: 'turn-2',
          targetId: 'opus',
          inputEntryIds: ['entry-opus-old'],
          inputMessageIds: ['message-opus-old'],
          status: 'processing',
          startedAt: entry.createdAt + 2,
        },
      }),
    );
    invocationTracker.start('t1', 'opus', 'u1', ['opus'], 'parent-2');
    invocationTracker.bindLifecycleActiveRun(
      {
        threadId: 't1',
        targetId: 'opus',
        invocationId: 'turn-2',
        responseMessageId: opusResponse.id,
        inputEntryIds: ['entry-opus-old'],
        inputMessageIds: ['message-opus-old'],
        privateInputEntryIds: [],
        startedAt: entry.createdAt + 2,
      },
      'parent-2',
    );
    const opusDispatch = mock.fn(async () => ({ accepted: false, reason: 'active_run_closed' }));
    invocationTracker.bindAgentClientActiveRunDispatcher(
      't1',
      'opus',
      {
        invocationId: 'turn-2',
        capabilities: { append: true, steer: true },
        handle: { provider: 'openai_codex', carrier: 'codex_app_server', threadId: 'native-2', turnId: 'turn-2' },
        dispatch: opusDispatch,
      },
      'parent-2',
    );
    const partialCarrier = enqueueCustodiedEntry(queue, messageStore, {
      ownerAuthProvenance: 'strict',
      content: 'append to two active clients',
      targetCats: ['codex', 'opus'],
    });
    const partial = await appendProcessor.appendExactEntry({
      threadId: 't1',
      userId: 'u1',
      entryId: partialCarrier.entry.id,
      expectedQueueRevision: queue.snapshotRevision('t1', 'u1'),
      expectedRuns: [
        { targetId: 'codex', invocationId: 'turn-1', responseMessageId: response.id },
        { targetId: 'opus', invocationId: 'turn-2', responseMessageId: opusResponse.id },
      ],
    });

    assert.deepEqual(partial, {
      outcome: 'rejected',
      reason: 'provider_rejected',
      rejectedTargetIds: ['opus'],
    });
    const partialInput = await messageStore.getById(partialCarrier.message.id);
    assert.deepEqual(
      partialInput.lifecycle.dispatchRefs.find((ref) => ref.targetId === 'codex'),
      { targetId: 'codex', phase: 'dispatched', statusMessageId: response.id },
    );
    assert.equal(partialInput.lifecycle.dispatchRefs.find((ref) => ref.targetId === 'opus').phase, 'settled');
    assert.deepEqual(partialInput.queueCustody.pendingTargetCats, ['codex']);
    assert.equal(partialInput.queueCustody.status, 'processing');
    assert.equal(
      (await messageStore.getById(response.id)).lifecycle.inputEntryIds.includes(partialCarrier.entry.id),
      true,
    );
    assert.equal(
      (await messageStore.getById(opusResponse.id)).lifecycle.inputEntryIds.includes(partialCarrier.entry.id),
      false,
    );
  });

  it('publishes a decision-required push from the canonical queued user execution', async () => {
    const notifyUser = mock.fn(async () => ({}));
    const decisionDeps = stubDeps({
      getPushService: () => ({ notifyUser }),
      router: {
        routeExecution: mock.fn(async function* () {
          yield { type: 'text', catId: 'opus', content: '请你拍板是否合入', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const decisionProcessor = new QueueProcessor(decisionDeps);
    enqueueEntry(decisionDeps.queue, { source: 'user' });

    await decisionProcessor.processNext('t1', 'u1');
    await waitFor(() => notifyUser.mock.calls.length === 1);

    const payload = notifyUser.mock.calls[0].arguments[1];
    assert.equal(payload.tag, 'cat-decision-t1');
    assert.equal(payload.data?.requiresDecision, true);
    assert.match(payload.body, /请你拍板|合入/);
  });

  it('does not infer a decision from the user prompt when queued execution emits no text', async () => {
    const notifyUser = mock.fn(async () => ({}));
    const noTextDeps = stubDeps({
      getPushService: () => ({ notifyUser }),
      router: {
        routeExecution: mock.fn(async function* () {
          yield { type: 'tool_use', catId: 'opus', toolName: 'read_file', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const noTextProcessor = new QueueProcessor(noTextDeps);
    enqueueEntry(noTextDeps.queue, {
      source: 'user',
      content: '请你决定这个 PR 是否合入',
    });

    await noTextProcessor.processNext('t1', 'u1');
    await waitFor(() => notifyUser.mock.calls.length === 1);

    const payload = notifyUser.mock.calls[0].arguments[1];
    assert.equal(payload.tag, 'cat-reply-t1');
    assert.equal(payload.data?.requiresDecision, undefined);
  });

  it('F294 re-resolves a queued Bundle from current source truth immediately before routeExecution', async () => {
    const durableStore = new MessageStore();
    const sourceMessage = durableStore.append(
      canonicalTestMessageInput({
        id: 'source-q1',
        threadId: 'source-thread',
        userId: 'u1',
        catId: 'opus',
        content: 'current source truth at dequeue',
        mentions: [],
        timestamp: 90,
      }),
    );
    const entry = enqueueEntry(deps.queue, {
      content: '转发了 1 条消息 · 来自「Source Thread」',
      idempotencyKey: 'bundle-q1-key',
    });
    const targetMessage = durableStore.append(
      canonicalTestMessageInput({
        id: 'bundle-q1',
        threadId: 't1',
        userId: 'u1',
        catId: null,
        content: '转发了 1 条消息 · 来自「Source Thread」',
        mentions: ['opus'],
        timestamp: 100,
        deliveryStatus: 'queued',
        extra: {
          messageBundle: {
            v: 1,
            sourceThreadId: 'source-thread',
            items: [{ kind: 'message', messageId: sourceMessage.id }],
          },
        },
        queueCustody: createInitialQueuedMessageCustody(entry),
      }),
    );
    deps.queue.backfillMessageId('t1', 'u1', entry.id, targetMessage.id);
    const queueDeps = stubDeps({
      queue: deps.queue,
      threadStore: {
        get: mock.fn(async (threadId) =>
          threadId === 'source-thread'
            ? { id: threadId, title: 'Source Thread', createdBy: 'u1' }
            : { id: threadId, title: 'Target Thread', createdBy: 'u1' },
        ),
        setPendingContinuation: mock.fn(async () => {}),
        consumePendingContinuation: mock.fn(async () => null),
      },
      messageStore: durableStore,
    });
    queueDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
    const queueProcessor = new QueueProcessor(queueDeps);

    const result = await queueProcessor.executeEntry(queueDeps.queue.markProcessing('t1', 'u1'));

    assert.equal(result.status, 'succeeded');
    assert.equal(queueDeps.router.routeExecution.mock.calls.length, 1);
    const routeCall = queueDeps.router.routeExecution.mock.calls[0].arguments;
    assert.match(routeCall[1], /current source truth at dequeue/);
    assert.match(routeCall[1], new RegExp(`Bundle ID: ${targetMessage.id}`));
    assert.equal(routeCall[1].includes(targetMessage.content), false, 'safe summary is not the cat prompt fallback');
    assert.deepEqual(routeCall[6].persistedPromptMessageIds, [targetMessage.id]);
    assert.deepEqual(routeCall[6].persistedPromptMessages, [
      {
        messageId: targetMessage.id,
        content: routeCall[1],
        forceExplicitProjection: true,
      },
    ]);
  });

  it('F294 fails a queued Bundle without invoking a cat when every source has become unavailable', async () => {
    const targetMessage = {
      id: 'bundle-q2',
      threadId: 't1',
      userId: 'u1',
      catId: null,
      content: '转发了 1 条消息 · 来自「Source Thread」',
      mentions: ['opus'],
      timestamp: 100,
      deliveryStatus: 'queued',
      extra: {
        messageBundle: {
          v: 1,
          sourceThreadId: 'source-thread',
          items: [{ kind: 'message', messageId: 'source-q2' }],
        },
      },
    };
    const recalledSource = {
      id: 'source-q2',
      threadId: 'source-thread',
      userId: 'u1',
      catId: null,
      content: 'recalled private source must never reach the cat',
      mentions: [],
      timestamp: 90,
      deliveryStatus: 'canceled',
      _tombstone: true,
      recall: { exposure: 'unseen' },
    };
    const queueDeps = stubDeps({
      threadStore: {
        get: mock.fn(async (threadId) => ({ id: threadId, title: 'Source Thread', createdBy: 'u1' })),
        setPendingContinuation: mock.fn(async () => {}),
        consumePendingContinuation: mock.fn(async () => null),
      },
      messageStore: {
        ...stubDeps().messageStore,
        getById: mock.fn(async (id) =>
          id === targetMessage.id ? targetMessage : id === recalledSource.id ? recalledSource : null,
        ),
      },
    });
    const queueProcessor = new QueueProcessor(queueDeps);
    const entry = enqueueEntry(queueDeps.queue, {
      content: targetMessage.content,
      idempotencyKey: 'bundle-q2-key',
    });
    targetMessage.queueCustody = createInitialQueuedMessageCustody(entry);
    queueDeps.queue.backfillMessageId('t1', 'u1', entry.id, targetMessage.id);

    const result = await queueProcessor.executeEntry(queueDeps.queue.markProcessing('t1', 'u1'));

    assert.equal(result.status, 'failed');
    assert.equal(queueDeps.router.routeExecution.mock.calls.length, 0);
    assert.equal(
      queueDeps.invocationRecordStore.update.mock.calls.some(
        (call) =>
          call.arguments[1]?.status === 'failed' &&
          call.arguments[1]?.error === 'Message Bundle prompt unavailable: all_unavailable',
      ),
      true,
      'the queue must fail for live source invalidation, not an unrelated fixture error',
    );
    assert.equal(
      queueDeps.router.routeExecution.mock.calls.some((call) => call.arguments[1]?.includes(recalledSource.content)),
      false,
    );
  });

  it('ADR-042 claims an exact supplement, rebuilds its prompt, and enforces read-only routing', async () => {
    const closureStore = new InMemoryFreshnessClosureStore();
    const offered = await closureStore.offerSupplement({
      lineageId: 'msg-original',
      originalMessageId: 'msg-original',
      userId: 'u1',
      threadId: 't1',
      catId: 'opus',
      requiredMessageIds: ['msg-update'],
      requiredFrontierMessageId: 'msg-update',
      replayUnsafeToolNames: ['mcp__cat-cafe__cat_cafe_hold_ball'],
      now: 100,
    });
    const routeCalls = [];
    const customDeps = stubDeps({
      freshnessClosureStore: closureStore,
      deliveryCursorStore: { ackSeenCursor: mock.fn(async () => {}) },
      messageStore: {
        ...stubDeps().messageStore,
        getById: mock.fn(async (id) => ({
          id,
          threadId: 't1',
          userId: 'u1',
          catId: id === 'msg-original' ? 'opus' : null,
          content: id === 'msg-original' ? 'published answer' : 'late correction',
          mentions: [],
          timestamp: 100,
        })),
      },
      router: {
        routeExecution: mock.fn(async function* (...args) {
          routeCalls.push(args);
          await closureStore.commitSupplement(offered.supplement.id, {
            invocationId: 'inv-stub',
            messageId: 'msg-supplement',
            now: 200,
          });
          args[6].persistenceContext.outputCommitDecisions = {
            opus: {
              kind: 'committed_fresh',
              messageId: 'msg-supplement',
              freshnessSupplementId: offered.supplement.id,
            },
          };
          yield { type: 'text', catId: 'opus', content: 'concise supplement', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const customProcessor = new QueueProcessor(customDeps);
    enqueueEntry(customDeps.queue, {
      source: 'agent',
      sourceCategory: 'freshness',
      autoExecute: true,
      idempotencyKey: offered.supplement.id,
      freshnessSupplementId: offered.supplement.id,
      freshnessSupplementLineageId: offered.supplement.lineageId,
      freshnessSupplementSeq: offered.supplement.seq,
      readOnlyToolPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
    });

    const result = await customProcessor.executeEntry(customDeps.queue.markProcessing('t1', 'u1'));

    assert.equal(result.status, 'succeeded');
    assert.equal(routeCalls.length, 1);
    assert.match(routeCalls[0][1], /published answer/);
    assert.match(routeCalls[0][1], /late correction/);
    assert.equal(routeCalls[0][6].freshnessSupplementId, offered.supplement.id);
    assert.deepEqual(routeCalls[0][6].toolExecutionPolicy, {
      mode: 'read_only',
      replayDeniedToolNames: ['mcp__cat-cafe__cat_cafe_hold_ball'],
    });
    assert.equal((await closureStore.getSupplement(offered.supplement.id)).status, 'committed');
  });

  it('ADR-042 refreshes a pending supplement with current published updates before claim', async () => {
    const closureStore = new InMemoryFreshnessClosureStore();
    const messageStore = new MessageStore();
    const original = await messageStore.append(
      canonicalTestMessageInput({
        userId: 'u1',
        threadId: 't1',
        catId: 'opus',
        content: 'published answer',
        mentions: [],
        timestamp: 100,
        origin: 'stream',
      }),
    );
    const firstUpdate = await messageStore.append(
      canonicalTestMessageInput({
        userId: 'u1',
        threadId: 't1',
        catId: null,
        content: 'first late correction',
        mentions: ['opus'],
        timestamp: 110,
      }),
    );
    const offered = await closureStore.offerSupplement({
      lineageId: original.id,
      originalMessageId: original.id,
      userId: 'u1',
      threadId: 't1',
      catId: 'opus',
      requiredMessageIds: [firstUpdate.id],
      requiredFrontierMessageId: firstUpdate.id,
      now: 120,
    });
    const currentRelevant = await messageStore.append(
      canonicalTestMessageInput({
        userId: 'u1',
        threadId: 't1',
        catId: 'sonnet',
        content: 'current published review update',
        mentions: ['opus'],
        timestamp: 130,
        origin: 'stream',
        deliveryStatus: 'queued',
      }),
    );
    await messageStore.append(
      canonicalTestMessageInput({
        userId: 'u1',
        threadId: 't1',
        catId: null,
        content: 'directed away',
        mentions: ['fable5'],
        timestamp: 140,
      }),
    );
    await messageStore.append(
      canonicalTestMessageInput({
        userId: 'u1',
        threadId: 't1',
        catId: null,
        content: 'ordinary queued work',
        mentions: ['opus'],
        timestamp: 150,
        deliveryStatus: 'queued',
      }),
    );
    await messageStore.append(
      canonicalTestMessageInput({
        userId: 'u1',
        threadId: 't1',
        catId: 'opus',
        content: 'self output',
        mentions: [],
        timestamp: 160,
        origin: 'stream',
      }),
    );
    await messageStore.append(
      canonicalTestMessageInput({
        userId: 'u1',
        threadId: 't1',
        catId: 'sonnet',
        content: 'same lineage supplement',
        mentions: ['opus'],
        timestamp: 170,
        origin: 'stream',
        extra: {
          supplement: {
            lineageId: original.id,
            supplementId: `f254-supplement:${original.id}:1`,
            seq: 1,
            originalMessageId: original.id,
          },
        },
      }),
    );
    const routeCalls = [];
    const customDeps = stubDeps({
      freshnessClosureStore: closureStore,
      messageStore,
      deliveryCursorStore: { ackSeenCursor: mock.fn(async () => {}) },
      router: {
        routeExecution: mock.fn(async function* (...args) {
          routeCalls.push(args);
          await closureStore.commitSupplement(offered.supplement.id, {
            invocationId: 'inv-stub',
            messageId: 'msg-supplement',
            now: 200,
          });
          args[6].persistenceContext.outputCommitDecisions = {
            opus: {
              kind: 'committed_fresh',
              messageId: 'msg-supplement',
              freshnessSupplementId: offered.supplement.id,
            },
          };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const customProcessor = new QueueProcessor(customDeps);
    enqueueEntry(customDeps.queue, {
      source: 'agent',
      sourceCategory: 'freshness',
      autoExecute: true,
      idempotencyKey: offered.supplement.id,
      freshnessSupplementId: offered.supplement.id,
      freshnessSupplementLineageId: offered.supplement.lineageId,
      freshnessSupplementSeq: offered.supplement.seq,
      readOnlyToolPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
    });

    const result = await customProcessor.executeEntry(customDeps.queue.markProcessing('t1', 'u1'));

    assert.equal(result.status, 'succeeded');
    assert.equal(routeCalls.length, 1);
    const prompt = routeCalls[0][1];
    assert.match(prompt, /first late correction/);
    assert.match(prompt, /current published review update/);
    assert.doesNotMatch(prompt, /directed away/);
    assert.doesNotMatch(prompt, /ordinary queued work/);
    assert.doesNotMatch(prompt, /self output/);
    assert.doesNotMatch(prompt, /same lineage supplement/);
    const terminal = await closureStore.getSupplement(offered.supplement.id);
    assert.deepEqual(terminal.requiredMessageIds, [firstUpdate.id, currentRelevant.id]);
    assert.equal(terminal.seq, 1);
    assert.equal((await closureStore.listSupplementsByLineage(original.id)).length, 1);
  });

  it('ADR-042 fails closed before model launch when supplement preflight cannot advance', async () => {
    const closureStore = new InMemoryFreshnessClosureStore();
    const offered = await closureStore.offerSupplement({
      lineageId: 'msg-original-preflight-blocked',
      originalMessageId: 'msg-original-preflight-blocked',
      userId: 'u1',
      threadId: 't1',
      catId: 'opus',
      requiredMessageIds: ['msg-frontier-stuck'],
      requiredFrontierMessageId: 'msg-frontier-stuck',
      now: 100,
    });
    const routeExecution = mock.fn(async function* () {
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    });
    const customDeps = stubDeps({
      freshnessClosureStore: closureStore,
      messageStore: {
        ...stubDeps().messageStore,
        getByThreadAfter: mock.fn(async () => [
          {
            id: 'msg-frontier-stuck',
            userId: 'u1',
            threadId: 't1',
            catId: null,
            content: 'non-advancing page',
            mentions: ['opus'],
            timestamp: 110,
          },
        ]),
      },
      router: {
        routeExecution,
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const customProcessor = new QueueProcessor(customDeps);
    enqueueEntry(customDeps.queue, {
      source: 'agent',
      sourceCategory: 'freshness',
      autoExecute: true,
      idempotencyKey: offered.supplement.id,
      freshnessSupplementId: offered.supplement.id,
      freshnessSupplementLineageId: offered.supplement.lineageId,
      freshnessSupplementSeq: offered.supplement.seq,
      readOnlyToolPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
    });

    const result = await customProcessor.executeEntry(customDeps.queue.markProcessing('t1', 'u1'));

    assert.equal(result.status, 'failed');
    assert.equal(routeExecution.mock.calls.length, 0);
    assert.equal((await closureStore.getSupplement(offered.supplement.id)).status, 'failed');
  });

  it('ADR-042 fails a supplement before model launch when the hard read-only carrier is absent', async () => {
    const closureStore = new InMemoryFreshnessClosureStore();
    const offered = await closureStore.offerSupplement({
      lineageId: 'msg-original',
      originalMessageId: 'msg-original',
      userId: 'u1',
      threadId: 't1',
      catId: 'opus',
      requiredMessageIds: ['msg-update'],
      requiredFrontierMessageId: 'msg-update',
      now: 100,
    });
    const customDeps = stubDeps({ freshnessClosureStore: closureStore });
    const customProcessor = new QueueProcessor(customDeps);
    enqueueEntry(customDeps.queue, {
      source: 'agent',
      sourceCategory: 'freshness',
      autoExecute: true,
      idempotencyKey: offered.supplement.id,
      freshnessSupplementId: offered.supplement.id,
      freshnessSupplementLineageId: offered.supplement.lineageId,
      freshnessSupplementSeq: offered.supplement.seq,
    });

    const result = await customProcessor.executeEntry(customDeps.queue.markProcessing('t1', 'u1'));

    assert.equal(result.status, 'failed');
    assert.equal(customDeps.router.routeExecution.mock.calls.length, 0);
    const failed = await closureStore.getSupplement(offered.supplement.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureReason, 'read_only_policy_unavailable');
  });

  it('AC-E18 consumes a policy-failed supplement carrier after its durable terminal and never pauses Queue', async () => {
    const { ToolExecutionPolicyUnavailableError } = await import(
      '../dist/domains/cats/services/agents/invocation/tool-execution-policy.js'
    );
    const closureStore = new InMemoryFreshnessClosureStore();
    const offered = await closureStore.offerSupplement({
      lineageId: 'msg-original-policy-failure',
      originalMessageId: 'msg-original-policy-failure',
      userId: 'u1',
      threadId: 't1',
      catId: 'opus',
      requiredMessageIds: ['msg-update-policy-failure'],
      requiredFrontierMessageId: 'msg-update-policy-failure',
      now: 100,
    });
    const customDeps = stubDeps({
      freshnessClosureStore: closureStore,
      messageStore: {
        ...stubDeps().messageStore,
        getById: mock.fn(async (id) => ({
          id,
          threadId: 't1',
          userId: 'u1',
          catId: id === 'msg-original-policy-failure' ? 'opus' : null,
          content: id === 'msg-original-policy-failure' ? 'published answer' : 'late update',
          mentions: [],
          timestamp: 100,
        })),
      },
      router: {
        routeExecution: mock.fn(async function* () {
          throw new ToolExecutionPolicyUnavailableError();
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const customProcessor = new QueueProcessor(customDeps);
    let completionArgs;
    const completeInvocation = customProcessor.onInvocationComplete.bind(customProcessor);
    customProcessor.onInvocationComplete = async (...args) => {
      await completeInvocation(...args);
      completionArgs = args;
    };
    enqueueEntry(customDeps.queue, {
      source: 'agent',
      sourceCategory: 'freshness',
      autoExecute: true,
      idempotencyKey: offered.supplement.id,
      freshnessSupplementId: offered.supplement.id,
      freshnessSupplementLineageId: offered.supplement.lineageId,
      freshnessSupplementSeq: offered.supplement.seq,
      readOnlyToolPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
    });

    await customProcessor.requestDrain('t1');
    await waitFor(() => completionArgs !== undefined, 1_000);

    assert.equal(completionArgs[2], 'failed');
    assert.equal(Boolean(completionArgs[5]), false, 'durable supplement terminal owns the failed carrier');
    const failed = await closureStore.getSupplement(offered.supplement.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureReason, 'read_only_policy_unavailable');
    assert.equal(
      customDeps.queue.list('t1', 'u1').length,
      0,
      'terminal supplement must not remain retryable Queue work',
    );
    assert.equal(customDeps.router.routeExecution.mock.calls.length, 1);
  });

  it('AC-E18 does not resurrect an admitted supplement carrier when terminalization itself fails', async () => {
    const { ToolExecutionPolicyUnavailableError } = await import(
      '../dist/domains/cats/services/agents/invocation/tool-execution-policy.js'
    );
    const closureStore = new InMemoryFreshnessClosureStore();
    const offered = await closureStore.offerSupplement({
      lineageId: 'msg-original-terminal-write-failure',
      originalMessageId: 'msg-original-terminal-write-failure',
      userId: 'u1',
      threadId: 't1',
      catId: 'opus',
      requiredMessageIds: ['msg-update-terminal-write-failure'],
      requiredFrontierMessageId: 'msg-update-terminal-write-failure',
      now: 100,
    });
    closureStore.failSupplement = mock.fn(async () => {
      throw new Error('supplement terminal store unavailable');
    });
    const customDeps = stubDeps({
      freshnessClosureStore: closureStore,
      messageStore: {
        ...stubDeps().messageStore,
        getById: mock.fn(async (id) => ({
          id,
          threadId: 't1',
          userId: 'u1',
          catId: id === 'msg-original-terminal-write-failure' ? 'opus' : null,
          content: id === 'msg-original-terminal-write-failure' ? 'published answer' : 'late update',
          mentions: [],
          timestamp: 100,
        })),
      },
      router: {
        routeExecution: mock.fn(async function* () {
          throw new ToolExecutionPolicyUnavailableError();
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const customProcessor = new QueueProcessor(customDeps);
    const entry = enqueueEntry(customDeps.queue, {
      source: 'agent',
      sourceCategory: 'freshness',
      autoExecute: true,
      idempotencyKey: offered.supplement.id,
      freshnessSupplementId: offered.supplement.id,
      freshnessSupplementLineageId: offered.supplement.lineageId,
      freshnessSupplementSeq: offered.supplement.seq,
      readOnlyToolPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
    });

    const result = await customProcessor.executeEntry(customDeps.queue.markProcessing('t1', 'u1'));

    assert.equal(result.status, 'failed');
    assert.equal(result.primaryEntryRequeued, undefined);
    assert.equal((await closureStore.getSupplement(offered.supplement.id)).status, 'running');
    assert.equal(
      customDeps.queue.getEntrySnapshot('t1', 'u1', entry.id),
      null,
      'provider admission permanently consumes the transient Queue identity',
    );
  });

  it('persists only the exact successful cats before shared-invocation cleanup', async () => {
    const sharedDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* () {
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const sharedProcessor = new QueueProcessor(sharedDeps);
    enqueueEntry(sharedDeps.queue, { targetCats: ['opus', 'codex'] });

    const result = await sharedProcessor.executeEntry(sharedDeps.queue.markProcessing('t1', 'u1'));

    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.successfulCatIds, ['opus']);
    const succeededUpdate = sharedDeps.invocationRecordStore.update.mock.calls.find(
      (call) => call.arguments[1]?.status === 'succeeded',
    );
    assert.ok(succeededUpdate, 'expected a durable succeeded update');
    assert.deepEqual(succeededUpdate.arguments[1].successfulCatIds, ['opus']);
  });

  it('does not persist a canceled cat whose route ends with a bare done', async () => {
    const invocationTracker = new InvocationTracker();
    const sharedDeps = stubDeps({
      invocationTracker,
      router: {
        routeExecution: mock.fn(async function* () {
          assert.equal(invocationTracker.cancel('t1', 'codex', 'u1', 'user_cancel').cancelled, true);
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const sharedProcessor = new QueueProcessor(sharedDeps);
    enqueueEntry(sharedDeps.queue, { targetCats: ['opus', 'codex'] });

    const result = await sharedProcessor.executeEntry(sharedDeps.queue.markProcessing('t1', 'u1'));

    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.successfulCatIds, ['opus']);
    const succeededUpdate = sharedDeps.invocationRecordStore.update.mock.calls.find(
      (call) => call.arguments[1]?.status === 'succeeded',
    );
    assert.ok(succeededUpdate, 'expected a durable succeeded update');
    assert.deepEqual(succeededUpdate.arguments[1].successfulCatIds, ['opus']);
  });

  it('does not persist a cat whose terminal error is followed by a bare done', async () => {
    const sharedDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* () {
          yield { type: 'error', catId: 'codex', error: 'stream failed', timestamp: Date.now() };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const sharedProcessor = new QueueProcessor(sharedDeps);
    enqueueEntry(sharedDeps.queue, { targetCats: ['opus', 'codex'] });

    const result = await sharedProcessor.executeEntry(sharedDeps.queue.markProcessing('t1', 'u1'));

    assert.equal(result.status, 'succeeded');
    assert.deepEqual(result.successfulCatIds, ['opus']);
    const succeededUpdate = sharedDeps.invocationRecordStore.update.mock.calls.find(
      (call) => call.arguments[1]?.status === 'succeeded',
    );
    assert.ok(succeededUpdate, 'expected a durable succeeded update');
    assert.deepEqual(succeededUpdate.arguments[1].successfulCatIds, ['opus']);
  });

  it('preserves the primary child error when every target fails', async () => {
    const sharedDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* () {
          yield {
            type: 'error',
            catId: 'codex',
            error: 'queued_prompt_exposure_rejected:message-same-thread',
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const sharedProcessor = new QueueProcessor(sharedDeps);
    enqueueEntry(sharedDeps.queue, { targetCats: ['codex'], source: 'agent', sourceCategory: 'a2a' });

    const result = await sharedProcessor.executeEntry(sharedDeps.queue.markProcessing('t1', 'u1'));

    assert.equal(result.status, 'failed');
    assert.deepEqual(result.successfulCatIds, []);
    const failedUpdate = sharedDeps.invocationRecordStore.update.mock.calls.find(
      (call) => call.arguments[1]?.status === 'failed',
    );
    assert.ok(failedUpdate, 'expected the terminal child failure to be durable');
    assert.equal(failedUpdate.arguments[1].error, 'queued_prompt_exposure_rejected:message-same-thread');
    assert.equal(
      sharedDeps.invocationRecordStore.update.mock.calls.some((call) => call.arguments[1]?.status === 'succeeded'),
      false,
    );
  });

  it('ADR-042 persists decline while suppressing the marker from the visible stream', async () => {
    const closureStore = new InMemoryFreshnessClosureStore();
    const offered = await closureStore.offerSupplement({
      lineageId: 'msg-original',
      originalMessageId: 'msg-original',
      userId: 'u1',
      threadId: 't1',
      catId: 'opus',
      requiredMessageIds: ['msg-update'],
      requiredFrontierMessageId: 'msg-update',
      now: 100,
    });
    const customDeps = stubDeps({
      freshnessClosureStore: closureStore,
      messageStore: {
        ...stubDeps().messageStore,
        getById: mock.fn(async (id) => ({
          id,
          threadId: 't1',
          userId: 'u1',
          catId: id === 'msg-original' ? 'opus' : null,
          content: id === 'msg-original' ? 'published answer' : 'thanks',
          mentions: [],
          timestamp: 100,
        })),
      },
      router: {
        routeExecution: mock.fn(async function* (...args) {
          await closureStore.declineSupplement(offered.supplement.id, {
            invocationId: 'inv-stub',
            now: 200,
          });
          args[6].persistenceContext.outputCommitDecisions = {
            opus: { kind: 'supplement_declined', freshnessSupplementId: offered.supplement.id },
          };
          yield { type: 'text', catId: 'opus', content: '<!-- cat-cafe:supplement-decline -->', timestamp: 200 };
          yield { type: 'done', catId: 'opus', timestamp: 201 };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const customProcessor = new QueueProcessor(customDeps);
    enqueueEntry(customDeps.queue, {
      source: 'agent',
      sourceCategory: 'freshness',
      autoExecute: true,
      idempotencyKey: offered.supplement.id,
      freshnessSupplementId: offered.supplement.id,
      freshnessSupplementLineageId: offered.supplement.lineageId,
      freshnessSupplementSeq: offered.supplement.seq,
      readOnlyToolPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
    });

    const result = await customProcessor.executeEntry(customDeps.queue.markProcessing('t1', 'u1'));

    assert.equal(result.status, 'succeeded');
    assert.equal((await closureStore.getSupplement(offered.supplement.id)).status, 'declined');
    const visibleText = customDeps.socketManager.broadcastAgentMessage.mock.calls
      .map((call) => call.arguments[0])
      .filter((message) => message.type === 'text');
    assert.deepEqual(visibleText, []);
  });

  it('ADR-042 terminalizes a pending supplement when its queued carrier is removed', async () => {
    const closureStore = new InMemoryFreshnessClosureStore();
    const offered = await closureStore.offerSupplement({
      lineageId: 'msg-original',
      originalMessageId: 'msg-original',
      userId: 'u1',
      threadId: 't1',
      catId: 'opus',
      requiredMessageIds: ['msg-update'],
      requiredFrontierMessageId: 'msg-update',
      now: 100,
    });
    const customDeps = stubDeps({ freshnessClosureStore: closureStore });
    const customProcessor = new QueueProcessor(customDeps);

    await customProcessor.finalizeRemovedEntry({ freshnessSupplementId: offered.supplement.id }, 'user_cancel');

    const failed = await closureStore.getSupplement(offered.supplement.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.failureReason, 'user_cancel');
    assert.equal(customDeps.socketManager.broadcastAgentMessage.mock.calls.length, 1);
  });

  it('ADR-042 recovers append-before-state supplement commit from the durable idempotent body', async () => {
    const closureStore = new InMemoryFreshnessClosureStore();
    const offered = await closureStore.offerSupplement({
      lineageId: 'msg-original',
      originalMessageId: 'msg-original',
      userId: 'u1',
      threadId: 't1',
      catId: 'opus',
      requiredMessageIds: ['msg-update'],
      requiredFrontierMessageId: 'msg-update',
      now: 100,
    });
    const durableMessage = {
      id: 'msg-durable-supplement',
      threadId: 't1',
      userId: 'u1',
      catId: 'opus',
      content: 'durable supplement',
      mentions: [],
      timestamp: 200,
    };
    const customDeps = stubDeps({
      freshnessClosureStore: closureStore,
      messageStore: {
        ...stubDeps().messageStore,
        getById: mock.fn(async (id) => ({
          id,
          threadId: 't1',
          userId: 'u1',
          catId: id === 'msg-original' ? 'opus' : null,
          content: id === 'msg-original' ? 'published answer' : 'late correction',
          mentions: [],
          timestamp: 100,
        })),
        getByIdempotencyKey: mock.fn(async (_userId, _threadId, key) =>
          key === offered.supplement.id ? durableMessage : null,
        ),
      },
      router: {
        routeExecution: mock.fn(async function* (...args) {
          args[6].persistenceContext.outputCommitDecisions = {
            opus: {
              kind: 'committed_degraded_unknown',
              messageId: durableMessage.id,
              reason: 'supplement_state_commit_failed',
            },
          };
          yield { type: 'text', catId: 'opus', content: durableMessage.content, timestamp: 200 };
          yield { type: 'done', catId: 'opus', timestamp: 201 };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const customProcessor = new QueueProcessor(customDeps);
    enqueueEntry(customDeps.queue, {
      source: 'agent',
      sourceCategory: 'freshness',
      autoExecute: true,
      idempotencyKey: offered.supplement.id,
      freshnessSupplementId: offered.supplement.id,
      freshnessSupplementLineageId: offered.supplement.lineageId,
      freshnessSupplementSeq: offered.supplement.seq,
      readOnlyToolPolicy: { mode: 'read_only', replayDeniedToolNames: [] },
    });

    const result = await customProcessor.executeEntry(customDeps.queue.markProcessing('t1', 'u1'));

    assert.equal(result.status, 'succeeded');
    const committed = await closureStore.getSupplement(offered.supplement.id);
    assert.equal(committed.status, 'committed');
    assert.equal(committed.committedMessageId, durableMessage.id);
    const visibleText = customDeps.socketManager.broadcastAgentMessage.mock.calls
      .map((call) => call.arguments[0])
      .filter((message) => message.type === 'text');
    assert.equal(visibleText.length, 1);
    const terminalProjections = customDeps.socketManager.broadcastAgentMessage.mock.calls
      .map((call) => call.arguments[0])
      .filter((message) => {
        if (message.type !== 'system_info' || !message.content.includes('freshness_supplement')) return false;
        return JSON.parse(message.content).status === 'committed';
      });
    assert.equal(terminalProjections.length, 1);
  });

  // ── onInvocationComplete ──

  describe('F254 durable queued-user lifecycle', () => {
    it('binds exact incrementally exposed queued messages to the active invocation', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({ messageStore: durableStore });
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const first = enqueueCustodiedEntry(durableDeps.queue, durableStore, { content: 'first queued body' });
      const second = enqueueCustodiedEntry(durableDeps.queue, durableStore, { content: 'second queued body' });

      await durableProcessor.markPromptMessagesSeen({
        threadId: 't1',
        userId: 'u1',
        catId: 'opus',
        invocationId: 'inv-incremental',
        messageIds: [first.message.id, second.message.id],
        seenAt: 1_234,
      });

      for (const queued of [first, second]) {
        const snapshot = durableDeps.queue.getEntrySnapshot('t1', 'u1', queued.entry.id);
        assert.deepEqual(snapshot.queuedSeenByCatIds, ['opus']);
        assert.deepEqual(snapshot.queuedSeenInvocationIdByCatId, { opus: 'inv-incremental' });
        const stored = durableStore.getById(queued.message.id);
        assert.deepEqual(stored.queueCustody.seenByCatIds, ['opus']);
        assert.deepEqual(stored.queueCustody.seenInvocationIdByCatId, { opus: 'inv-incremental' });
        assert.deepEqual(stored.queueCustody.bodyExposures, [
          { targetCatId: 'opus', invocationId: 'inv-incremental', seenAt: 1_234 },
        ]);
      }
    });

    it('acks a mention cursor only when its exact queued body is durably exposed', async () => {
      const durableStore = new MessageStore();
      const ackMentionCursor = mock.fn(async () => {});
      const durableDeps = stubDeps({
        messageStore: durableStore,
        deliveryCursorStore: {
          ackMentionCursor,
          ackSeenCursor: mock.fn(async () => {}),
        },
      });
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const queued = enqueueCustodiedEntry(durableDeps.queue, durableStore, { content: '@opus queued mention' });

      assert.equal(ackMentionCursor.mock.calls.length, 0);
      await durableProcessor.markPromptMessagesSeen({
        threadId: 't1',
        userId: 'u1',
        catId: 'opus',
        invocationId: 'inv-mention-body',
        messageIds: [queued.message.id],
        seenAt: 1_234,
      });

      assert.equal(ackMentionCursor.mock.calls.length, 1);
      assert.deepEqual(ackMentionCursor.mock.calls[0].arguments, [
        'u1',
        'opus',
        't1',
        await durableStore.canonicalizeCursor(queued.message.id, 't1'),
      ]);
    });

    it('ignores ordinary prompt history while still requiring exact custody exposure witnesses', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({ messageStore: durableStore });
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const historical = durableStore.append(
        canonicalTestMessageInput({
          threadId: 't1',
          userId: 'u1',
          catId: 'codex',
          content: 'ordinary published history',
          mentions: [],
          timestamp: 1_000,
        }),
      );
      const queued = enqueueCustodiedEntry(durableDeps.queue, durableStore, { content: 'new queued body' });

      await durableProcessor.markPromptMessagesSeen({
        threadId: 't1',
        userId: 'u1',
        catId: 'opus',
        invocationId: 'inv-with-history',
        messageIds: [historical.id, queued.message.id],
        seenAt: 1_234,
      });

      assert.equal(durableStore.getById(historical.id).queueCustody, undefined);
      assert.deepEqual(durableStore.getById(queued.message.id).queueCustody.bodyExposures, [
        { targetCatId: 'opus', invocationId: 'inv-with-history', seenAt: 1_234 },
      ]);
    });

    it('does not require this invocation to witness a queued carrier owned by another target cat', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({ messageStore: durableStore });
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const foreignTarget = enqueueCustodiedEntry(durableDeps.queue, durableStore, {
        content: 'queued body for fable5 only',
        targetCats: ['fable5'],
      });

      await durableProcessor.markPromptMessagesSeen({
        threadId: 't1',
        userId: 'u1',
        catId: 'opus',
        invocationId: 'inv-opus-cross-target',
        messageIds: [foreignTarget.message.id],
        seenAt: 1_234,
      });

      const stored = durableStore.getById(foreignTarget.message.id);
      assert.equal(stored.queueCustody.bodyExposures, undefined);
      assert.deepEqual(stored.queueCustody.pendingTargetCats, ['fable5']);
    });

    it('aborts before provider startup when true recall wins the prompt-exposure race', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({ messageStore: durableStore });
      const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      durableDeps.queueCustodyCoordinator = coordinator;
      const durableProcessor = new QueueProcessor(durableDeps);
      const queued = enqueueCustodiedEntry(durableDeps.queue, durableStore, { content: 'body recalled at boundary' });

      const snapshot = durableDeps.queue.getEntrySnapshot('t1', 'u1', queued.entry.id);
      assert.ok(snapshot);
      assert.equal(durableDeps.queue.removeEntrySnapshotIfUnchanged(snapshot), true);
      const recalled = await coordinator.recallMessageToComposerDraft(queued.entry.id, queued.message.id, {
        ownerUserId: 'u1',
        threadId: 't1',
        expectedDraftRevision: 0,
        merge: 'replace',
        recalledAt: 1_200,
      });
      assert.equal(recalled.kind, 'recalled');
      assert.equal(recalled.verdict, 'zero_exposure');

      await assert.rejects(
        durableProcessor.markPromptMessagesSeen({
          threadId: 't1',
          userId: 'u1',
          catId: 'opus',
          invocationId: 'inv-lost-race',
          messageIds: [queued.message.id],
          seenAt: 1_234,
        }),
        /queued_prompt_exposure_rejected/,
      );
      assert.deepEqual(durableStore.getById(queued.message.id).queueCustody.bodyExposures, undefined);
    });

    it('classifies recall as exposed when prompt evidence owns the carrier lock first', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({ messageStore: durableStore });
      const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      durableDeps.queueCustodyCoordinator = coordinator;
      const durableProcessor = new QueueProcessor(durableDeps);
      const queued = enqueueCustodiedEntry(durableDeps.queue, durableStore, { content: 'body read before recall' });

      await durableProcessor.markPromptMessagesSeen({
        threadId: 't1',
        userId: 'u1',
        catId: 'opus',
        invocationId: 'inv-won-race',
        messageIds: [queued.message.id],
        seenAt: 1_234,
      });
      const recalled = await coordinator.recallMessageToComposerDraft(queued.entry.id, queued.message.id, {
        ownerUserId: 'u1',
        threadId: 't1',
        expectedDraftRevision: 0,
        merge: 'replace',
        recalledAt: 1_300,
      });

      assert.equal(recalled.kind, 'recalled');
      assert.equal(recalled.verdict, 'exposed');
      assert.deepEqual(recalled.message.recall.exposures, [
        { targetCatId: 'opus', invocationId: 'inv-won-race', seenAt: 1_234 },
      ]);
    });

    it('restores the complete multi-target Queue snapshot when custody commit fails after tentative consume', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({ messageStore: durableStore });
      durableDeps.queueCustodyCoordinator = {
        commitSuccessfulTargetsForMessages: mock.fn(async () => {
          throw new Error('redis unavailable');
        }),
      };
      const durableProcessor = new QueueProcessor(durableDeps);
      const { entry } = enqueueCustodiedEntry(durableDeps.queue, durableStore, {
        targetCats: ['opus', 'codex'],
      });
      assert.equal(durableDeps.queue.markQueuedSeen('t1', 'u1', entry.id, 'opus', 'inv-opus-1'), true);

      await durableProcessor.onInvocationComplete('t1', 'opus', 'succeeded', 'inv-opus-1', ['opus']);

      const restored = durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id);
      assert.deepEqual(restored.targetCats, ['opus', 'codex']);
      assert.deepEqual(restored.queuedSeenByCatIds, ['opus']);
      assert.deepEqual(restored.queuedSeenInvocationIdByCatId, { opus: 'inv-opus-1' });
      assert.equal(restored.queuedHandledByCatIds, undefined);
      assert.equal(durableDeps.queueCustodyCoordinator.commitSuccessfulTargetsForMessages.mock.calls.length, 1);
    });

    it('moves the same source into History at admission and terminalizes it on exact success', async () => {
      const { commitLifecycleResponseFromAppendInput } = await import(
        '../dist/domains/cats/services/stores/ports/MessageStore.js'
      );
      const durableStore = new MessageStore();
      let observedAtProvider;
      let observedResponseAtProvider;
      let lifecycleResponseId;
      const seenAt = 1_700;
      const durableDeps = stubDeps({
        messageStore: durableStore,
        router: {
          routeExecution: mock.fn(async function* (...args) {
            const routedOptions = args[6];
            const lifecycleAdmission = await routedOptions.onLifecycleInvocationStarted({
              threadId: 't1',
              userId: 'u1',
              catId: 'opus',
              invocationId: 'child-inv-stub',
              parentInvocationId: routedOptions.parentInvocationId,
              startedAt: seenAt - 10,
            });
            lifecycleResponseId = lifecycleAdmission.responseMessageId;
            await routedOptions.onPromptMessagesExposed({
              threadId: 't1',
              userId: 'u1',
              catId: 'opus',
              invocationId: 'child-inv-stub',
              messageIds: [args[3]],
              seenAt,
            });
            observedAtProvider = structuredClone(durableStore.getById(args[3]));
            observedResponseAtProvider = structuredClone(durableStore.getById(lifecycleResponseId));
            await commitLifecycleResponseFromAppendInput(
              durableStore,
              lifecycleResponseId,
              'child-inv-stub',
              { status: 'completed', completedAt: seenAt + 10 },
              {
                userId: 'u1',
                threadId: 't1',
                catId: 'opus',
                content: 'same durable response',
                mentions: [],
                origin: 'stream',
                timestamp: seenAt + 10,
              },
            );
            yield {
              type: 'system_info',
              catId: 'opus',
              content: JSON.stringify({
                type: 'invocation_created',
                invocationId: 'child-inv-stub',
                startedAt: seenAt - 10,
              }),
              lifecycleResponseMessageId: lifecycleResponseId,
              lifecyclePriorFrontierMessageId: lifecycleAdmission.priorFrontierMessageId,
              timestamp: seenAt - 10,
            };
            yield { type: 'done', catId: 'opus', invocationId: 'child-inv-stub', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      durableDeps.invocationTracker.bindLifecycleActiveRun = mock.fn(() => true);
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const { message, entry } = enqueueCustodiedEntry(durableDeps.queue, durableStore);

      const started = await durableProcessor.processNext('t1', 'u1');
      assert.equal(started.started, true);
      await waitFor(() => durableStore.getById(message.id)?.queueCustody?.status === 'terminal');

      assert.equal(observedAtProvider.deliveryStatus, 'delivered');
      assert.equal(observedAtProvider.queueCustody.status, 'processing');
      assert.equal(observedAtProvider.queueCustody.receiptScope, 'primary_trigger');
      assert.equal(observedAtProvider.queueCustody.seenInvocationIdByCatId.opus, 'child-inv-stub');
      assert.deepEqual(observedAtProvider.queueCustody.bodyExposures, [
        { targetCatId: 'opus', invocationId: 'child-inv-stub', seenAt },
      ]);
      assert.deepEqual(observedAtProvider.lifecycle.dispatchRefs, [
        { targetId: 'opus', phase: 'dispatched', statusMessageId: lifecycleResponseId },
      ]);
      assert.equal(observedResponseAtProvider.id, lifecycleResponseId);
      assert.equal(observedResponseAtProvider.lifecycle.status, 'processing');
      assert.equal(observedResponseAtProvider.content, '');
      assert.equal(durableDeps.invocationTracker.bindLifecycleActiveRun.mock.calls.length, 1);
      assert.deepEqual(durableDeps.invocationTracker.bindLifecycleActiveRun.mock.calls[0].arguments[0], {
        threadId: 't1',
        targetId: 'opus',
        invocationId: 'child-inv-stub',
        responseMessageId: lifecycleResponseId,
        inputEntryIds: [entry.id],
        inputMessageIds: [message.id],
        privateInputEntryIds: [],
        startedAt: seenAt - 10,
      });
      const settledResponse = durableStore.getById(lifecycleResponseId);
      assert.equal(settledResponse.id, observedResponseAtProvider.id);
      assert.equal(settledResponse.lifecycle.status, 'completed');
      assert.equal(settledResponse.content, 'same durable response');
      const terminal = durableStore.getById(message.id);
      assert.deepEqual(terminal.lifecycle.dispatchRefs, [
        { targetId: 'opus', phase: 'settled', statusMessageId: lifecycleResponseId },
      ]);
      const lifecycleUpdates = durableDeps.socketManager.emitToUser.mock.calls
        .filter((call) => call.arguments[1] === 'message_lifecycle_updated')
        .map((call) => call.arguments[2].message);
      assert.ok(
        lifecycleUpdates.some(
          (candidate) => candidate.id === message.id && candidate.lifecycle?.dispatchRefs?.[0]?.phase === 'dispatched',
        ),
        'admission must publish the input dispatch ref without waiting for refresh',
      );
      assert.ok(
        lifecycleUpdates.some(
          (candidate) => candidate.id === lifecycleResponseId && candidate.lifecycle?.status === 'processing',
        ),
        'admission must publish the same processing response id before provider work',
      );
      assert.ok(
        lifecycleUpdates.some(
          (candidate) => candidate.id === message.id && candidate.lifecycle?.dispatchRefs?.[0]?.phase === 'settled',
        ),
        'terminal commit must publish the settled input ref',
      );
      assert.ok(
        lifecycleUpdates.some(
          (candidate) => candidate.id === lifecycleResponseId && candidate.lifecycle?.status === 'completed',
        ),
        'terminal commit must update the same response id',
      );
      assert.equal(terminal.queueCustody.status, 'terminal');
      assert.deepEqual(terminal.queueCustody.handledByCatIds, ['opus']);
      assert.deepEqual(terminal.queueCustody.targetOutcomeByCatId.opus, {
        invocationId: 'child-inv-stub',
        disposition: 'completed_with_turn',
        evidenceRef: { kind: 'invocation_lineage', invocationId: 'child-inv-stub' },
        handledAt: terminal.queueCustody.targetOutcomeByCatId.opus.handledAt,
      });
      assert.ok(seenAt < terminal.queueCustody.targetOutcomeByCatId.opus.handledAt);
      assert.ok(terminal.deliveredAt <= terminal.queueCustody.targetOutcomeByCatId.opus.handledAt);
      const delivered = durableDeps.socketManager.emitToUser.mock.calls.find(
        (call) => call.arguments[1] === 'messages_delivered',
      );
      const receipt = delivered.arguments[2].messages[0].extra.queueReceipt;
      assert.equal(receipt.version, 1);
      assert.equal(receipt.entryId, terminal.queueCustody.entryId);
      assert.equal(receipt.scope, 'primary_trigger');
      assert.deepEqual(receipt.reminderAttempts, []);
      const [admittedTarget] = receipt.targets;
      assert.equal(admittedTarget.catId, 'opus');
      assert.equal(admittedTarget.state, 'queued');
      assert.equal(admittedTarget.invocationId, undefined);
      const handledTarget = projectQueueReceipt(terminal.queueCustody).targets[0];
      assert.equal(handledTarget.state, 'handled');
      assert.equal(handledTarget.invocationId, 'child-inv-stub');
      assert.equal(handledTarget.seenAt, seenAt);
      assert.deepEqual(handledTarget.outcome, terminal.queueCustody.targetOutcomeByCatId.opus);
      assert.deepEqual(
        handledTarget.attempts?.map(({ id, targetCatId, sequence, state, invocationId, seenAt: attemptSeenAt }) => ({
          id,
          targetCatId,
          sequence,
          state,
          invocationId,
          seenAt: attemptSeenAt,
        })),
        [
          {
            id: `${terminal.queueCustody.entryId}:opus:1`,
            targetCatId: 'opus',
            sequence: 1,
            state: 'handled',
            invocationId: 'child-inv-stub',
            seenAt,
          },
        ],
      );
      assert.equal(durableDeps.queue.list('t1', 'u1').length, 0);
    });

    it('binds private Queue input only through ActiveRun without publishing an input message', async () => {
      const durableStore = new MessageStore();
      const bindLifecycleActiveRun = mock.fn(() => true);
      let lifecycleResponseId;
      const durableDeps = stubDeps({
        messageStore: durableStore,
        router: {
          routeExecution: mock.fn(async function* (...args) {
            const routedOptions = args[6];
            const lifecycleAdmission = await routedOptions.onLifecycleInvocationStarted({
              threadId: 't1',
              userId: 'u1',
              catId: 'opus',
              invocationId: 'private-child-inv',
              parentInvocationId: routedOptions.parentInvocationId,
              startedAt: 1_800,
            });
            lifecycleResponseId = lifecycleAdmission.responseMessageId;
            yield {
              type: 'system_info',
              catId: 'opus',
              content: JSON.stringify({
                type: 'invocation_created',
                invocationId: 'private-child-inv',
                startedAt: 1_800,
              }),
              lifecycleResponseMessageId: lifecycleResponseId,
              lifecyclePriorFrontierMessageId: lifecycleAdmission.priorFrontierMessageId,
              timestamp: 1_800,
            };
            yield { type: 'done', catId: 'opus', invocationId: 'private-child-inv', timestamp: 1_900 };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      durableDeps.invocationTracker.bindLifecycleActiveRun = bindLifecycleActiveRun;
      const durableProcessor = new QueueProcessor(durableDeps);
      const privateEntry = durableDeps.queue.enqueue(
        canonicalTestQueueInput({
          threadId: 't1',
          userId: 'u1',
          kind: 'private_input',
          ownerAuthProvenance: 'strict',
          content: 'private protocol body',
          source: 'system',
          targetCats: ['opus'],
          intent: 'execute',
          autoExecute: true,
        }),
      ).entry;

      const started = await durableProcessor.processNext('t1', 'u1');
      assert.equal(started.started, true);
      await waitFor(() => bindLifecycleActiveRun.mock.calls.length === 1);

      assert.deepEqual(bindLifecycleActiveRun.mock.calls[0].arguments[0], {
        threadId: 't1',
        targetId: 'opus',
        invocationId: 'private-child-inv',
        responseMessageId: lifecycleResponseId,
        inputEntryIds: [privateEntry.id],
        inputMessageIds: [],
        privateInputEntryIds: [privateEntry.id],
        startedAt: 1_800,
      });
      const history = durableStore.getByThread('t1', 20, 'u1');
      assert.equal(history.length, 1, 'only the response bubble may enter History');
      assert.equal(history[0].id, lifecycleResponseId);
      assert.equal(history[0].content.includes('private protocol body'), false);
      assert.deepEqual(history[0].lifecycle.inputEntryIds, [privateEntry.id]);
      assert.deepEqual(history[0].lifecycle.inputMessageIds, []);
    });

    it('does not publish canceled visible output as invocation-lineage receipt evidence', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({ messageStore: durableStore });
      const { entry, message } = enqueueCustodiedEntry(durableDeps.queue, durableStore);
      const coordinator = new QueuedMessageCustodyCoordinator({
        messageStore: durableStore,
        now: () => entry.createdAt + 300,
      });
      durableDeps.queueCustodyCoordinator = coordinator;
      const durableProcessor = new QueueProcessor(durableDeps);
      const invocationId = 'child-output-preflight-rejected';

      assert.equal(
        durableDeps.queue.markQueuedSeen('t1', 'u1', entry.id, 'opus', invocationId, entry.createdAt + 100),
        true,
      );
      await coordinator.persistEntry(durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id));
      const rejectedOutput = durableStore.append(
        canonicalTestMessageInput({
          threadId: 't1',
          userId: 'u1',
          catId: 'opus',
          content: 'output rejected by the holder fence',
          mentions: [],
          timestamp: entry.createdAt + 200,
          deliveryStatus: 'queued',
          extra: { stream: { invocationId, turnInvocationId: invocationId } },
        }),
      );
      assert.equal(durableStore.markCanceled(rejectedOutput.id)?.deliveryTransitioned, true);

      await durableProcessor.onInvocationComplete('t1', 'opus', 'succeeded', invocationId, ['opus']);

      const settled = durableStore.getById(message.id);
      assert.equal(settled.deliveryStatus, 'delivered');
      assert.equal(settled.queueCustody.status, 'terminal');
      assert.equal(settled.queueCustody.targetOutcomeByCatId.opus.disposition, 'completed_with_turn');
      assert.deepEqual(settled.queueCustody.targetOutcomeByCatId.opus.evidenceRef, {
        kind: 'turn_execution',
        invocationId,
      });
      assert.equal(
        durableStore
          .getByThreadAfter('t1', undefined, undefined, 'u1')
          .some((candidate) => candidate.id === rejectedOutput.id),
        false,
      );
    });

    it('delivers only the fully settled message from a coalesced cross-thread target carrier', async () => {
      const durableStore = new MessageStore();
      const queue = new InvocationQueue();
      const enqueueCarrier = (catId, triggerMessageId, autoExecute = true) =>
        queue.enqueue(
          canonicalTestQueueInput({
            threadId: 't1',
            userId: 'u1',
            kind: 'message_wake',
            content: 'first handoff',
            source: 'agent',
            ownerAuthProvenance: 'unknown',
            sourceCategory: 'a2a',
            targetCats: [catId],
            intent: 'execute',
            autoExecute,
            callerCatId: 'sonnet',
            a2aParentInvocationId: 'parent-source',
            a2aTriggerMessageId: triggerMessageId,
          }),
        ).entry;
      const opusCarrier = enqueueCarrier('opus', 'message-first');
      const codexCarrier = enqueueCarrier('codex', 'message-first', false);
      const first = durableStore.append(
        canonicalTestMessageInput({
          threadId: 't1',
          userId: 'u1',
          catId: 'sonnet',
          content: 'first handoff',
          mentions: ['opus', 'codex'],
          timestamp: opusCarrier.createdAt,
          deliveryStatus: 'queued',
        }),
      );
      queue.backfillMessageId('t1', 'u1', opusCarrier.id, first.id);
      queue.backfillMessageId('t1', 'u1', codexCarrier.id, first.id);
      assert.equal(
        durableStore.initializeQueueCustody(
          first.id,
          createInitialCrossThreadQueuedMessageCustody(first.id, [opusCarrier, codexCarrier], {
            requestedTargetCats: ['opus', 'codex'],
            createdAt: first.timestamp,
          }),
        ).kind,
        'initialized',
      );
      const second = durableStore.append(
        canonicalTestMessageInput({
          threadId: 't1',
          userId: 'u1',
          catId: 'sonnet',
          content: 'second handoff',
          mentions: ['opus'],
          timestamp: opusCarrier.createdAt + 1,
          deliveryStatus: 'queued',
        }),
      );
      assert.equal(
        queue.coalesceContentIntoQueuedAgent(
          't1',
          'u1',
          opusCarrier.id,
          second.content,
          second.id,
          'sonnet',
          'parent-source',
        ),
        true,
      );
      assert.equal(
        durableStore.initializeQueueCustody(
          second.id,
          createInitialCrossThreadQueuedMessageCustody(
            second.id,
            [queue.getEntrySnapshot('t1', 'u1', opusCarrier.id)],
            { requestedTargetCats: ['opus'], createdAt: second.timestamp },
          ),
        ).kind,
        'initialized',
      );
      const invocationId = 'child-opus-coalesced';
      const seenAt = Math.max(opusCarrier.createdAt, codexCarrier.createdAt) + 100;
      assert.equal(queue.markQueuedSeen('t1', 'u1', opusCarrier.id, 'opus', invocationId, seenAt), true);
      const coordinator = new QueuedMessageCustodyCoordinator({
        messageStore: durableStore,
        now: () => seenAt + 100,
      });
      await coordinator.persistEntry(queue.getEntrySnapshot('t1', 'u1', opusCarrier.id));
      const durableDeps = stubDeps({ queue, messageStore: durableStore, queueCustodyCoordinator: coordinator });
      durableDeps.invocationTracker.has = mock.fn((_threadId, catId) => catId === 'codex');
      const durableProcessor = new QueueProcessor(durableDeps);

      await durableProcessor.onInvocationComplete('t1', 'opus', 'succeeded', invocationId, ['opus']);

      assert.equal(durableStore.getById(first.id).deliveryStatus, 'queued');
      assert.deepEqual(durableStore.getById(first.id).queueCustody.pendingTargetCats, ['codex']);
      assert.equal(durableStore.getById(second.id).deliveryStatus, 'delivered');
      const delivered = durableDeps.socketManager.emitToUser.mock.calls.find(
        (call) => call.arguments[1] === 'messages_delivered',
      );
      assert.deepEqual(delivered.arguments[2].messageIds, [second.id]);
      assert.equal(
        delivered.arguments[2].messageIds.includes(first.id),
        false,
        'M1 must not emit until its codex target settles',
      );
      const remaining = queue.list('t1', 'u1');
      assert.equal(remaining.length, 1);
      assert.equal(remaining[0].id, codexCarrier.id);
      assert.deepEqual(remaining[0].targetCats, ['codex']);

      const codexInvocationId = 'child-codex-coalesced';
      assert.equal(queue.markQueuedSeen('t1', 'u1', codexCarrier.id, 'codex', codexInvocationId, seenAt + 200), true);
      await coordinator.persistEntry(queue.getEntrySnapshot('t1', 'u1', codexCarrier.id));
      durableDeps.invocationTracker.has = mock.fn(() => false);
      await durableProcessor.onInvocationComplete('t1', 'codex', 'succeeded', codexInvocationId, ['codex']);

      assert.equal(durableStore.getById(first.id).deliveryStatus, 'delivered');
      assert.deepEqual(durableStore.getById(first.id).queueCustody.pendingTargetCats, []);
      const deliveredEvents = durableDeps.socketManager.emitToUser.mock.calls.filter(
        (call) => call.arguments[1] === 'messages_delivered',
      );
      assert.deepEqual(
        deliveredEvents.map((call) => call.arguments[2].messageIds),
        [[second.id], [first.id]],
        'M1 must emit only after its remaining codex target settles',
      );
      assert.deepEqual(queue.list('t1', 'u1'), []);
    });

    it('persists exact terminal-silent consumption proof on the handled target receipt', async () => {
      const durableStore = new MessageStore();
      const seenAt = 1_750;
      const durableDeps = stubDeps({
        messageStore: durableStore,
        router: {
          routeExecution: mock.fn(async function* (...args) {
            await args[6].onPromptMessagesExposed({
              threadId: 't1',
              userId: 'u1',
              catId: 'opus',
              invocationId: 'child-terminal-silent',
              messageIds: [args[3]],
              seenAt,
            });
            yield {
              type: 'done',
              catId: 'opus',
              invocationId: 'child-terminal-silent',
              turnCustodyTerminalWitness: {
                kind: 'terminal_silent',
                projectionState: 'covered_empty',
                wake: 'coordination_terminal',
              },
              timestamp: Date.now(),
            };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const { message } = enqueueCustodiedEntry(durableDeps.queue, durableStore);

      const started = await durableProcessor.processNext('t1', 'u1');
      assert.equal(started.started, true);
      await waitFor(() => durableStore.getById(message.id)?.queueCustody?.status === 'terminal');

      assert.deepEqual(durableStore.getById(message.id).queueCustody.targetOutcomeByCatId.opus.consumption, {
        kind: 'terminal_silent',
        projectionState: 'covered_empty',
        wake: 'coordination_terminal',
      });
    });

    it('settles a managed hold carrier only from exact structured-continuation proof', async () => {
      const durableStore = new MessageStore();
      const seenAt = 1_752;
      const durableDeps = stubDeps({
        messageStore: durableStore,
        router: {
          routeExecution: mock.fn(async function* (...args) {
            const adoptedWakes = await args[6].onPromptMessagesExposed({
              threadId: 't1',
              userId: 'u1',
              catId: 'opus',
              invocationId: 'child-managed-rehold',
              messageIds: [args[3]],
              seenAt,
            });
            assert.equal(adoptedWakes.length, 1);
            yield {
              type: 'done',
              catId: 'opus',
              invocationId: 'child-managed-rehold',
              turnCustodyTerminalWitnesses: adoptedWakes.map((wake) => ({
                kind: 'managed_hold_continued',
                sourceMessageId: wake.sourceMessageId,
                taskId: wake.taskId,
                transition: 'reheld',
              })),
              timestamp: Date.now(),
            };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const { message } = enqueueCustodiedEntry(durableDeps.queue, durableStore, {
        source: 'connector',
        sourceCategory: 'scheduled',
        messageSource: {
          connector: 'hold-ball',
          label: '持球通知',
          meta: { taskId: 'task-managed-rehold', threadId: 't1', catId: 'opus', wakeWhen: true },
        },
      });

      const started = await durableProcessor.processNext('t1', 'u1');
      assert.equal(started.started, true);
      await waitFor(() => durableStore.getById(message.id)?.queueCustody?.status === 'terminal');

      const outcome = durableStore.getById(message.id).queueCustody.targetOutcomeByCatId.opus;
      assert.equal(outcome.disposition, 'managed_hold_disposition');
      assert.deepEqual(outcome.consumption, {
        kind: 'managed_hold_continued',
        sourceMessageId: message.id,
        taskId: 'task-managed-rehold',
        transition: 'reheld',
      });
    });

    it('settles every managed hold body adopted by an already-running ordinary child', async () => {
      const durableStore = new MessageStore();
      const childInvocationId = 'child-user-turn-adopted-holds';
      const durableDeps = stubDeps({
        messageStore: durableStore,
        turnExecutionStore: {
          get: mock.fn(async (invocationId) =>
            invocationId === childInvocationId
              ? {
                  invocationId,
                  parentInvocationId: 'parent-user-turn',
                  threadId: 't1',
                  userId: 'u1',
                  catId: 'opus',
                  executionKind: 'ordinary',
                  startedAt: 1_700,
                  status: 'succeeded',
                  endedAt: 1_900,
                }
              : null,
          ),
        },
      });
      const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      durableDeps.queueCustodyCoordinator = coordinator;
      const durableProcessor = new QueueProcessor(durableDeps);
      const first = enqueueCustodiedEntry(durableDeps.queue, durableStore, {
        content: 'first managed completion',
        source: 'connector',
        sourceCategory: 'scheduled',
        messageSource: {
          connector: 'hold-ball',
          label: '持球通知',
          meta: { taskId: 'task-adopted-1', threadId: 't1', catId: 'opus', wakeWhen: true },
        },
      });
      const second = enqueueCustodiedEntry(durableDeps.queue, durableStore, {
        content: 'second managed completion',
        source: 'connector',
        sourceCategory: 'scheduled',
        messageSource: {
          connector: 'hold-ball',
          label: '持球通知',
          meta: { taskId: 'task-adopted-2', threadId: 't1', catId: 'opus', wakeWhen: true },
        },
      });

      const adoptedWakes = await durableProcessor.markPromptMessagesSeen({
        threadId: 't1',
        userId: 'u1',
        catId: 'opus',
        invocationId: childInvocationId,
        messageIds: [first.message.id, second.message.id],
        seenAt: 1_750,
      });
      assert.deepEqual(
        adoptedWakes.map(({ sourceMessageId, taskId }) => ({ sourceMessageId, taskId })),
        [
          { sourceMessageId: first.message.id, taskId: 'task-adopted-1' },
          { sourceMessageId: second.message.id, taskId: 'task-adopted-2' },
        ],
      );

      await durableProcessor.onInvocationComplete(
        't1',
        'opus',
        'succeeded',
        'parent-user-turn',
        ['opus'],
        false,
        { opus: childInvocationId },
        [first.entry.id, second.entry.id],
        {
          [childInvocationId]: adoptedWakes.map((wake) => ({
            kind: 'managed_hold_continued',
            sourceMessageId: wake.sourceMessageId,
            taskId: wake.taskId,
            transition: 'reheld',
          })),
        },
      );

      assert.deepEqual(durableDeps.queue.list('t1', 'u1'), []);
      for (const { message } of [first, second]) {
        const settled = durableStore.getById(message.id);
        assert.equal(settled.deliveryStatus, 'delivered');
        assert.equal(settled.queueCustody.status, 'terminal');
        assert.equal(settled.queueCustody.targetOutcomeByCatId.opus.disposition, 'managed_hold_disposition');
        assert.equal(settled.queueCustody.targetOutcomeByCatId.opus.consumption.sourceMessageId, message.id);
      }
    });

    it('handled dispatch provider termination settles its sources without manufacturing another Queue run', async () => {
      const durableStore = new MessageStore();
      const seenAt = 1_754;
      const dispositionAt = 2_000;
      const routeCalls = [];
      let secondarySourceMessageId;
      const continuationCoordinator = {
        resolveSessionStrategy: mock.fn(async () => 'reborn'),
        prepareInvocationContext: mock.fn(async ({ content }) => ({ content, sessionPolicy: 'fresh' })),
        commitInvocationOutcome: mock.fn(async () => {}),
      };
      const durableDeps = stubDeps({
        messageStore: durableStore,
        sessionContinuationCoordinator: continuationCoordinator,
        router: {
          routeExecution: mock.fn(async function* (...args) {
            routeCalls.push({ content: args[1], messageId: args[3] });
            await args[6].onPromptMessagesExposed({
              threadId: 't1',
              userId: 'u1',
              catId: 'opus',
              invocationId: 'child-dispatch-handled',
              messageIds: [args[3], secondarySourceMessageId].filter(Boolean),
              seenAt,
            });
            yield {
              type: 'done',
              catId: 'opus',
              invocationId: 'child-dispatch-handled',
              turnCustodyTerminalWitness: {
                kind: 'dispatch_handled_continuation',
                sourceMessageId: args[3],
                dispositionEventId: `dispatch-disposition:child-dispatch-handled:${args[3]}`,
                dispositionAt,
              },
              timestamp: dispositionAt + 1,
            };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const sourceMessage = durableStore.append(
        canonicalTestMessageInput({
          userId: 'u1',
          catId: 'sonnet',
          content: 'terminal A2A carrier body must not be replayed',
          mentions: ['opus'],
          timestamp: 100,
          threadId: 't1',
          deliveryStatus: 'queued',
          extra: {
            crossPost: {
              sourceThreadId: 'thread-source',
              sourceInvocationId: 'parent-source',
              effectClass: 'coordinate',
            },
          },
        }),
      );
      const entry = enqueueEntry(durableDeps.queue, {
        kind: 'message_wake',
        source: 'agent',
        sourceCategory: 'a2a',
        targetCats: ['opus'],
        autoExecute: true,
        callerCatId: 'sonnet',
        a2aParentInvocationId: 'parent-source',
        a2aTriggerMessageId: sourceMessage.id,
      });
      durableDeps.queue.backfillMessageId('t1', 'u1', entry.id, sourceMessage.id);
      const secondarySource = durableStore.append(
        canonicalTestMessageInput({
          userId: 'u1',
          catId: 'sonnet',
          content: 'coalesced A2A body also must not be replayed',
          mentions: ['opus'],
          timestamp: 101,
          threadId: 't1',
          deliveryStatus: 'queued',
        }),
      );
      secondarySourceMessageId = secondarySource.id;
      assert.equal(
        durableDeps.queue.coalesceContentIntoQueuedAgent(
          't1',
          'u1',
          entry.id,
          secondarySource.content,
          secondarySource.id,
          'sonnet',
          'parent-source',
        ),
        true,
      );
      const persistedEntry = durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id);
      durableStore.initializeQueueCustody(
        sourceMessage.id,
        createInitialCrossThreadQueuedMessageCustody(sourceMessage.id, [persistedEntry]),
      );
      durableStore.initializeQueueCustody(
        secondarySource.id,
        createInitialCrossThreadQueuedMessageCustody(secondarySource.id, [persistedEntry]),
      );

      const started = await durableProcessor.processNext('t1', 'u1');
      assert.equal(started.started, true);
      await waitFor(() => durableStore.getById(sourceMessage.id)?.queueCustody?.status === 'terminal');
      await waitFor(() => durableStore.getById(secondarySource.id)?.queueCustody?.status === 'terminal');

      assert.equal(routeCalls.length, 1, 'Agent Client continuation must not become a second Queue/Run');
      assert.equal(
        continuationCoordinator.resolveSessionStrategy.mock.calls.length,
        0,
        'session continuation stays inside Agent Client and is not re-routed by QueueProcessor',
      );
      assert.deepEqual(durableStore.getById(sourceMessage.id).queueCustody.targetOutcomeByCatId.opus.consumption, {
        kind: 'dispatch_handled_continuation',
        sourceMessageId: sourceMessage.id,
        dispositionEventId: `dispatch-disposition:child-dispatch-handled:${sourceMessage.id}`,
        dispositionAt,
      });
      assert.equal(
        durableStore.getById(secondarySource.id).queueCustody.targetOutcomeByCatId.opus.consumption,
        undefined,
        'the typed witness must remain attached only to its exact source message',
      );
    });

    it('persists exact child awakening before the cross-thread body is exposed', async () => {
      const durableStore = new MessageStore();
      let releaseExposure;
      const exposureGate = new Promise((resolve) => {
        releaseExposure = resolve;
      });
      const awakenedAt = 1_755;
      const seenAt = 1_765;
      const durableDeps = stubDeps({
        messageStore: durableStore,
        router: {
          routeExecution: mock.fn(async function* (...args) {
            yield {
              type: 'system_info',
              catId: 'opus',
              // Lifecycle truth must travel in typed fields. The display body
              // is deliberately opaque so QueueProcessor cannot infer
              // awakening by parsing user-visible/system prose.
              content: 'child execution started',
              turnInvocationId: 'child-awakened-before-read',
              turnExecutionStartedAt: awakenedAt,
              extra: {
                turnExecution: {
                  invocationId: 'child-awakened-before-read',
                  parentInvocationId: 'parent-queue',
                  executionKind: 'ordinary',
                },
              },
              timestamp: awakenedAt,
            };
            await exposureGate;
            await args[6].onPromptMessagesExposed({
              threadId: 't1',
              userId: 'u1',
              catId: 'opus',
              invocationId: 'child-awakened-before-read',
              messageIds: [args[3]],
              seenAt,
            });
            yield {
              type: 'done',
              catId: 'opus',
              invocationId: 'child-awakened-before-read',
              timestamp: seenAt + 10,
            };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const sourceMessage = durableStore.append(
        canonicalTestMessageInput({
          userId: 'u1',
          catId: 'sonnet',
          content: 'terminal release',
          mentions: ['opus'],
          timestamp: 100,
          threadId: 't1',
          deliveryStatus: 'queued',
        }),
      );
      const entry = enqueueEntry(durableDeps.queue, {
        kind: 'message_wake',
        source: 'agent',
        sourceCategory: 'a2a',
        targetCats: ['opus'],
        autoExecute: true,
        callerCatId: 'sonnet',
        a2aParentInvocationId: 'parent-source',
        a2aTriggerMessageId: sourceMessage.id,
      });
      durableDeps.queue.backfillMessageId('t1', 'u1', entry.id, sourceMessage.id);
      const persistedEntry = durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id);
      durableStore.initializeQueueCustody(
        sourceMessage.id,
        createInitialCrossThreadQueuedMessageCustody(sourceMessage.id, [persistedEntry]),
      );

      const started = await durableProcessor.processNext('t1', 'u1');
      assert.equal(started.started, true);
      await waitFor(
        () =>
          durableStore.getById(sourceMessage.id)?.queueCustody?.awakenedInvocationIdByCatId?.opus ===
          'child-awakened-before-read',
      );

      const awakened = durableStore.getById(sourceMessage.id);
      assert.equal(awakened.deliveryStatus, 'queued');
      assert.equal(awakened.queueCustody.bodyExposures, undefined);
      const [awakenedTarget] = projectQueueReceipt(awakened.queueCustody).targets;
      assert.equal(awakenedTarget.catId, 'opus');
      assert.equal(awakenedTarget.state, 'awakened');
      assert.equal(awakenedTarget.invocationId, 'child-awakened-before-read');
      assert.equal(awakenedTarget.awakenedAt, awakenedAt);
      assert.deepEqual(
        awakenedTarget.attempts?.map(({ targetCatId, sequence, state }) => ({ targetCatId, sequence, state })),
        [{ targetCatId: 'opus', sequence: 1, state: 'queued' }],
      );

      releaseExposure();
      await waitFor(() => durableStore.getById(sourceMessage.id)?.queueCustody?.status === 'terminal');
      const terminal = durableStore.getById(sourceMessage.id);
      assert.deepEqual(terminal.queueCustody.bodyExposures, [
        { targetCatId: 'opus', invocationId: 'child-awakened-before-read', seenAt },
      ]);
      assert.equal(terminal.queueCustody.awakenedInvocationIdByCatId, undefined);
      assert.equal(terminal.queueCustody.awakenedAtByCatId, undefined);
    });

    it('keeps one cross-thread message while independent target carriers settle exact receipts', async () => {
      const durableStore = new MessageStore();
      const seenAtByCat = { opus: 1_760, codex: 1_770 };
      let releaseCodex;
      const codexGate = new Promise((resolve) => {
        releaseCodex = resolve;
      });
      let markCodexStarted;
      const codexStarted = new Promise((resolve) => {
        markCodexStarted = resolve;
      });
      const durableDeps = stubDeps({
        messageStore: durableStore,
        router: {
          routeExecution: mock.fn(async function* (...args) {
            const catId = args[4][0];
            const childInvocationId = `child-${catId}`;
            await args[6].onPromptMessagesExposed({
              threadId: 't1',
              userId: 'u1',
              catId,
              invocationId: childInvocationId,
              messageIds: [args[3]],
              seenAt: seenAtByCat[catId],
            });
            if (catId === 'codex') {
              markCodexStarted();
              await codexGate;
            }
            yield {
              type: 'done',
              catId,
              invocationId: childInvocationId,
              ...(catId === 'opus'
                ? {
                    turnCustodyTerminalWitness: {
                      kind: 'terminal_silent',
                      projectionState: 'covered_empty',
                      wake: 'coordination_terminal',
                    },
                  }
                : {}),
              timestamp: Date.now(),
            };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const sourceMessage = durableStore.append(
        canonicalTestMessageInput({
          userId: 'u1',
          catId: 'sonnet',
          content: 'terminal release',
          mentions: ['opus', 'codex'],
          timestamp: 100,
          threadId: 't1',
          deliveryStatus: 'queued',
          extra: {
            crossPost: {
              sourceThreadId: 'thread-source',
              sourceInvocationId: 'parent-source',
              effectClass: 'coordinate',
            },
          },
        }),
      );
      const entries = ['opus', 'codex'].map((catId) => {
        const entry = enqueueEntry(durableDeps.queue, {
          kind: 'message_wake',
          source: 'agent',
          sourceCategory: 'a2a',
          targetCats: [catId],
          autoExecute: true,
          callerCatId: 'sonnet',
          a2aParentInvocationId: 'parent-source',
          a2aTriggerMessageId: sourceMessage.id,
        });
        durableDeps.queue.backfillMessageId('t1', 'u1', entry.id, sourceMessage.id);
        return durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id);
      });
      durableStore.initializeQueueCustody(
        sourceMessage.id,
        createInitialCrossThreadQueuedMessageCustody(sourceMessage.id, entries),
      );

      const firstStarted = await durableProcessor.processNext('t1', 'u1');
      assert.equal(firstStarted.started, true);
      await waitFor(() => durableStore.getById(sourceMessage.id)?.queueCustody?.handledByCatIds.includes('opus'));
      await codexStarted;

      const afterFirst = durableStore.getById(sourceMessage.id);
      assert.equal(afterFirst.deliveryStatus, 'queued');
      assert.deepEqual(afterFirst.queueCustody.pendingTargetCats, ['codex']);
      assert.deepEqual(afterFirst.queueCustody.handledByCatIds, ['opus']);
      assert.deepEqual(afterFirst.queueCustody.targetOutcomeByCatId.opus.consumption, {
        kind: 'terminal_silent',
        projectionState: 'covered_empty',
        wake: 'coordination_terminal',
      });
      assert.deepEqual(Object.keys(afterFirst.queueCustody.carrierStateByTargetCatId), ['codex']);

      releaseCodex();
      await waitFor(() => durableStore.getById(sourceMessage.id)?.queueCustody?.status === 'terminal');

      const terminal = durableStore.getById(sourceMessage.id);
      assert.equal(terminal.queueCustody.status, 'terminal');
      assert.equal(
        terminal.deliveryStatus,
        'delivered',
        'terminal custody closes the delivery field without republishing already-visible cat speech',
      );
      assert.deepEqual(terminal.queueCustody.pendingTargetCats, []);
      assert.deepEqual(terminal.queueCustody.handledByCatIds, ['opus', 'codex']);
      assert.equal(terminal.queueCustody.carrierStateByTargetCatId, undefined);
      assert.equal(terminal.queueCustody.targetOutcomeByCatId.codex.consumption, undefined);
      const deliveredEvents = durableDeps.socketManager.emitToUser.mock.calls.filter(
        (call) => call.arguments[1] === 'messages_delivered',
      );
      assert.equal(
        deliveredEvents.length,
        0,
        'already-public cat speech must not be announced as a newly delivered user input',
      );
      const textEvents = durableDeps.socketManager.broadcastAgentMessage.mock.calls.filter(
        (call) => call.arguments[0].type === 'text',
      );
      assert.deepEqual(textEvents, [], 'terminal clean-stop must not fabricate a cat reply bubble');
    });

    it('uses the ordinary child that read the body when a routing guard owns the terminal event', async () => {
      const durableStore = new MessageStore();
      const seenAt = 1_800;
      const durableDeps = stubDeps({
        messageStore: durableStore,
        router: {
          routeExecution: mock.fn(async function* (...args) {
            await args[6].onPromptMessagesExposed({
              threadId: 't1',
              userId: 'u1',
              catId: 'opus',
              invocationId: 'child-ordinary-read',
              messageIds: [args[3]],
              seenAt,
            });
            yield {
              type: 'done',
              catId: 'opus',
              invocationId: 'child-ordinary-read',
              timestamp: Date.now(),
            };
            yield {
              type: 'done',
              catId: 'opus',
              invocationId: 'child-routing-guard',
              timestamp: Date.now(),
            };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const { message } = enqueueCustodiedEntry(durableDeps.queue, durableStore);

      const started = await durableProcessor.processNext('t1', 'u1');
      assert.equal(started.started, true);
      await waitFor(() => durableStore.getById(message.id)?.queueCustody?.status === 'terminal');

      assert.equal(durableDeps.router.routeExecution.mock.calls.length, 1);
      assert.equal(durableDeps.queue.list('t1', 'u1').length, 0);
      const terminal = durableStore.getById(message.id);
      assert.equal(terminal.deliveryStatus, 'delivered');
      assert.deepEqual(terminal.queueCustody.bodyExposures, [
        { targetCatId: 'opus', invocationId: 'child-ordinary-read', seenAt },
      ]);
      assert.deepEqual(terminal.queueCustody.targetOutcomeByCatId.opus, {
        invocationId: 'child-ordinary-read',
        disposition: 'completed_with_turn',
        evidenceRef: { kind: 'turn_execution', invocationId: 'child-ordinary-read' },
        handledAt: terminal.queueCustody.targetOutcomeByCatId.opus.handledAt,
      });
      assert.ok(terminal.deliveredAt <= terminal.queueCustody.targetOutcomeByCatId.opus.handledAt);
    });

    it('resolves a direct parent completion to the succeeded exact child that read the Queue body', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({
        messageStore: durableStore,
        turnExecutionStore: {
          get: mock.fn(async (invocationId) =>
            invocationId === 'child-direct-read'
              ? {
                  invocationId,
                  parentInvocationId: 'parent-direct',
                  threadId: 't1',
                  userId: 'u1',
                  catId: 'opus',
                  executionKind: 'ordinary',
                  startedAt: 1_900,
                  status: 'succeeded',
                  endedAt: 2_000,
                }
              : null,
          ),
        },
      });
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const { entry, message } = enqueueCustodiedEntry(durableDeps.queue, durableStore);
      durableDeps.queue.markQueuedSeen('t1', 'u1', entry.id, 'opus', 'child-direct-read', 1_950);
      await durableDeps.queueCustodyCoordinator.persistEntry(durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id));

      await durableProcessor.onInvocationComplete('t1', 'opus', 'succeeded', 'parent-direct', ['opus'], false, {}, [
        entry.id,
      ]);

      assert.equal(durableDeps.queue.list('t1', 'u1').length, 0);
      const terminal = durableStore.getById(message.id);
      assert.equal(terminal.deliveryStatus, 'delivered');
      assert.equal(terminal.queueCustody.targetOutcomeByCatId.opus.invocationId, 'child-direct-read');
    });

    it('terminalizes an interrupted exact child without reviving its Queue carrier', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({
        messageStore: durableStore,
        turnExecutionStore: {
          get: mock.fn(async (invocationId) =>
            invocationId === 'child-interrupted-read'
              ? {
                  invocationId,
                  parentInvocationId: 'parent-with-guard',
                  threadId: 't1',
                  userId: 'u1',
                  catId: 'opus',
                  executionKind: 'ordinary',
                  startedAt: 2_100,
                  status: 'interrupted',
                  endedAt: 2_200,
                  terminalReason: 'provider_ended_without_terminal_done',
                }
              : null,
          ),
        },
      });
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const { entry, message } = enqueueCustodiedEntry(durableDeps.queue, durableStore, {
        source: 'connector',
        sourceCategory: 'scheduled',
        messageSource: {
          connector: 'hold-ball',
          label: '持球通知',
          meta: { taskId: 'task-interrupted', threadId: 't1', catId: 'opus', wakeWhen: true },
        },
      });
      durableDeps.queue.markQueuedSeen('t1', 'u1', entry.id, 'opus', 'child-interrupted-read', 2_150);
      await durableDeps.queueCustodyCoordinator.persistEntry(durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id));

      await durableProcessor.onInvocationComplete('t1', 'opus', 'succeeded', 'parent-with-guard', ['opus'], false, {}, [
        entry.id,
      ]);

      assert.equal(durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id), null);
      const persisted = durableStore.getById(message.id);
      assert.equal(persisted.deliveryStatus, 'delivered');
      assert.equal(persisted.queueCustody.status, 'terminal');
      assert.deepEqual(persisted.queueCustody.pendingTargetCats, []);
      assert.deepEqual(persisted.queueCustody.failedByCatIds, ['opus']);
      assert.deepEqual(persisted.queueCustody.bodyExposures, [
        { targetCatId: 'opus', invocationId: 'child-interrupted-read', seenAt: 2_150 },
      ]);
      assert.equal(persisted.queueCustody.targetOutcomeByCatId, undefined);
      assert.equal(durableDeps.router.routeExecution.mock.calls.length, 0);
    });

    it('terminalizes an exact child failure even when the direct caller reports no completed cats', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({
        messageStore: durableStore,
        turnExecutionStore: {
          get: mock.fn(async (invocationId) =>
            invocationId === 'child-direct-failed'
              ? {
                  invocationId,
                  parentInvocationId: 'parent-direct-failed',
                  threadId: 't1',
                  userId: 'u1',
                  catId: 'opus',
                  executionKind: 'ordinary',
                  startedAt: 2_300,
                  status: 'failed',
                  endedAt: 2_400,
                  terminalReason: 'provider_failure',
                }
              : null,
          ),
        },
      });
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const { entry, message } = enqueueCustodiedEntry(durableDeps.queue, durableStore, {
        source: 'connector',
        sourceCategory: 'scheduled',
        messageSource: {
          connector: 'hold-ball',
          label: '持球通知',
          meta: { taskId: 'task-failed', threadId: 't1', catId: 'opus', wakeWhen: true },
        },
      });
      durableDeps.queue.markQueuedSeen('t1', 'u1', entry.id, 'opus', 'child-direct-failed', 2_350);
      await durableDeps.queueCustodyCoordinator.persistEntry(durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id));

      await durableProcessor.onInvocationComplete('t1', 'opus', 'failed', 'parent-direct-failed', [], true, {}, [
        entry.id,
      ]);

      assert.equal(durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id), null);
      const persisted = durableStore.getById(message.id);
      assert.equal(persisted.deliveryStatus, 'delivered');
      assert.equal(persisted.queueCustody.status, 'terminal');
      assert.deepEqual(persisted.queueCustody.pendingTargetCats, []);
      assert.deepEqual(persisted.queueCustody.failedByCatIds, ['opus']);
      assert.deepEqual(persisted.queueCustody.bodyExposures, [
        { targetCatId: 'opus', invocationId: 'child-direct-failed', seenAt: 2_350 },
      ]);
      assert.equal(persisted.queueCustody.targetOutcomeByCatId, undefined);
    });

    it('terminalizes a canceled managed-hold child without reviving its Queue carrier', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({ messageStore: durableStore });
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const { entry, message } = enqueueCustodiedEntry(durableDeps.queue, durableStore, {
        source: 'connector',
        sourceCategory: 'scheduled',
        messageSource: {
          connector: 'hold-ball',
          label: '持球通知',
          meta: { taskId: 'task-canceled', threadId: 't1', catId: 'opus', wakeWhen: true },
        },
      });
      durableDeps.queue.markQueuedSeen('t1', 'u1', entry.id, 'opus', 'child-canceled', 2_450);
      await durableDeps.queueCustodyCoordinator.persistEntry(durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id));

      await durableProcessor.onInvocationComplete(
        't1',
        'opus',
        'canceled',
        'parent-canceled',
        [],
        true,
        { opus: 'child-canceled' },
        [entry.id],
      );

      const queued = durableDeps.queue.list('t1', 'u1');
      assert.equal(queued.length, 0);
      const persisted = durableStore.getById(message.id);
      assert.equal(persisted.deliveryStatus, 'delivered');
      assert.equal(persisted.queueCustody.status, 'terminal');
      assert.deepEqual(persisted.queueCustody.pendingTargetCats, []);
      assert.deepEqual(persisted.queueCustody.failedByCatIds, ['opus']);
      assert.deepEqual(persisted.queueCustody.handledByCatIds, []);
      assert.equal(persisted.queueCustody.targetOutcomeByCatId, undefined);
      assert.equal(projectQueueReceipt(persisted.queueCustody).targets[0].state, 'cancelled');
    });

    it('terminalizes succeeded and failed siblings without leaving the failed target in Queue', async () => {
      const durableStore = new MessageStore();
      const records = new Map([
        [
          'child-opus-succeeded',
          {
            invocationId: 'child-opus-succeeded',
            parentInvocationId: 'parent-multi',
            threadId: 't1',
            userId: 'u1',
            catId: 'opus',
            executionKind: 'ordinary',
            startedAt: 2_500,
            status: 'succeeded',
            endedAt: 2_600,
          },
        ],
        [
          'child-codex-failed',
          {
            invocationId: 'child-codex-failed',
            parentInvocationId: 'parent-multi',
            threadId: 't1',
            userId: 'u1',
            catId: 'codex',
            executionKind: 'ordinary',
            startedAt: 2_500,
            status: 'failed',
            endedAt: 2_600,
            terminalReason: 'provider_failure',
          },
        ],
      ]);
      const durableDeps = stubDeps({
        messageStore: durableStore,
        turnExecutionStore: { get: mock.fn(async (invocationId) => records.get(invocationId) ?? null) },
      });
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const { entry, message } = enqueueCustodiedEntry(durableDeps.queue, durableStore, {
        targetCats: ['opus', 'codex'],
      });
      durableDeps.queue.markQueuedSeen('t1', 'u1', entry.id, 'opus', 'child-opus-succeeded', 2_550);
      durableDeps.queue.markQueuedSeen('t1', 'u1', entry.id, 'codex', 'child-codex-failed', 2_560);
      await durableDeps.queueCustodyCoordinator.persistEntry(durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id));

      await durableProcessor.onInvocationComplete('t1', 'opus', 'succeeded', 'parent-multi', ['opus'], false, {}, [
        entry.id,
      ]);

      assert.equal(durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id), null);
      const persisted = durableStore.getById(message.id);
      assert.equal(persisted.deliveryStatus, 'delivered');
      assert.equal(persisted.queueCustody.status, 'terminal');
      assert.deepEqual(persisted.queueCustody.pendingTargetCats, []);
      assert.deepEqual(persisted.queueCustody.handledByCatIds, ['opus']);
      assert.deepEqual(persisted.queueCustody.failedByCatIds, ['codex']);
      assert.equal(persisted.queueCustody.targetOutcomeByCatId.opus.invocationId, 'child-opus-succeeded');
      assert.equal(persisted.queueCustody.targetOutcomeByCatId.codex, undefined);
      assert.equal(durableDeps.router.routeExecution.mock.calls.length, 0);
    });

    it('trusts exact child truth when the parent aggregate fails', async () => {
      const durableStore = new MessageStore();
      const records = new Map([
        [
          'child-opus-succeeded',
          {
            invocationId: 'child-opus-succeeded',
            parentInvocationId: 'parent-multi-failed',
            threadId: 't1',
            userId: 'u1',
            catId: 'opus',
            executionKind: 'ordinary',
            startedAt: 2_500,
            status: 'succeeded',
            endedAt: 2_600,
          },
        ],
        [
          'child-codex-failed',
          {
            invocationId: 'child-codex-failed',
            parentInvocationId: 'parent-multi-failed',
            threadId: 't1',
            userId: 'u1',
            catId: 'codex',
            executionKind: 'ordinary',
            startedAt: 2_500,
            status: 'failed',
            endedAt: 2_600,
            terminalReason: 'provider_failure',
          },
        ],
      ]);
      const durableDeps = stubDeps({
        messageStore: durableStore,
        turnExecutionStore: { get: mock.fn(async (invocationId) => records.get(invocationId) ?? null) },
      });
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const { entry, message } = enqueueCustodiedEntry(durableDeps.queue, durableStore, {
        targetCats: ['opus', 'codex'],
      });
      durableDeps.queue.markQueuedSeen('t1', 'u1', entry.id, 'opus', 'child-opus-succeeded', 2_550);
      durableDeps.queue.markQueuedSeen('t1', 'u1', entry.id, 'codex', 'child-codex-failed', 2_560);
      await durableDeps.queueCustodyCoordinator.persistEntry(durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id));

      await durableProcessor.onInvocationComplete(
        't1',
        'opus',
        'failed',
        'parent-multi-failed',
        ['opus'],
        false,
        { opus: 'child-opus-succeeded', codex: 'child-codex-failed' },
        [entry.id],
        {
          'child-opus-succeeded': [{ kind: 'source_response', outputMessageIds: ['output-opus'] }],
        },
      );

      assert.equal(durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id), null);
      const persisted = durableStore.getById(message.id);
      assert.equal(persisted.deliveryStatus, 'delivered');
      assert.equal(persisted.queueCustody.status, 'terminal');
      assert.deepEqual(persisted.queueCustody.pendingTargetCats, []);
      assert.deepEqual(persisted.queueCustody.handledByCatIds, ['opus']);
      assert.deepEqual(persisted.queueCustody.failedByCatIds, ['codex']);
      assert.deepEqual(persisted.queueCustody.targetOutcomeByCatId.opus.consumption, {
        kind: 'source_response',
        outputMessageIds: ['output-opus'],
      });
      assert.equal(persisted.queueCustody.targetOutcomeByCatId.codex, undefined);
      assert.equal(durableDeps.router.routeExecution.mock.calls.length, 0);
    });

    it('passes primary and F175 batch message identities through the route exposure boundary', async () => {
      let routedOptions;
      const batchStore = new MessageStore();
      const batchDeps = stubDeps({
        messageStore: batchStore,
        router: {
          routeExecution: mock.fn(async function* (...args) {
            routedOptions = args[6];
            await routedOptions.onPromptMessagesExposed({
              threadId: 't1',
              userId: 'u1',
              catId: 'opus',
              invocationId: 'child-batch-exposure',
              messageIds: routedOptions.persistedPromptMessageIds,
              seenAt: Date.now(),
            });
            yield {
              type: 'done',
              catId: 'opus',
              invocationId: 'child-batch-exposure',
              timestamp: Date.now(),
            };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const batchProcessor = new QueueProcessor(batchDeps);
      batchDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: batchStore });
      const entries = ['primary', 'batched-a', 'batched-b'].map((content) => {
        const { entry } = enqueueCustodiedEntry(batchDeps.queue, batchStore, { content });
        return batchDeps.queue.getEntrySnapshot('t1', 'u1', entry.id);
      });

      const started = await batchProcessor.processNext('t1', 'u1');
      assert.equal(
        started.started,
        true,
        batchDeps.log.error.mock.calls
          .map((call) => call.arguments[0]?.err?.stack ?? call.arguments[0]?.err?.message ?? String(call.arguments[1]))
          .join('\n'),
      );
      await waitFor(() => routedOptions !== undefined).catch((error) => {
        assert.fail(
          `${error.message}\nqueue=${JSON.stringify(batchDeps.queue.list('t1', 'u1'))}\nmessages=${JSON.stringify(entries.map((entry) => batchStore.getById(entry.messageId)))}\n${batchDeps.log.error.mock.calls
            .map(
              (call) => call.arguments[0]?.err?.stack ?? call.arguments[0]?.err?.message ?? String(call.arguments[1]),
            )
            .join('\n')}`,
        );
      });

      assert.deepEqual(
        new Set(routedOptions.persistedPromptMessageIds),
        new Set(entries.map((entry) => entry.messageId)),
      );
      assert.deepEqual(
        routedOptions.persistedPromptMessages.map(({ messageId, content }) => ({ messageId, content })),
        entries.map((entry) => ({ messageId: entry.messageId, content: entry.content })),
      );
      await waitFor(() =>
        entries.every((entry) => batchStore.getById(entry.messageId)?.queueCustody?.status === 'terminal'),
      ).catch((error) => {
        assert.fail(
          `${error.message}\n${batchDeps.log.error.mock.calls
            .map(
              (call) => call.arguments[0]?.err?.stack ?? call.arguments[0]?.err?.message ?? String(call.arguments[1]),
            )
            .join('\n')}`,
        );
      });
    });

    it('terminalizes a succeeded provider contract that never bound exact body exposure', async () => {
      const durableStore = new MessageStore();
      let routeCalls = 0;
      const missingExposureDeps = stubDeps({
        messageStore: durableStore,
        router: {
          routeExecution: mock.fn(async function* () {
            routeCalls += 1;
            if (routeCalls > 1) throw new Error('unexpected immediate retry');
            yield {
              type: 'done',
              catId: 'opus',
              invocationId: 'child-without-exposure',
              timestamp: Date.now(),
            };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      missingExposureDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({
        messageStore: durableStore,
      });
      const missingExposureProcessor = new QueueProcessor(missingExposureDeps);
      const { message } = enqueueCustodiedEntry(missingExposureDeps.queue, durableStore);

      await missingExposureProcessor.processNext('t1', 'u1');
      await waitFor(() => durableStore.getById(message.id)?.queueCustody?.status === 'terminal');

      assert.equal(routeCalls, 1, 'missing exposure must not start a same-attempt retry loop');
      assert.equal(missingExposureDeps.queue.list('t1', 'u1').length, 0);
      assert.deepEqual(durableStore.getById(message.id).queueCustody.failedByCatIds, ['opus']);
    });

    it('marks responded only when the successful invocation has an exact replyTo link', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({ messageStore: durableStore });
      const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      durableDeps.queueCustodyCoordinator = coordinator;
      const durableProcessor = new QueueProcessor(durableDeps);
      const { entry, message } = enqueueCustodiedEntry(durableDeps.queue, durableStore);
      assert.equal(durableDeps.queue.markQueuedSeen('t1', 'u1', entry.id, 'opus', 'inv-reply'), true);
      const seen = durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id);
      await coordinator.persistEntry(seen);
      durableStore.append(
        canonicalTestMessageInput({
          userId: 'u1',
          threadId: 't1',
          catId: 'opus',
          content: 'explicitly addressed response',
          mentions: [],
          timestamp: Date.now(),
          replyTo: message.id,
          extra: { stream: { invocationId: 'inv-reply', turnInvocationId: 'inv-reply' } },
        }),
      );

      await durableProcessor.onInvocationComplete('t1', 'opus', 'succeeded', 'inv-reply', ['opus']);

      assert.equal(durableStore.getById(message.id).queueCustody.targetOutcomeByCatId.opus.disposition, 'responded');
    });

    it('settles an exact source response even when the reading child later cancels', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({ messageStore: durableStore });
      const { entry, message } = enqueueCustodiedEntry(durableDeps.queue, durableStore);
      const seenAt = entry.createdAt + 100;
      const settledAt = entry.createdAt + 300;
      const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore, now: () => settledAt });
      durableDeps.queueCustodyCoordinator = coordinator;
      const durableProcessor = new QueueProcessor(durableDeps);
      const childInvocationId = 'child-response-then-cancel';
      assert.equal(durableDeps.queue.markQueuedSeen('t1', 'u1', entry.id, 'opus', childInvocationId, seenAt), true);
      await coordinator.persistEntry(durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id));
      const response = durableStore.append(
        canonicalTestMessageInput({
          userId: 'u1',
          threadId: 't1',
          catId: 'opus',
          content: 'durable review verdict',
          mentions: [],
          timestamp: entry.createdAt + 200,
          replyTo: message.id,
          extra: {
            stream: { invocationId: 'parent-response-then-cancel', turnInvocationId: childInvocationId },
          },
        }),
      );

      await durableProcessor.onInvocationComplete(
        't1',
        'opus',
        'canceled_by_user',
        'parent-response-then-cancel',
        ['opus'],
        true,
        { opus: childInvocationId },
        [entry.id],
      );

      const settled = durableStore.getById(message.id);
      assert.equal(settled.deliveryStatus, 'delivered');
      assert.equal(settled.queueCustody.status, 'terminal');
      const outcome = settled.queueCustody.targetOutcomeByCatId.opus;
      assert.ok(outcome.handledAt > seenAt);
      assert.deepEqual(
        { ...outcome, handledAt: settledAt },
        {
          invocationId: childInvocationId,
          disposition: 'responded',
          evidenceRef: { kind: 'invocation_lineage', invocationId: childInvocationId },
          handledAt: settledAt,
          consumption: {
            kind: 'source_response',
            outputMessageIds: [response.id],
          },
        },
      );
      assert.deepEqual(durableDeps.queue.list('t1', 'u1'), []);
    });

    it('settles a detached scheduler source from a default-user response when the child fails', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({ messageStore: durableStore });
      const { entry, message } = enqueueCustodiedEntry(durableDeps.queue, durableStore, {
        userId: 'default-user',
        messageUserId: 'scheduler',
        messageSource: { connector: 'hold-ball' },
      });
      const childInvocationId = 'child-scheduler-response-then-fail';
      const seenAt = entry.createdAt + 100;
      const settledAt = entry.createdAt + 300;
      const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore, now: () => settledAt });
      durableDeps.queueCustodyCoordinator = coordinator;
      assert.equal(
        durableDeps.queue.markQueuedSeen('t1', 'default-user', entry.id, 'opus', childInvocationId, seenAt),
        true,
      );
      const exposedEntry = durableDeps.queue.getEntrySnapshot('t1', 'default-user', entry.id);
      await coordinator.persistEntry(exposedEntry);
      assert.equal(durableDeps.queue.removeEntrySnapshotIfUnchanged(exposedEntry), true);
      const response = durableStore.append(
        canonicalTestMessageInput({
          userId: 'default-user',
          threadId: 't1',
          catId: 'opus',
          content: 'durable response from the triggering user turn',
          mentions: [],
          timestamp: entry.createdAt + 200,
          replyTo: message.id,
          extra: {
            stream: { invocationId: 'parent-scheduler-response-then-fail', turnInvocationId: childInvocationId },
          },
        }),
      );

      await new QueueProcessor(durableDeps).onInvocationComplete(
        't1',
        'opus',
        'failed',
        'parent-scheduler-response-then-fail',
        ['opus'],
        true,
        { opus: childInvocationId },
        [entry.id],
      );

      const settled = durableStore.getById(message.id);
      assert.equal(settled.deliveryStatus, 'delivered');
      assert.equal(settled.queueCustody.status, 'terminal');
      assert.equal(settled.queueCustody.targetOutcomeByCatId.opus.disposition, 'responded');
      assert.deepEqual(settled.queueCustody.targetOutcomeByCatId.opus.consumption, {
        kind: 'source_response',
        outputMessageIds: [response.id],
      });
    });

    it('settles the exact child after exposed true recall removed its Queue carrier', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({ messageStore: durableStore });
      const { entry, message } = enqueueCustodiedEntry(durableDeps.queue, durableStore);
      const childInvocationId = 'child-success-after-recall';
      const seenAt = entry.createdAt + 100;
      const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore, now: () => seenAt + 300 });
      durableDeps.queueCustodyCoordinator = coordinator;
      const durableProcessor = new QueueProcessor(durableDeps);
      assert.equal(durableDeps.queue.markQueuedSeen('t1', 'u1', entry.id, 'opus', childInvocationId, seenAt), true);
      const exposedEntry = durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id);
      await coordinator.persistEntry(exposedEntry);
      assert.equal(durableDeps.queue.removeEntrySnapshotIfUnchanged(exposedEntry), true);
      const recalled = durableStore.recallMessageToComposerDraft(message.id, {
        ownerUserId: 'u1',
        threadId: 't1',
        expectedDraftRevision: 0,
        merge: 'replace',
        recalledAt: seenAt + 200,
      });
      assert.equal(recalled.kind, 'recalled');
      assert.equal(recalled.verdict, 'exposed');

      await durableProcessor.onInvocationComplete(
        't1',
        'opus',
        'succeeded',
        'parent-success-after-recall',
        ['opus'],
        false,
        { opus: childInvocationId },
      );

      const settled = durableStore.getById(message.id);
      assert.equal(settled.content, '');
      assert.equal(settled.deliveryStatus, 'canceled');
      assert.equal(settled.recall.exposure, 'seen');
      assert.deepEqual(settled.queueCustody.handledByCatIds, ['opus']);
      assert.deepEqual(settled.queueCustody.withdrawnByCatIds ?? [], []);
      assert.equal(settled.queueCustody.targetOutcomeByCatId.opus.invocationId, childInvocationId);
      assert.equal(settled.queueCustody.targetOutcomeByCatId.opus.disposition, 'completed_with_turn');
      assert.deepEqual(settled.queueCustody.targetOutcomeByCatId.opus.evidenceRef, {
        kind: 'turn_execution',
        invocationId: childInvocationId,
      });
      const receiptEvent = durableDeps.socketManager.broadcastToRoom.mock.calls.find(
        (call) => call.arguments[1] === 'message_receipt_updated',
      );
      assert.deepEqual(receiptEvent?.arguments, [
        'thread:t1',
        'message_receipt_updated',
        { threadId: 't1', messageId: message.id },
      ]);
    });

    it('settles an exposed recalled source through the durable exposure index when visibility no longer lists it', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({ messageStore: durableStore });
      const { entry, message } = enqueueCustodiedEntry(durableDeps.queue, durableStore);
      const childInvocationId = 'child-hidden-after-recall';
      const seenAt = entry.createdAt + 100;
      const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore, now: () => seenAt + 300 });
      durableDeps.queueCustodyCoordinator = coordinator;
      assert.equal(durableDeps.queue.markQueuedSeen('t1', 'u1', entry.id, 'opus', childInvocationId, seenAt), true);
      const exposedEntry = durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id);
      await coordinator.persistEntry(exposedEntry);
      assert.equal(durableDeps.queue.removeEntrySnapshotIfUnchanged(exposedEntry), true);
      assert.equal(
        durableStore.recallMessageToComposerDraft(message.id, {
          ownerUserId: 'u1',
          threadId: 't1',
          expectedDraftRevision: 0,
          merge: 'replace',
          recalledAt: seenAt + 200,
        }).kind,
        'recalled',
      );
      durableStore.getByThreadAfter = async () => [];
      durableStore.getByQueueExposure = async (threadId, targetCatId, invocationId) => {
        assert.equal(threadId, 't1');
        assert.equal(targetCatId, 'opus');
        assert.equal(invocationId, childInvocationId);
        return [durableStore.getById(message.id)];
      };

      await new QueueProcessor(durableDeps).onInvocationComplete(
        't1',
        'opus',
        'succeeded',
        'parent-hidden-after-recall',
        ['opus'],
        false,
        { opus: childInvocationId },
      );

      const settled = durableStore.getById(message.id);
      assert.deepEqual(settled.queueCustody.handledByCatIds, ['opus']);
      assert.equal(settled.queueCustody.targetOutcomeByCatId.opus.invocationId, childInvocationId);
    });

    it('retains an exact response witness when an exposed recalled child later cancels', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({ messageStore: durableStore });
      const { entry, message } = enqueueCustodiedEntry(durableDeps.queue, durableStore);
      const childInvocationId = 'child-response-after-recall';
      const seenAt = entry.createdAt + 100;
      const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore, now: () => seenAt + 400 });
      durableDeps.queueCustodyCoordinator = coordinator;
      assert.equal(durableDeps.queue.markQueuedSeen('t1', 'u1', entry.id, 'opus', childInvocationId, seenAt), true);
      const exposedEntry = durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id);
      await coordinator.persistEntry(exposedEntry);
      assert.equal(durableDeps.queue.removeEntrySnapshotIfUnchanged(exposedEntry), true);
      assert.equal(
        durableStore.recallMessageToComposerDraft(message.id, {
          ownerUserId: 'u1',
          threadId: 't1',
          expectedDraftRevision: 0,
          merge: 'replace',
          recalledAt: seenAt + 200,
        }).kind,
        'recalled',
      );
      const response = durableStore.append(
        canonicalTestMessageInput({
          userId: 'u1',
          threadId: 't1',
          catId: 'opus',
          content: 'exact response survived recall',
          mentions: [],
          timestamp: seenAt + 300,
          replyTo: message.id,
          extra: { stream: { invocationId: 'parent-response-after-recall', turnInvocationId: childInvocationId } },
        }),
      );

      await new QueueProcessor(durableDeps).onInvocationComplete(
        't1',
        'opus',
        'canceled',
        'parent-response-after-recall',
        ['opus'],
        false,
        { opus: childInvocationId },
      );

      const settled = durableStore.getById(message.id);
      assert.equal(settled.content, '');
      assert.equal(settled.deliveryStatus, 'canceled');
      assert.equal(settled.queueCustody.targetOutcomeByCatId.opus.disposition, 'responded');
      assert.deepEqual(settled.queueCustody.targetOutcomeByCatId.opus.consumption, {
        kind: 'source_response',
        outputMessageIds: [response.id],
      });
    });

    it('terminalizes cancellation without mistaking unbound output or tool activity for success', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({ messageStore: durableStore });
      const { entry, message } = enqueueCustodiedEntry(durableDeps.queue, durableStore);
      const childInvocationId = 'child-ambiguous-output-then-cancel';
      const seenAt = entry.createdAt + 100;
      assert.equal(durableDeps.queue.markQueuedSeen('t1', 'u1', entry.id, 'opus', childInvocationId, seenAt), true);
      const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      durableDeps.queueCustodyCoordinator = coordinator;
      await coordinator.persistEntry(durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id));
      durableStore.append(
        canonicalTestMessageInput({
          userId: 'u1',
          threadId: 't1',
          catId: 'opus',
          content: 'visible work without an exact source reference',
          mentions: [],
          timestamp: entry.createdAt + 200,
          extra: { stream: { invocationId: 'parent-ambiguous-output', turnInvocationId: childInvocationId } },
        }),
      );
      durableStore.append(
        canonicalTestMessageInput({
          userId: 'u1',
          threadId: 't1',
          catId: 'opus',
          content: '',
          mentions: [],
          timestamp: entry.createdAt + 201,
          toolEvents: [
            { id: 'tool-1', type: 'tool_result', label: 'physical action', timestamp: entry.createdAt + 201 },
          ],
          extra: {
            stream: { invocationId: 'parent-ambiguous-output', turnInvocationId: childInvocationId },
            causal: { kind: 'invocation_reply', triggerMessageId: message.id },
          },
        }),
      );

      await new QueueProcessor(durableDeps).onInvocationComplete(
        't1',
        'opus',
        'canceled',
        'parent-ambiguous-output',
        ['opus'],
        true,
        { opus: childInvocationId },
        [entry.id],
      );

      const terminal = durableStore.getById(message.id);
      assert.equal(terminal.deliveryStatus, 'delivered');
      assert.equal(terminal.queueCustody.status, 'terminal');
      assert.deepEqual(terminal.queueCustody.pendingTargetCats, []);
      assert.deepEqual(terminal.queueCustody.failedByCatIds, ['opus']);
      assert.equal(terminal.queueCustody.targetOutcomeByCatId?.opus, undefined);
      assert.equal(durableDeps.queue.list('t1', 'u1').length, 0);
    });

    it('retires the failed coalesced target while preserving an independent live target', async () => {
      const durableStore = new MessageStore();
      const queue = new InvocationQueue();
      const carrier = queue.enqueue(
        canonicalTestQueueInput({
          threadId: 't1',
          userId: 'u1',
          kind: 'message_wake',
          content: 'first handoff',
          source: 'agent',
          ownerAuthProvenance: 'unknown',
          sourceCategory: 'a2a',
          targetCats: ['opus'],
          intent: 'execute',
          autoExecute: true,
          callerCatId: 'sonnet',
          a2aParentInvocationId: 'parent-source',
          a2aTriggerMessageId: 'message-first',
        }),
      ).entry;
      const first = durableStore.append(
        canonicalTestMessageInput({
          threadId: 't1',
          userId: 'u1',
          catId: 'sonnet',
          content: 'first handoff',
          mentions: ['opus', 'codex'],
          timestamp: carrier.createdAt,
          deliveryStatus: 'queued',
        }),
      );
      queue.backfillMessageId('t1', 'u1', carrier.id, first.id);
      const liveCodexInvocationId = 'child-live-codex';
      const liveCodexStartedAt = carrier.createdAt + 25;
      const liveCodexSeenAt = carrier.createdAt + 40;
      const liveCodexCarrier = {
        ...queue.getEntrySnapshot('t1', 'u1', carrier.id),
        id: 'carrier-live-codex',
        targetCats: ['codex'],
        allTargetCats: ['codex'],
        status: 'processing',
        processingStartedAt: liveCodexStartedAt,
        queuedAwakenedInvocationIdByCatId: { codex: liveCodexInvocationId },
        queuedAwakenedAtByCatId: { codex: carrier.createdAt + 30 },
        queuedSeenByCatIds: ['codex'],
        queuedSeenInvocationIdByCatId: { codex: liveCodexInvocationId },
        queuedBodyExposures: [{ targetCatId: 'codex', invocationId: liveCodexInvocationId, seenAt: liveCodexSeenAt }],
      };
      assert.equal(
        durableStore.initializeQueueCustody(
          first.id,
          createInitialCrossThreadQueuedMessageCustody(
            first.id,
            [queue.getEntrySnapshot('t1', 'u1', carrier.id), liveCodexCarrier],
            {
              requestedTargetCats: ['opus', 'codex'],
              createdAt: first.timestamp,
            },
          ),
        ).kind,
        'initialized',
      );
      const settledAt = carrier.createdAt + 300;
      const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore, now: () => settledAt });
      await coordinator.persistEntry(liveCodexCarrier);
      const second = durableStore.append(
        canonicalTestMessageInput({
          threadId: 't1',
          userId: 'u1',
          catId: 'sonnet',
          content: 'second handoff',
          mentions: ['opus'],
          timestamp: carrier.createdAt + 1,
          deliveryStatus: 'queued',
        }),
      );
      assert.equal(
        queue.coalesceContentIntoQueuedAgent(
          't1',
          'u1',
          carrier.id,
          second.content,
          second.id,
          'sonnet',
          'parent-source',
        ),
        true,
      );
      assert.equal(
        durableStore.initializeQueueCustody(
          second.id,
          createInitialCrossThreadQueuedMessageCustody(second.id, [queue.getEntrySnapshot('t1', 'u1', carrier.id)], {
            requestedTargetCats: ['opus'],
            createdAt: second.timestamp,
          }),
        ).kind,
        'initialized',
      );
      const childInvocationId = 'child-coalesced-response-then-cancel';
      const seenAt = carrier.createdAt + 100;
      assert.equal(queue.markQueuedSeen('t1', 'u1', carrier.id, 'opus', childInvocationId, seenAt), true);
      await coordinator.persistEntry(queue.getEntrySnapshot('t1', 'u1', carrier.id));
      const response = durableStore.append(
        canonicalTestMessageInput({
          threadId: 't1',
          userId: 'u1',
          catId: 'opus',
          content: 'the second handoff is complete',
          mentions: [],
          timestamp: carrier.createdAt + 200,
          extra: {
            stream: { invocationId: 'parent-coalesced-cancel', turnInvocationId: childInvocationId },
            causal: { kind: 'invocation_reply', triggerMessageId: second.id },
          },
        }),
      );
      const durableDeps = stubDeps({ queue, messageStore: durableStore, queueCustodyCoordinator: coordinator });
      const durableProcessor = new QueueProcessor(durableDeps);

      await durableProcessor.onInvocationComplete(
        't1',
        'opus',
        'canceled',
        'parent-coalesced-cancel',
        ['opus'],
        true,
        { opus: childInvocationId },
        [carrier.id],
      );

      const firstAfter = durableStore.getById(first.id);
      const secondAfter = durableStore.getById(second.id);
      assert.equal(firstAfter.deliveryStatus, 'queued');
      assert.equal(firstAfter.queueCustody.status, 'processing');
      assert.deepEqual(firstAfter.queueCustody.pendingTargetCats, ['codex']);
      assert.deepEqual(firstAfter.queueCustody.failedByCatIds, ['opus']);
      assert.deepEqual(firstAfter.queueCustody.carrierStateByTargetCatId, {
        codex: { status: 'processing', processingStartedAt: liveCodexStartedAt },
      });
      assert.equal(firstAfter.queueCustody.seenInvocationIdByCatId.codex, liveCodexInvocationId);
      assert.equal(secondAfter.deliveryStatus, 'delivered');
      assert.equal(secondAfter.queueCustody.targetOutcomeByCatId.opus.disposition, 'responded');
      assert.deepEqual(secondAfter.queueCustody.targetOutcomeByCatId.opus.consumption, {
        kind: 'source_response',
        outputMessageIds: [response.id],
      });
      const remaining = queue.list('t1', 'u1');
      assert.equal(remaining.length, 0);
    });

    it('terminalizes an unseen reminder as missed when its exact invocation ends', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({ messageStore: durableStore });
      const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      durableDeps.queueCustodyCoordinator = coordinator;
      const durableProcessor = new QueueProcessor(durableDeps);
      const { entry, message } = enqueueCustodiedEntry(durableDeps.queue, durableStore);
      const snapshot = durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id);
      await coordinator.requestReminder(snapshot, 'opus', 'inv-ending', 'reminder-ending');

      await durableProcessor.onInvocationComplete('t1', 'opus', 'failed', 'inv-ending', ['opus']);

      assert.deepEqual(durableStore.getById(message.id).queueCustody.reminderAttempts[0], {
        id: 'reminder-ending',
        targetCatId: 'opus',
        invocationId: 'inv-ending',
        state: 'missed',
        requestedAt: durableStore.getById(message.id).queueCustody.reminderAttempts[0].requestedAt,
        missedAt: durableStore.getById(message.id).queueCustody.reminderAttempts[0].missedAt,
        missedReason: 'invocation_ended_before_delivery',
      });
    });

    it('takes the admitted entry out of Queue and terminalizes provider failure in History', async () => {
      const durableStore = new MessageStore();
      let observedQueueAtProviderStartup;
      let observedMessageStatusAtProviderStartup;
      let observedCustodyStatusAtProviderStartup;
      const durableDeps = stubDeps({
        messageStore: durableStore,
        router: {
          routeExecution: mock.fn(async function* () {
            observedQueueAtProviderStartup = durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id);
            const observedMessage = durableStore.getById(message.id);
            observedMessageStatusAtProviderStartup = observedMessage.deliveryStatus;
            observedCustodyStatusAtProviderStartup = observedMessage.queueCustody.status;
            throw new Error('provider failed');
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const { entry, message } = enqueueCustodiedEntry(durableDeps.queue, durableStore);

      await durableProcessor.processNext('t1', 'u1');
      await waitFor(() => durableDeps.router.routeExecution.mock.calls.length === 1);
      await new Promise((resolve) => setTimeout(resolve, 25));

      const stored = durableStore.getById(message.id);
      assert.equal(
        durableDeps.router.routeExecution.mock.calls.length,
        1,
        durableDeps.log.error.mock.calls
          .map((call) => call.arguments[0]?.err?.stack ?? call.arguments[0]?.err?.message ?? String(call.arguments[1]))
          .join('\n'),
      );
      assert.equal(observedQueueAtProviderStartup, null, 'admission must exact-take the operational Queue row');
      assert.equal(observedMessageStatusAtProviderStartup, 'delivered');
      assert.equal(observedCustodyStatusAtProviderStartup, 'processing');
      assert.equal(durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id), null);
      assert.equal(stored.deliveryStatus, 'delivered');
      assert.equal(
        stored.queueCustody.status,
        'terminal',
        durableDeps.log.error.mock.calls
          .map((call) => call.arguments[0]?.err?.stack ?? call.arguments[0]?.err?.message ?? String(call.arguments[1]))
          .join('\n'),
      );
      assert.deepEqual(stored.queueCustody.failedByCatIds, ['opus']);
      assert.equal(stored.queueCustody.awakenedInvocationIdByCatId, undefined);
      assert.equal(stored.queueCustody.awakenedAtByCatId, undefined);
      assert.deepEqual(stored.queueCustody.seenInvocationIdByCatId, {});
      const [failedTarget] = projectQueueReceipt(stored.queueCustody).targets;
      assert.equal(failedTarget.catId, 'opus');
      assert.equal(failedTarget.state, 'failed');
      assert.deepEqual(
        failedTarget.attempts?.map(({ targetCatId, sequence, state, terminalReason }) => ({
          targetCatId,
          sequence,
          state,
          terminalReason,
        })),
        [{ targetCatId: 'opus', sequence: 1, state: 'failed', terminalReason: 'invocation_failed' }],
      );
    });

    it('retries only the selected target from a multi-target failed receipt', async () => {
      const durableStore = new MessageStore();
      const routedTargetSets = [];
      const durableDeps = stubDeps({
        messageStore: durableStore,
        router: {
          routeExecution: mock.fn(async function* (_userId, _content, _threadId, _messageId, targetCats) {
            routedTargetSets.push([...targetCats]);
            yield { type: 'done', catId: targetCats[0], timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      durableDeps.queueCustodyCoordinator = coordinator;
      const durableProcessor = new QueueProcessor(durableDeps);
      const { entry, message } = enqueueCustodiedEntry(durableDeps.queue, durableStore, {
        targetCats: ['opus', 'codex'],
      });

      for (const catId of ['opus', 'codex']) {
        const failedInvocationId = `failed-${catId}`;
        durableDeps.queue.markQueuedSeen(entry.threadId, entry.userId, entry.id, catId, failedInvocationId);
      }
      await coordinator.persistEntry(durableDeps.queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id));
      for (const catId of ['opus', 'codex']) {
        const failedInvocationId = `failed-${catId}`;
        const [taken] = durableDeps.queue.takeQueuedFailedTargetForCatAcrossUsers(
          entry.threadId,
          catId,
          failedInvocationId,
          new Set([entry.id]),
          'invocation_failed',
        );
        assert.ok(taken?.entrySnapshot);
        await coordinator.commitFailedTargets(taken.entrySnapshot, [catId], Date.now(), 'invocation_failed', {
          [catId]: failedInvocationId,
        });
      }
      assert.equal(durableDeps.queue.getEntrySnapshot(entry.threadId, entry.userId, entry.id), null);
      const opusAttempt = durableStore
        .getById(message.id)
        .queueCustody.targetAttempts.find((attempt) => attempt.targetCatId === 'opus');
      assert.ok(opusAttempt);

      const retry = await durableProcessor.retryFailedTarget(
        entry.threadId,
        entry.userId,
        entry.id,
        message.id,
        'opus',
        opusAttempt.id,
        async (transitions) => {
          for (const transition of transitions) {
            const result = durableStore.transitionQueueCustody(transition.messageId, {
              expectedRevision: transition.current.revision,
              next: transition.next,
              replacement: transition.replacement,
            });
            assert.equal(result.kind, 'updated');
          }
          return { outcome: 'committed' };
        },
      );

      assert.equal(retry.outcome, 'retried');
      assert.notEqual(retry.entryId, entry.id);
      assert.equal(retry.attemptId.startsWith(`${retry.entryId}:opus:`), true);
      await waitFor(() => routedTargetSets.length === 1);
      assert.deepEqual(routedTargetSets, [['opus']]);
      const retryCreate = durableDeps.invocationRecordStore.create.mock.calls.at(-1)?.arguments[0];
      assert.equal(retryCreate.idempotencyKey, retry.attemptId);
      assert.deepEqual(retryCreate.targetCats, ['opus']);
    });

    it('retries a terminal cross-thread target with a fresh carrier in its original target thread', async () => {
      const durableStore = new MessageStore();
      let providerBindingEntryId;
      let providerQueueEntry;
      const durableDeps = stubDeps({
        messageStore: durableStore,
        router: {
          routeExecution: mock.fn(async function* (...args) {
            const options = args[6];
            providerBindingEntryId = durableStore.getById(options.persistedPromptMessageIds[0]).queueCustody
              .carrierByTargetCatId.codex.entryId;
            providerQueueEntry = durableDeps.queue.getEntrySnapshot('target-thread', 'u1', providerBindingEntryId);
            await options.onPromptMessagesExposed({
              threadId: 'target-thread',
              userId: 'u1',
              catId: 'codex',
              invocationId: 'cross-retry-child',
              messageIds: options.persistedPromptMessageIds,
              seenAt: Date.now(),
            });
            yield {
              type: 'done',
              catId: 'codex',
              invocationId: 'cross-retry-child',
              timestamp: Date.now(),
            };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const coordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      durableDeps.queueCustodyCoordinator = coordinator;
      const original = durableDeps.queue.enqueue(
        canonicalTestQueueInput({
          threadId: 'target-thread',
          userId: 'u1',
          kind: 'message_wake',
          ownerAuthProvenance: 'strict',
          content: 'cross-thread source body',
          source: 'agent',
          sourceCategory: 'a2a',
          targetCats: ['codex'],
          intent: 'execute',
          autoExecute: true,
          callerCatId: 'opus',
          a2aParentInvocationId: 'cross-parent',
          a2aTriggerMessageId: 'cross-source-message',
        }),
      ).entry;
      const message = durableStore.append(
        canonicalTestMessageInput({
          threadId: 'source-thread',
          userId: 'u1',
          catId: 'opus',
          content: original.content,
          mentions: ['codex'],
          timestamp: original.createdAt,
          deliveryStatus: 'queued',
        }),
      );
      durableDeps.queue.backfillMessageId('target-thread', 'u1', original.id, message.id);
      original.messageId = message.id;
      assert.equal(
        durableStore.initializeQueueCustody(
          message.id,
          createInitialCrossThreadQueuedMessageCustody(message.id, [original], {
            requestedTargetCats: ['codex'],
            createdAt: original.createdAt,
          }),
        ).kind,
        'initialized',
      );
      durableDeps.queue.markQueuedSeen('target-thread', 'u1', original.id, 'codex', 'cross-failed-child');
      await coordinator.persistEntry(durableDeps.queue.getEntrySnapshot('target-thread', 'u1', original.id));
      const [failed] = durableDeps.queue.takeQueuedFailedTargetForCatAcrossUsers(
        'target-thread',
        'codex',
        'cross-failed-child',
        new Set([original.id]),
      );
      assert.ok(failed?.entrySnapshot);
      await coordinator.commitFailedTargets(failed.entrySnapshot, ['codex'], Date.now(), 'invocation_failed', {
        codex: 'cross-failed-child',
      });
      const failedAttempt = durableStore.getById(message.id).queueCustody.targetAttempts.at(-1);

      const retry = await new QueueProcessor(durableDeps).retryFailedTarget(
        'target-thread',
        'u1',
        original.id,
        message.id,
        'codex',
        failedAttempt.id,
        async (transitions) => {
          for (const transition of transitions) {
            assert.equal(
              durableStore.transitionQueueCustody(transition.messageId, {
                expectedRevision: transition.current.revision,
                next: transition.next,
                replacement: transition.replacement,
              }).kind,
              'updated',
            );
          }
          return { outcome: 'committed' };
        },
      );

      assert.equal(retry.outcome, 'retried');
      assert.notEqual(retry.entryId, original.id);
      await waitFor(() => providerBindingEntryId !== undefined);
      assert.equal(providerBindingEntryId, retry.entryId);
      assert.equal(providerQueueEntry, null, 'fresh retry carrier leaves Queue at provider admission');
      await waitFor(() => durableStore.getById(message.id).queueCustody.status === 'terminal');
    });

    it('refuses a legacy source before provider admission and preserves its pre-admission Queue carrier', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({
        messageStore: durableStore,
        router: {
          routeExecution: mock.fn(async function* () {
            throw new Error('provider failed before durable response');
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const entry = enqueueEntry(durableDeps.queue, { content: 'legacy queued source' });
      const message = durableStore.append(
        canonicalTestMessageInput({
          userId: entry.userId,
          catId: null,
          content: entry.content,
          mentions: entry.targetCats,
          timestamp: entry.createdAt,
          threadId: entry.threadId,
          deliveryStatus: 'queued',
        }),
      );
      durableDeps.queue.backfillMessageId(entry.threadId, entry.userId, entry.id, message.id);

      const result = await durableProcessor.executeEntry(durableDeps.queue.markProcessing('t1', 'u1'));

      const stored = durableStore.getById(message.id);
      assert.equal(result.status, 'failed');
      assert.equal(durableDeps.router.routeExecution.mock.calls.length, 0);
      assert.equal(durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id)?.status, 'queued');
      assert.equal(stored.deliveryStatus, 'queued');
      assert.equal(stored.queueCustody, undefined, 'runtime admission must not install migration compatibility state');
    });

    it('keeps exact child-created proof when the invocation fails before body exposure', async () => {
      const durableStore = new MessageStore();
      const awakenedAt = 2_010;
      const durableDeps = stubDeps({
        messageStore: durableStore,
        router: {
          routeExecution: mock.fn(async function* () {
            yield {
              type: 'system_info',
              catId: 'opus',
              content: 'child execution started',
              turnInvocationId: 'child-created-then-failed',
              turnExecutionStartedAt: awakenedAt,
              extra: {
                turnExecution: {
                  invocationId: 'child-created-then-failed',
                  parentInvocationId: 'parent-created-then-failed',
                  executionKind: 'ordinary',
                },
              },
              timestamp: awakenedAt,
            };
            throw new Error('provider failed before prompt exposure');
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const { entry, message } = enqueueCustodiedEntry(durableDeps.queue, durableStore);

      await durableProcessor.processNext('t1', 'u1');
      await waitFor(() => durableStore.getById(message.id)?.queueCustody?.status === 'terminal');

      const stored = durableStore.getById(message.id);
      assert.equal(stored.queueCustody.bodyExposures, undefined);
      assert.equal(stored.queueCustody.awakenedInvocationIdByCatId, undefined);
      assert.equal(stored.queueCustody.awakenedAtByCatId, undefined);
      const [failedTarget] = projectQueueReceipt(stored.queueCustody).targets;
      assert.equal(failedTarget.catId, 'opus');
      assert.equal(failedTarget.state, 'failed');
      assert.equal(failedTarget.invocationId, 'child-created-then-failed');
      assert.equal(failedTarget.awakenedAt, undefined);
      assert.deepEqual(
        failedTarget.attempts?.map(({ targetCatId, sequence, state, terminalReason }) => ({
          targetCatId,
          sequence,
          state,
          terminalReason,
        })),
        [{ targetCatId: 'opus', sequence: 1, state: 'failed', terminalReason: 'invocation_failed' }],
      );
    });

    it('does not infer child awakening from compatibility content without typed execution truth', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({
        messageStore: durableStore,
        router: {
          routeExecution: mock.fn(async function* () {
            yield {
              type: 'system_info',
              catId: 'opus',
              content: JSON.stringify({
                type: 'invocation_created',
                invocationId: 'content-only-child',
                parentInvocationId: 'content-only-parent',
                executionKind: 'ordinary',
                startedAt: 2_020,
              }),
              timestamp: 2_020,
            };
            throw new Error('provider failed before typed child proof');
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const { entry, message } = enqueueCustodiedEntry(durableDeps.queue, durableStore);

      await durableProcessor.processNext('t1', 'u1');
      await waitFor(() => durableStore.getById(message.id)?.queueCustody?.status === 'terminal');

      const stored = durableStore.getById(message.id);
      assert.equal(stored.queueCustody.awakenedInvocationIdByCatId, undefined);
      assert.equal(stored.queueCustody.awakenedAtByCatId, undefined);
      const [failedTarget] = projectQueueReceipt(stored.queueCustody).targets;
      assert.equal(failedTarget.catId, 'opus');
      assert.equal(failedTarget.state, 'failed');
      assert.deepEqual(
        failedTarget.attempts?.map(({ targetCatId, sequence, state, terminalReason }) => ({
          targetCatId,
          sequence,
          state,
          terminalReason,
        })),
        [{ targetCatId: 'opus', sequence: 1, state: 'failed', terminalReason: 'invocation_failed' }],
      );
    });

    it('terminalizes a custodied agent trigger when A2A admission cannot establish successor custody', async () => {
      const durableStore = new MessageStore();
      const durableDeps = stubDeps({
        messageStore: durableStore,
        router: {
          routeExecution: mock.fn(async function* () {
            throw new Error('durable A2A custody unavailable for codex: InvocationQueue unavailable');
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const durableProcessor = new QueueProcessor(durableDeps);
      const { entry, message } = enqueueCustodiedEntry(durableDeps.queue, durableStore, {
        content: '@opus review this',
        source: 'agent',
        sourceCategory: 'a2a',
        autoExecute: true,
      });

      await durableProcessor.processNext('t1', 'u1');
      await waitFor(() => durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id) === null);

      const stored = durableStore.getById(message.id);
      assert.equal(stored.deliveryStatus, 'delivered');
      assert.equal(stored.queueCustody.status, 'terminal');
      assert.deepEqual(stored.queueCustody.pendingTargetCats, []);
      assert.deepEqual(stored.queueCustody.failedByCatIds, ['opus']);
      const [failedTarget] = projectQueueReceipt(stored.queueCustody).targets;
      assert.equal(failedTarget.state, 'failed');
    });
  });

  it('F254 Phase E: adopts a pending closure and reloads exact bodies before model execution', async () => {
    const closureStore = new InMemoryFreshnessClosureStore();
    const closure = await closureStore.openOrAdvance({
      closureId: 'closure-1',
      userId: 'u1',
      threadId: 't1',
      catId: 'opus',
      invocationId: 'inv-base',
      originTriggerMessageId: 'msg-origin',
      draftContent: 'old draft',
      requiredMessageIds: ['msg-required'],
      requiredFrontierMessageId: 'msg-required',
      observedRawFrontierMessageId: 'msg-required',
      now: 100,
    });
    const routeCalls = [];
    const customDeps = stubDeps({
      freshnessClosureStore: closureStore,
      messageStore: {
        ...stubDeps().messageStore,
        getLatestThreadMessageIdIncludingQueued: mock.fn(async () => 'msg-required'),
        getByThreadAfter: mock.fn(async () => []),
        getById: mock.fn(async (id) => ({
          id,
          threadId: 't1',
          userId: 'u1',
          catId: null,
          content: 'late user facts',
          mentions: [],
          timestamp: 100,
        })),
      },
      router: {
        routeExecution: mock.fn(async function* (...args) {
          routeCalls.push(args);
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const customProcessor = new QueueProcessor(customDeps);
    const entry = enqueueEntry(customDeps.queue, {
      source: 'agent',
      sourceCategory: 'freshness',
      autoExecute: true,
      freshnessClosureId: closure.id,
      freshnessRequiredFrontierMessageId: closure.requiredFrontierMessageId,
      idempotencyKey: `freshness-closure:${closure.id}`,
    });
    const processing = customDeps.queue.markProcessing('t1', 'u1');

    const result = await customProcessor.executeEntry(processing);

    assert.equal(result.status, 'succeeded');
    assert.equal(routeCalls.length, 1);
    assert.ok(routeCalls[0][1].includes('late user facts'));
    assert.equal(routeCalls[0][6].freshnessClosureId, closure.id);
    assert.deepEqual(routeCalls[0][6].freshnessClosureRequiredMessageIds, ['msg-required']);
  });

  it('F254 Phase E: explicit retry tells the successor which prior side effects must not be repeated', async () => {
    const closureStore = new InMemoryFreshnessClosureStore();
    const blocked = await closureStore.openOrAdvance({
      closureId: 'closure-side-effect-retry',
      userId: 'u1',
      threadId: 't1',
      catId: 'opus',
      invocationId: 'inv-base',
      originTriggerMessageId: 'msg-origin',
      draftContent: 'stale draft after hold',
      requiredMessageIds: ['msg-required'],
      requiredFrontierMessageId: 'msg-required',
      observedRawFrontierMessageId: 'msg-required',
      replayUnsafeToolNames: ['mcp__cat-cafe-collab__cat_cafe_hold_ball'],
      now: 100,
    });
    assert.equal(blocked.status, 'blocked');
    const retried = await closureStore.retry(blocked.id, {
      actorId: 'u1',
      evidenceRef: 'api:retry:test',
      now: 110,
    });
    const routeCalls = [];
    const customDeps = stubDeps({
      freshnessClosureStore: closureStore,
      messageStore: {
        ...stubDeps().messageStore,
        getLatestThreadMessageIdIncludingQueued: mock.fn(async () => 'msg-required'),
        getByThreadAfter: mock.fn(async () => []),
        getById: mock.fn(async (id) => ({
          id,
          threadId: 't1',
          userId: 'u1',
          catId: null,
          content: 'late user facts',
          mentions: [],
          timestamp: 100,
        })),
      },
      router: {
        routeExecution: mock.fn(async function* (...args) {
          routeCalls.push(args);
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const customProcessor = new QueueProcessor(customDeps);
    enqueueEntry(customDeps.queue, {
      source: 'agent',
      sourceCategory: 'freshness',
      autoExecute: true,
      freshnessClosureId: retried.id,
      freshnessRequiredFrontierMessageId: retried.requiredFrontierMessageId,
      idempotencyKey: `freshness-closure:${retried.id}:retry:${retried.retryEpoch}`,
    });
    const processing = customDeps.queue.markProcessing('t1', 'u1');

    const result = await customProcessor.executeEntry(processing);

    assert.equal(result.status, 'succeeded');
    assert.equal(routeCalls.length, 1);
    assert.match(routeCalls[0][1], /hold_ball/);
    assert.match(routeCalls[0][1], /不要重复已完成的副作用/);
    const closed = await closureStore.get(retried.id);
    assert.equal(closed.status, 'blocked', 'a silent successor must end in durable closure truth');
    assert.equal(closed.blockedReason, 'infrastructure');
    const blockedProjection = customDeps.socketManager.broadcastAgentMessage.mock.calls
      .map((call) => {
        try {
          return JSON.parse(call.arguments[0].content);
        } catch {
          return null;
        }
      })
      .find((projection) => projection?.type === 'freshness_closure' && projection.status === 'blocked');
    assert.ok(blockedProjection, 'QueueProcessor must broadcast the durable blocked projection');
  });

  it('F254 Phase E: closure adoption advances seenCursor to the required frontier before model execution', async () => {
    // Root cause of the 2026-07-11 supersede loop (thread_mrf4rg9atprwlyzq):
    // the successor's rebuilt prompt carried the required bodies, but nothing
    // advanced the DeliveryCursorStore seenCursor (the successor entry has no
    // messageId, so route-serial's incrementalMode AC-A3 seed is skipped too).
    // The output freshness gate then re-read the frozen cursor, judged the very
    // same injected messages unseen, and superseded every replacement forever.
    // ADR-041 §5: "Automatic injection records the same-invocation input
    // frontier, advances seenCursor" — injection must count as seen.
    const closureStore = new InMemoryFreshnessClosureStore();
    const closure = await closureStore.openOrAdvance({
      closureId: 'closure-cursor-advance',
      userId: 'u1',
      threadId: 't1',
      catId: 'opus',
      invocationId: 'inv-base',
      originTriggerMessageId: 'msg-origin',
      draftContent: 'old draft',
      requiredMessageIds: ['msg-a', 'msg-b'],
      requiredFrontierMessageId: 'msg-b',
      observedRawFrontierMessageId: 'msg-b',
      now: 100,
    });
    const ackCalls = [];
    let ackCountSeenByModel = -1;
    const customDeps = stubDeps({
      freshnessClosureStore: closureStore,
      deliveryCursorStore: {
        ackSeenCursor: mock.fn(async (userId, catId, threadId, messageId) => {
          ackCalls.push({ userId, catId, threadId, messageId });
        }),
      },
      messageStore: {
        ...stubDeps().messageStore,
        getLatestThreadMessageIdIncludingQueued: mock.fn(async () => 'msg-b'),
        getByThreadAfter: mock.fn(async () => []),
        getById: mock.fn(async (id) => ({
          id,
          threadId: 't1',
          userId: 'u1',
          catId: 'peer-cat',
          content: `body:${id}`,
          mentions: [],
          timestamp: 100,
        })),
      },
      router: {
        routeExecution: mock.fn(async function* () {
          ackCountSeenByModel = ackCalls.length;
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const customProcessor = new QueueProcessor(customDeps);
    enqueueEntry(customDeps.queue, {
      source: 'agent',
      sourceCategory: 'freshness',
      autoExecute: true,
      freshnessClosureId: closure.id,
      freshnessRequiredFrontierMessageId: closure.requiredFrontierMessageId,
      idempotencyKey: `freshness-closure:${closure.id}`,
    });
    const processing = customDeps.queue.markProcessing('t1', 'u1');

    const result = await customProcessor.executeEntry(processing);

    assert.equal(result.status, 'succeeded');
    assert.equal(ackCalls.length, 1, 'closure adoption must ack the seen cursor exactly once');
    assert.deepEqual(ackCalls[0], { userId: 'u1', catId: 'opus', threadId: 't1', messageId: 'msg-b' });
    assert.equal(ackCountSeenByModel, 1, 'seenCursor must advance BEFORE model execution starts');
  });

  it('F254 Phase E: closure adoption survives a seenCursor ack failure (fail-open, no block)', async () => {
    // Cursor ack is a freshness-gate seed, not commit truth. Infra hiccups must not
    // fail the successor — worst case the gate re-checks one more round (budget-bounded).
    const closureStore = new InMemoryFreshnessClosureStore();
    const closure = await closureStore.openOrAdvance({
      closureId: 'closure-cursor-ack-fail',
      userId: 'u1',
      threadId: 't1',
      catId: 'opus',
      invocationId: 'inv-base',
      originTriggerMessageId: 'msg-origin',
      draftContent: 'old draft',
      requiredMessageIds: ['msg-a'],
      requiredFrontierMessageId: 'msg-a',
      observedRawFrontierMessageId: 'msg-a',
      now: 100,
    });
    const routeCalls = [];
    const failingAck = mock.fn(async () => {
      throw new Error('redis unavailable');
    });
    const customDeps = stubDeps({
      freshnessClosureStore: closureStore,
      deliveryCursorStore: {
        ackSeenCursor: failingAck,
      },
      messageStore: {
        ...stubDeps().messageStore,
        getLatestThreadMessageIdIncludingQueued: mock.fn(async () => 'msg-a'),
        getByThreadAfter: mock.fn(async () => []),
        getById: mock.fn(async (id) => ({
          id,
          threadId: 't1',
          userId: 'u1',
          catId: 'peer-cat',
          content: `body:${id}`,
          mentions: [],
          timestamp: 100,
        })),
      },
      router: {
        routeExecution: mock.fn(async function* (...args) {
          routeCalls.push(args);
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const customProcessor = new QueueProcessor(customDeps);
    enqueueEntry(customDeps.queue, {
      source: 'agent',
      sourceCategory: 'freshness',
      autoExecute: true,
      freshnessClosureId: closure.id,
      freshnessRequiredFrontierMessageId: closure.requiredFrontierMessageId,
      idempotencyKey: `freshness-closure:${closure.id}`,
    });
    const processing = customDeps.queue.markProcessing('t1', 'u1');

    const result = await customProcessor.executeEntry(processing);

    assert.equal(result.status, 'succeeded');
    assert.equal(failingAck.mock.callCount(), 1, 'the ack must actually be attempted');
    assert.equal(routeCalls.length, 1, 'model execution must proceed despite ack failure');
  });

  it('IR-10: rescans retry currency and injects original intent, latest draft, and current relevant updates', async () => {
    const closureStore = new InMemoryFreshnessClosureStore();
    const closure = await closureStore.openOrAdvance({
      closureId: 'closure-current-preflight',
      userId: 'u1',
      threadId: 't1',
      catId: 'opus',
      invocationId: 'inv-base',
      originTriggerMessageId: '0001-origin',
      draftContent: 'the retained stale draft',
      requiredMessageIds: ['0002-required'],
      requiredFrontierMessageId: '0002-required',
      observedRawFrontierMessageId: '0002-required',
      now: 100,
    });
    const messages = [
      {
        id: '0001-origin',
        threadId: 't1',
        userId: 'u1',
        catId: null,
        content: 'the original user intent',
        mentions: ['opus'],
        timestamp: 100,
      },
      {
        id: '0002-required',
        threadId: 't1',
        userId: 'u1',
        catId: null,
        content: 'the first late fact',
        mentions: ['opus'],
        timestamp: 110,
      },
      {
        id: '0003-directed-away',
        threadId: 't1',
        userId: 'u1',
        catId: null,
        content: 'fable-only steer must not enter opus prompt',
        mentions: ['fable5'],
        timestamp: 120,
      },
      {
        id: '0004-current',
        threadId: 't1',
        userId: 'u1',
        catId: null,
        content: 'the current relevant update',
        mentions: ['opus'],
        timestamp: 130,
      },
    ];
    const routeCalls = [];
    const ackCalls = [];
    const customDeps = stubDeps({
      freshnessClosureStore: closureStore,
      deliveryCursorStore: {
        ackSeenCursor: mock.fn(async (...args) => ackCalls.push(args)),
      },
      messageStore: {
        ...stubDeps().messageStore,
        getLatestThreadMessageIdIncludingQueued: mock.fn(async () => '0004-current'),
        getByThreadAfter: mock.fn(async (_threadId, afterId, limit) =>
          messages.filter((message) => message.id > (afterId ?? '')).slice(0, limit),
        ),
        getById: mock.fn(async (id) => messages.find((message) => message.id === id) ?? null),
      },
      router: {
        routeExecution: mock.fn(async function* (...args) {
          routeCalls.push(args);
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const customProcessor = new QueueProcessor(customDeps);
    enqueueEntry(customDeps.queue, {
      source: 'agent',
      sourceCategory: 'freshness',
      autoExecute: true,
      freshnessClosureId: closure.id,
      freshnessRequiredFrontierMessageId: closure.requiredFrontierMessageId,
      idempotencyKey: `freshness-closure:${closure.id}`,
    });

    const result = await customProcessor.executeEntry(customDeps.queue.markProcessing('t1', 'u1'));

    assert.equal(result.status, 'succeeded');
    assert.equal(routeCalls.length, 1);
    const prompt = routeCalls[0][1];
    assert.match(prompt, /\[Original intent\]/);
    assert.match(prompt, /the original user intent/);
    assert.match(prompt, /\[Latest retained draft\]/);
    assert.match(prompt, /the retained stale draft/);
    assert.match(prompt, /\[Current relevant updates\]/);
    assert.match(prompt, /the first late fact/);
    assert.match(prompt, /the current relevant update/);
    assert.doesNotMatch(prompt, /fable-only steer/);
    const refreshed = await closureStore.get(closure.id);
    assert.deepEqual(refreshed.requiredMessageIds, ['0002-required', '0004-current']);
    assert.equal(refreshed.observedRawFrontierMessageId, '0004-current');
    assert.equal(ackCalls[0][3], '0004-current');
  });

  it('IR-10: blocks a legacy closure with no origin identity before model execution', async () => {
    const closureStore = new InMemoryFreshnessClosureStore();
    const closure = await closureStore.openOrAdvance({
      closureId: 'closure-missing-origin',
      userId: 'u1',
      threadId: 't1',
      catId: 'opus',
      invocationId: 'inv-base',
      draftContent: 'old draft',
      requiredMessageIds: ['0002-required'],
      requiredFrontierMessageId: '0002-required',
      observedRawFrontierMessageId: '0002-required',
      now: 100,
    });
    const routeExecution = mock.fn(async function* () {
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    });
    const customDeps = stubDeps({
      freshnessClosureStore: closureStore,
      messageStore: {
        ...stubDeps().messageStore,
        getLatestThreadMessageIdIncludingQueued: mock.fn(async () => '0002-required'),
        getByThreadAfter: mock.fn(async () => []),
      },
      router: { routeExecution, ackCollectedCursors: mock.fn(async () => {}) },
    });
    const customProcessor = new QueueProcessor(customDeps);
    enqueueEntry(customDeps.queue, {
      source: 'agent',
      sourceCategory: 'freshness',
      autoExecute: true,
      freshnessClosureId: closure.id,
      freshnessRequiredFrontierMessageId: closure.requiredFrontierMessageId,
      idempotencyKey: `freshness-closure:${closure.id}`,
    });

    const result = await customProcessor.executeEntry(customDeps.queue.markProcessing('t1', 'u1'));

    assert.equal(result.status, 'failed');
    assert.equal(routeExecution.mock.callCount(), 0);
    const blocked = await closureStore.get(closure.id);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockedReason, 'freshness_preflight_incomplete');
    assert.deepEqual(blocked.blockedEvidenceRefs, ['origin-trigger:missing-identity']);
  });

  it('IR-10: blocks an incomplete raw-frontier scan before model execution', async () => {
    const closureStore = new InMemoryFreshnessClosureStore();
    const closure = await closureStore.openOrAdvance({
      closureId: 'closure-incomplete-scan',
      userId: 'u1',
      threadId: 't1',
      catId: 'opus',
      invocationId: 'inv-base',
      originTriggerMessageId: '0001-origin',
      draftContent: 'old draft',
      requiredMessageIds: ['0002-required'],
      requiredFrontierMessageId: '0002-required',
      observedRawFrontierMessageId: '0002-required',
      now: 100,
    });
    const routeExecution = mock.fn(async function* () {
      yield { type: 'done', catId: 'opus', timestamp: Date.now() };
    });
    const customDeps = stubDeps({
      freshnessClosureStore: closureStore,
      messageStore: {
        ...stubDeps().messageStore,
        getLatestThreadMessageIdIncludingQueued: mock.fn(async () => '0003-queued-gap'),
        getByThreadAfter: mock.fn(async () => []),
        getById: mock.fn(async (id) => ({
          id,
          threadId: 't1',
          userId: 'u1',
          catId: null,
          content: `body:${id}`,
          mentions: ['opus'],
          timestamp: 100,
        })),
      },
      router: { routeExecution, ackCollectedCursors: mock.fn(async () => {}) },
    });
    const customProcessor = new QueueProcessor(customDeps);
    enqueueEntry(customDeps.queue, {
      source: 'agent',
      sourceCategory: 'freshness',
      autoExecute: true,
      freshnessClosureId: closure.id,
      freshnessRequiredFrontierMessageId: closure.requiredFrontierMessageId,
      idempotencyKey: `freshness-closure:${closure.id}`,
    });

    const result = await customProcessor.executeEntry(customDeps.queue.markProcessing('t1', 'u1'));

    assert.equal(result.status, 'failed');
    assert.equal(routeExecution.mock.callCount(), 0);
    const blocked = await closureStore.get(closure.id);
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.blockedReason, 'freshness_preflight_incomplete');
    assert.deepEqual(blocked.blockedEvidenceRefs, ['raw-frontier:incomplete:0002-required:0003-queued-gap']);
  });

  it('F254 Phase E: closes an append-recovered closure without another model pass', async () => {
    const closureStore = new InMemoryFreshnessClosureStore();
    const closure = await closureStore.openOrAdvance({
      closureId: 'closure-append-recovered',
      userId: 'u1',
      threadId: 't1',
      catId: 'opus',
      invocationId: 'inv-base',
      draftContent: 'already committed draft',
      requiredMessageIds: ['msg-required'],
      requiredFrontierMessageId: 'msg-required',
      observedRawFrontierMessageId: 'msg-required',
      now: 100,
    });
    const committedMessage = {
      id: 'msg-already-committed',
      threadId: 't1',
      userId: 'u1',
      catId: 'opus',
      content: 'already committed draft',
      mentions: [],
      timestamp: 110,
    };
    const customDeps = stubDeps({
      freshnessClosureStore: closureStore,
      messageStore: {
        ...stubDeps().messageStore,
        getByIdempotencyKey: mock.fn(async (_userId, _threadId, key) =>
          key === `freshness-closure:${closure.id}:final` ? committedMessage : null,
        ),
      },
    });
    const customProcessor = new QueueProcessor(customDeps);
    enqueueEntry(customDeps.queue, {
      source: 'agent',
      sourceCategory: 'freshness',
      autoExecute: true,
      freshnessClosureId: closure.id,
      idempotencyKey: `freshness-closure:${closure.id}`,
    });
    const processing = customDeps.queue.markProcessing('t1', 'u1');

    const result = await customProcessor.executeEntry(processing);

    assert.equal(result.status, 'succeeded');
    assert.equal(customDeps.router.routeExecution.mock.calls.length, 0, 'recovery must not invoke the model');
    assert.equal(customDeps.invocationTracker.startAll.mock.calls.length, 0);
    const committedClosure = await closureStore.get(closure.id);
    assert.equal(committedClosure.status, 'committed');
    assert.equal(committedClosure.committedMessageId, committedMessage.id);
    assert.equal(
      customDeps.messageStore.getByIdempotencyKey.mock.calls[0].arguments[2],
      `freshness-closure:${closure.id}:final`,
    );
  });

  it('F254 Phase E: cancels a redundant successor before model execution', async () => {
    const closureStore = new InMemoryFreshnessClosureStore();
    const closure = await closureStore.openOrAdvance({
      closureId: 'closure-running',
      userId: 'u1',
      threadId: 't1',
      catId: 'opus',
      invocationId: 'inv-base',
      draftContent: 'old draft',
      requiredMessageIds: ['msg-required'],
      requiredFrontierMessageId: 'msg-required',
      observedRawFrontierMessageId: 'msg-required',
      now: 100,
    });
    await closureStore.claimAttempt(closure.id, {
      invocationId: 'inv-already-running',
      inputFrontierMessageId: 'msg-required',
      observedRawFrontierMessageId: 'msg-required',
      now: 110,
    });
    const customDeps = stubDeps({ freshnessClosureStore: closureStore });
    const customProcessor = new QueueProcessor(customDeps);
    enqueueEntry(customDeps.queue, {
      source: 'agent',
      sourceCategory: 'freshness',
      autoExecute: true,
      freshnessClosureId: closure.id,
    });
    const processing = customDeps.queue.markProcessing('t1', 'u1');

    const result = await customProcessor.executeEntry(processing);

    assert.equal(result.status, 'succeeded');
    assert.equal(customDeps.router.routeExecution.mock.calls.length, 0);
    assert.equal(customDeps.invocationTracker.startAll.mock.calls.length, 0);
  });

  it('succeeded + queue has entries → auto-dequeues and starts execution', async () => {
    const entry = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    await processor.onInvocationComplete('t1', 'opus', 'succeeded');

    // Should have started execution (invocationTracker.start called)
    assert.ok(deps.invocationTracker.startAll.mock.calls.length > 0);
    // Entry should be marked processing then removed
    // Wait a tick for background execution
    await new Promise((r) => setTimeout(r, 50));
  });

  it('issue #845: done event with metadata.usage → invocation.update writes usageByCat', async () => {
    // Reproduce the QueueProcessor execution path where a routed done event carries
    // metadata.usage. Prior to the fix, executeEntry only wrote `status: succeeded`
    // without `usageByCat`, leaving 159+ historical succeeded invocations with empty
    // usage in production. The Phase A fix mirrors the messages.ts collectedUsage
    // pattern so the queue path now persists per-cat token usage.
    const customDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* () {
          yield {
            type: 'done',
            catId: 'opus',
            timestamp: Date.now(),
            metadata: {
              provider: 'claude',
              model: 'claude-opus-4-7',
              usage: { inputTokens: 1234, outputTokens: 567, cacheReadTokens: 100, costUsd: 0.05 },
            },
          };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const customProcessor = new QueueProcessor(customDeps);
    enqueueEntry(customDeps.queue);

    await customProcessor.onInvocationComplete('t1', 'opus', 'succeeded');
    // Wait for background executeEntry to finish (it's spawned in setImmediate).
    await new Promise((r) => setTimeout(r, 100));

    const updateCalls = customDeps.invocationRecordStore.update.mock.calls;
    const succeededCall = updateCalls.find((c) => c.arguments[1]?.status === 'succeeded');
    assert.ok(succeededCall, 'expected an update(...,{status:succeeded,...}) call');
    const payload = succeededCall.arguments[1];
    assert.ok(payload.usageByCat, 'usageByCat must be present on the succeeded update');
    assert.deepEqual(payload.usageByCat.opus, {
      inputTokens: 1234,
      outputTokens: 567,
      cacheReadTokens: 100,
      costUsd: 0.05,
    });
  });

  it('issue #845: done event without metadata.usage → succeeded update omits usageByCat', async () => {
    // Guard the opposite direction: when a provider does not emit usage on done,
    // we must not write an empty usageByCat (would mask the diagnostic that the
    // provider is dropping usage upstream).
    const customDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* () {
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const customProcessor = new QueueProcessor(customDeps);
    enqueueEntry(customDeps.queue);

    await customProcessor.onInvocationComplete('t1', 'opus', 'succeeded');
    await new Promise((r) => setTimeout(r, 100));

    const updateCalls = customDeps.invocationRecordStore.update.mock.calls;
    const succeededCall = updateCalls.find((c) => c.arguments[1]?.status === 'succeeded');
    assert.ok(succeededCall, 'expected an update(...,{status:succeeded,...}) call');
    assert.equal(
      succeededCall.arguments[1].usageByCat,
      undefined,
      'usageByCat must remain undefined when provider emitted no usage',
    );
  });

  it('governance-blocked queue invocation stays failed and never flips to succeeded', async () => {
    const customDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* () {
          yield {
            type: 'system_info',
            catId: 'opus',
            content: JSON.stringify({
              type: 'governance_blocked',
              projectPath: '/home/user/projects/EchoAgent',
              reasonKind: 'needs_bootstrap',
              invocationId: 'inv-stub',
            }),
            timestamp: Date.now(),
          };
          yield {
            type: 'done',
            catId: 'opus',
            timestamp: Date.now(),
            errorCode: 'GOVERNANCE_BOOTSTRAP_REQUIRED',
          };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const customProcessor = new QueueProcessor(customDeps);
    enqueueEntry(customDeps.queue);

    const result = await customProcessor.processNext('t1', 'u1');
    assert.equal(result.started, true, 'queue entry should start executing');
    await new Promise((r) => setTimeout(r, 100));

    const updateCalls = customDeps.invocationRecordStore.update.mock.calls;
    const failedCall = updateCalls.find(
      (c) => c.arguments[1]?.status === 'failed' && c.arguments[1]?.error === 'GOVERNANCE_BOOTSTRAP_REQUIRED',
    );
    assert.ok(failedCall, 'queue path must persist governance-blocked invocations as failed');

    const succeededCall = updateCalls.find((c) => c.arguments[1]?.status === 'succeeded');
    assert.equal(succeededCall, undefined, 'governance-blocked queue invocations must not be finalized as succeeded');
  });

  it('succeeded + stale user queued entry → auto-dequeues and starts execution', async () => {
    const entry = enqueueEntry(deps.queue, { source: 'user' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');
    deps.queue.list('t1', 'u1')[0].createdAt = Date.now() - 60_000 - 1;

    await processor.onInvocationComplete('t1', 'opus', 'succeeded');

    assert.ok(
      deps.invocationTracker.startAll.mock.calls.length > 0,
      'stale user queued entry is still pending work and should be dispatched on completion',
    );
  });

  it('succeeded + stale connector queued entry → auto-dequeues and starts execution', async () => {
    const entry = enqueueEntry(deps.queue, { source: 'connector' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-connector-1');
    deps.queue.list('t1', 'u1')[0].createdAt = Date.now() - 60_000 - 1;

    await processor.onInvocationComplete('t1', 'opus', 'succeeded');

    assert.ok(
      deps.invocationTracker.startAll.mock.calls.length > 0,
      'stale connector queued entry is still pending work and should be dispatched on completion',
    );
  });

  it('succeeded + empty queue → no action', async () => {
    await processor.onInvocationComplete('t1', 'opus', 'succeeded');
    assert.equal(deps.invocationTracker.startAll.mock.calls.length, 0);
  });

  describe('F254 D1.2b queued handled closure', () => {
    it('succeeded + seen single-target queued entry → consumes entry and marks delivered', async () => {
      deps.freshnessEventLog = { append: mock.fn(async () => {}) };
      const entry = enqueueEntry(deps.queue, { targetCats: ['opus'] });
      deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');
      assert.equal(deps.queue.markQueuedSeen('t1', 'u1', entry.id, 'opus', 'inv-opus-1'), true);

      await processor.onInvocationComplete('t1', 'opus', 'succeeded', 'inv-opus-1', ['opus']);

      assert.equal(deps.queue.list('t1', 'u1').length, 0, 'seen single-target entry should be consumed');
      assert.deepEqual(
        deps.messageStore.markDelivered.mock.calls.map((call) => call.arguments[0]),
        ['msg-1'],
        'fully consumed queued messages should be marked delivered',
      );
      const deliveredCall = deps.socketManager.emitToUser.mock.calls.find(
        (call) => call.arguments[1] === 'messages_delivered',
      );
      assert.ok(deliveredCall, 'fully consumed queued messages should be emitted to the live timeline');
      assert.equal(deliveredCall.arguments[0], 'u1');
      assert.deepEqual(deliveredCall.arguments[2].messageIds, ['msg-1']);
      assert.deepEqual(
        deliveredCall.arguments[2].messages.map((message) => message.id),
        ['msg-1'],
      );
      assert.equal(
        deps.invocationTracker.startAll.mock.calls.length,
        0,
        'handled entry should not be auto-dispatched again',
      );
      assert.equal(deps.freshnessEventLog.append.mock.calls.length, 1);
      assert.deepEqual(deps.freshnessEventLog.append.mock.calls[0].arguments[0], {
        kind: 'queued_handled',
        threadId: 't1',
        catId: 'opus',
        invocationId: 'inv-opus-1',
        timestamp: deps.freshnessEventLog.append.mock.calls[0].arguments[0].timestamp,
        queueEntryId: entry.id,
        messageIds: ['msg-1'],
        disposition: 'completed_with_turn',
        evidenceRef: { kind: 'turn_execution', invocationId: 'inv-opus-1' },
        remainingTargetCats: [],
      });
      assert.equal(
        queuedTelemetry.getFreshnessQueueTelemetrySnapshot().queuedHandledTotal,
        1,
        'successful queued_handled closure should count once',
      );
      assert.equal(
        queuedTelemetry.getFreshnessQueueTelemetrySnapshot().queuedHandledFullyConsumedTotal,
        1,
        'fully consumed queued_handled closure should count once',
      );
    });

    it('delivery persistence failure restores fully consumed queued entry and suppresses handled evidence', async () => {
      deps.freshnessEventLog = { append: mock.fn(async () => {}) };
      deps.messageStore.markDelivered = mock.fn(async () => {
        throw new Error('redis unavailable');
      });
      const entry = enqueueEntry(deps.queue, { targetCats: ['opus'] });
      deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');
      assert.equal(deps.queue.markQueuedSeen('t1', 'u1', entry.id, 'opus', 'inv-opus-1'), true);

      await processor.onInvocationComplete('t1', 'opus', 'succeeded', 'inv-opus-1', ['opus']);

      const remaining = deps.queue.list('t1', 'u1');
      assert.equal(remaining.length, 1, 'delivery failure must not drop still-queued work');
      assert.equal(remaining[0].id, entry.id);
      assert.deepEqual(remaining[0].targetCats, ['opus']);
      assert.deepEqual(remaining[0].queuedSeenByCatIds, ['opus']);
      assert.deepEqual(remaining[0].queuedSeenInvocationIdByCatId, { opus: 'inv-opus-1' });
      assert.equal(
        deps.freshnessEventLog.append.mock.calls.length,
        0,
        'queued_handled evidence is only valid after delivery persistence succeeds',
      );
      assert.equal(
        deps.socketManager.emitToUser.mock.calls.some((call) => call.arguments[1] === 'messages_delivered'),
        false,
        'failed delivery persistence must not emit messages_delivered',
      );
      assert.equal(
        deps.socketManager.emitToUser.mock.calls.some((call) => call.arguments[1] === 'queue_updated'),
        false,
        'restored queue state should not publish a handled queue update',
      );
      assert.equal(
        queuedTelemetry.getFreshnessQueueTelemetrySnapshot().queuedHandledTotal,
        0,
        'delivery persistence failure must not count queued_handled',
      );
    });

    it('partial delivery failure still emits already-transitioned messages before restoring queue entry', async () => {
      deps.freshnessEventLog = { append: mock.fn(async () => {}) };
      deps.messageStore.markDelivered = mock.fn(async (id) => {
        if (id === 'msg-2') throw new Error('redis unavailable');
        return {
          id,
          threadId: 't1',
          content: `delivered:${id}`,
          catId: null,
          timestamp: Date.now(),
          mentions: [],
          userId: 'u1',
          deliveryStatus: 'delivered',
          deliveredAt: Date.now(),
          deliveryTransitioned: true,
        };
      });
      const entry = enqueueEntry(deps.queue, { targetCats: ['opus'] });
      deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');
      deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-2');
      assert.equal(deps.queue.markQueuedSeen('t1', 'u1', entry.id, 'opus', 'inv-opus-1'), true);

      await processor.onInvocationComplete('t1', 'opus', 'succeeded', 'inv-opus-1', ['opus']);

      const remaining = deps.queue.list('t1', 'u1');
      assert.equal(remaining.length, 1, 'partial delivery failure must restore the queue entry');
      assert.equal(remaining[0].id, entry.id);
      assert.deepEqual(remaining[0].targetCats, ['opus']);
      assert.equal(
        deps.freshnessEventLog.append.mock.calls.length,
        0,
        'queued_handled evidence is only valid after every queued message delivery succeeds',
      );
      assert.equal(
        queuedTelemetry.getFreshnessQueueTelemetrySnapshot().queuedHandledTotal,
        0,
        'partial delivery failure must not count queued_handled',
      );
      const deliveredCall = deps.socketManager.emitToUser.mock.calls.find(
        (call) => call.arguments[1] === 'messages_delivered',
      );
      assert.ok(deliveredCall, 'already-transitioned messages must still reach the live timeline');
      assert.deepEqual(deliveredCall.arguments[2].messageIds, ['msg-1']);
      assert.deepEqual(
        deliveredCall.arguments[2].messages.map((message) => message.id),
        ['msg-1'],
      );
      assert.equal(
        deps.socketManager.emitToUser.mock.calls.some((call) => call.arguments[1] === 'queue_updated'),
        false,
        'restored queue state should not publish a handled queue update',
      );
    });

    it('succeeded + seen multi-target queued entry → removes only completing cat and preserves delivery', async () => {
      const entry = enqueueEntry(deps.queue, { targetCats: ['opus', 'codex'] });
      deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');
      assert.equal(deps.queue.markQueuedSeen('t1', 'u1', entry.id, 'opus', 'inv-opus-1'), true);

      await processor.onInvocationComplete('t1', 'opus', 'succeeded', 'inv-opus-1', ['opus']);

      const remaining = deps.queue.list('t1', 'u1');
      assert.equal(remaining.length, 1, 'multi-target entry should remain for other cats');
      assert.deepEqual(remaining[0].targetCats, ['codex']);
      assert.equal(
        deps.messageStore.markDelivered.mock.calls.length,
        0,
        'partially consumed queued message is not delivered until all targets are handled',
      );
      assert.equal(
        deps.socketManager.emitToUser.mock.calls.some((call) => call.arguments[1] === 'messages_delivered'),
        false,
        'partially consumed queued message should not be emitted as delivered yet',
      );
    });

    it('failed + seen queued entry → does not consume entry', async () => {
      const entry = enqueueEntry(deps.queue, { targetCats: ['opus'] });
      deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');
      assert.equal(deps.queue.markQueuedSeen('t1', 'u1', entry.id, 'opus', 'inv-opus-1'), true);

      await processor.onInvocationComplete('t1', 'opus', 'failed', undefined, ['opus']);

      assert.equal(deps.queue.list('t1', 'u1').length, 1, 'failed invocation should keep queued work retryable');
      assert.equal(deps.messageStore.markDelivered.mock.calls.length, 0);
    });

    it('succeeded + processing entry → does not consume entry', async () => {
      const entry = enqueueEntry(deps.queue, { targetCats: ['opus'] });
      deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');
      assert.equal(deps.queue.markQueuedSeen('t1', 'u1', entry.id, 'opus', 'inv-opus-1'), true);
      assert.ok(deps.queue.markProcessing('t1', 'u1'));

      await processor.onInvocationComplete('t1', 'opus', 'succeeded', 'inv-opus-1', ['opus']);

      assert.equal(deps.queue.list('t1', 'u1').length, 1, 'processing entry should remain owned by execution cleanup');
      assert.equal(deps.messageStore.markDelivered.mock.calls.length, 0);
    });

    it('succeeded after a different invocation saw then failed → does not mark stale seen entry handled', async () => {
      deps.freshnessEventLog = { append: mock.fn(async () => {}) };
      const entry = enqueueEntry(deps.queue, { targetCats: ['opus'] });
      deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');
      assert.equal(deps.queue.markQueuedSeen('t1', 'u1', entry.id, 'opus', 'inv-failed'), true);

      await processor.onInvocationComplete('t1', 'opus', 'failed', 'inv-failed', ['opus']);
      await processor.onInvocationComplete('t1', 'opus', 'succeeded', 'inv-unrelated-success', ['opus']);

      assert.equal(
        deps.messageStore.markDelivered.mock.calls.length,
        0,
        'unrelated success must not deliver a queued body read by a failed invocation',
      );
      assert.equal(deps.freshnessEventLog.append.mock.calls.length, 0);
    });

    it('queued execution completion passes its invocationId to queued handled closure', async () => {
      let queuedFreshnessEntry;
      const customDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            assert.equal(
              customDeps.queue.markQueuedSeen('t1', 'u1', queuedFreshnessEntry.id, 'opus', 'inv-stub'),
              true,
            );
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const customProcessor = new QueueProcessor(customDeps);
      enqueueEntry(customDeps.queue, { source: 'user', content: 'run current work' });
      queuedFreshnessEntry = enqueueEntry(customDeps.queue, {
        kind: 'message_wake',
        source: 'connector',
        content: 'queued body read by current invocation',
        messageId: 'msg-queued',
      });

      const result = await customProcessor.processNext('t1', 'u1');
      assert.equal(result.started, true);
      await waitFor(() => customDeps.messageStore.markDelivered.mock.calls.length > 0);

      assert.ok(
        customDeps.messageStore.markDelivered.mock.calls.some((call) => call.arguments[0] === 'msg-queued'),
        'queued body read by this queue-created invocation should be delivered on success',
      );
      assert.equal(
        customDeps.invocationTracker.startAll.mock.calls.length,
        1,
        'handled queued body should not be dispatched again after the current invocation succeeds',
      );
    });

    it('aggregate succeeded handles only cats with done evidence', async () => {
      let codexQueuedEntry;
      const customDeps = stubDeps({
        invocationTracker: {
          start: mock.fn(() => new AbortController()),
          startAll: mock.fn(() => new AbortController()),
          complete: mock.fn(),
          completeAll: mock.fn(),
          completeSlot: mock.fn(),
          has: mock.fn(() => false),
          resolveFinalStatus: mock.fn(() => 'succeeded'),
        },
        router: {
          routeExecution: mock.fn(async function* () {
            assert.equal(customDeps.queue.markQueuedSeen('t1', 'u1', codexQueuedEntry.id, 'codex', 'inv-stub'), true);
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const customProcessor = new QueueProcessor(customDeps);
      const activeEntry = enqueueEntry(customDeps.queue, {
        source: 'user',
        content: 'multi-cat current work',
        targetCats: ['opus', 'codex'],
      });
      customDeps.queue.backfillMessageId('t1', 'u1', activeEntry.id, 'msg-active');
      codexQueuedEntry = enqueueEntry(customDeps.queue, {
        source: 'connector',
        content: 'codex queued body read before cancel',
        targetCats: ['codex'],
      });
      customDeps.queue.backfillMessageId('t1', 'u1', codexQueuedEntry.id, 'msg-codex-queued');

      const result = await customProcessor.processNext('t1', 'u1');
      assert.equal(result.started, true);
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(
        customDeps.messageStore.markDelivered.mock.calls.some((call) => call.arguments[0] === 'msg-codex-queued'),
        false,
        'cat without done evidence must not close queued_handled even when aggregate status succeeds',
      );
      assert.ok(
        customDeps.queue.list('t1', 'u1').some((entry) => entry.id === codexQueuedEntry.id),
        'queued work for the canceled/non-done cat remains retryable',
      );
    });

    it('duplicate queue invocation does not close old queued_seen evidence', async () => {
      let trackerHasCalls = 0;
      const customDeps = stubDeps({
        invocationTracker: {
          start: mock.fn(() => new AbortController()),
          startAll: mock.fn(() => new AbortController()),
          complete: mock.fn(),
          completeAll: mock.fn(),
          completeSlot: mock.fn(),
          has: mock.fn((_threadId, catId) => {
            trackerHasCalls += 1;
            return trackerHasCalls > 1 && catId === 'opus';
          }),
          resolveFinalStatus: mock.fn(() => 'succeeded'),
        },
        invocationRecordStore: {
          create: mock.fn(async () => ({
            outcome: 'duplicate',
            invocationId: 'inv-duplicate',
          })),
          update: mock.fn(async () => {}),
        },
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const customProcessor = new QueueProcessor(customDeps);
      enqueueEntry(customDeps.queue, { source: 'connector', content: 'duplicate queued work' });
      const queuedEntry = enqueueEntry(customDeps.queue, { source: 'connector', content: 'old seen body' });
      customDeps.queue.backfillMessageId('t1', 'u1', queuedEntry.id, 'msg-old-seen');
      assert.equal(customDeps.queue.markQueuedSeen('t1', 'u1', queuedEntry.id, 'opus', 'inv-duplicate'), true);

      const result = await customProcessor.processNext('t1', 'u1');
      assert.equal(result.started, true);
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(
        customDeps.router.routeExecution.mock.calls.length,
        0,
        'duplicate path should not run provider work',
      );
      assert.equal(
        customDeps.messageStore.markDelivered.mock.calls.some((call) => call.arguments[0] === 'msg-old-seen'),
        false,
        'duplicate path must not turn old queued_seen evidence into queued_handled',
      );
      assert.ok(
        customDeps.queue.list('t1', 'u1').some((entry) => entry.id === queuedEntry.id),
        'old queued body remains retryable after duplicate path',
      );
    });
  });

  it('terminal cleanup drains the next Queue head without publishing a pause projection', async () => {
    enqueueEntry(deps.queue);

    await processor.onInvocationComplete('t1', 'opus', 'failed');
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.ok(deps.invocationTracker.startAll.mock.calls.length > 0, 'failed terminal should request the next drain');
    assert.equal(
      deps.socketManager.emitToUser.mock.calls.some((call) => call.arguments[1] === 'queue_paused'),
      false,
    );
  });

  it('isThreadBusy treats stale queued user work as busy until it is dispatched or cleared', () => {
    enqueueEntry(deps.queue, { source: 'user' });
    deps.queue.list('t1', 'u1')[0].createdAt = Date.now() - 60_000 - 1;

    assert.equal(deps.queue.hasQueuedForThread('t1'), true, 'Queue custody remains visible regardless of wait age');
    assert.equal(processor.isThreadBusy('t1'), true, 'delivery-batch-done must not close while stale work is pending');
  });

  it('canceled_by_user → auto-dequeues and does not emit queue_paused', async () => {
    deps.queue.enqueue(
      canonicalTestQueueInput({
        threadId: 't1',
        userId: 'u1',
        kind: 'conversation_input',
        content: 'resume after cancel',
        source: 'user',
        ownerAuthProvenance: 'unknown',
        targetCats: ['opus'],
        intent: 'execute',
      }),
    );

    await processor.onInvocationComplete('t1', 'opus', 'canceled_by_user');
    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.ok(deps.invocationTracker.startAll.mock.calls.length > 0, 'user cancel should auto-resume queued work');
    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const pausedCall = emitCalls.find((c) => c.arguments[1] === 'queue_paused');
    assert.equal(pausedCall, undefined, 'user cancel should not pause the queue');
  });

  it('canceled with processing-only queue does not publish a pause projection', async () => {
    enqueueEntry(deps.queue);
    // Simulate steer immediate: queued entry is promoted to processing before the canceled cleanup runs.
    deps.queue.markProcessing('t1', 'u1');

    await processor.onInvocationComplete('t1', 'opus', 'canceled');

    const emitCalls = deps.socketManager.emitToUser.mock.calls;
    const pausedCall = emitCalls.find((c) => c.arguments[1] === 'queue_paused');
    assert.equal(pausedCall, undefined);
  });

  it('user cancel during queued execution stops broadcasting late agent events', async () => {
    let controller;
    deps.invocationTracker.startAll.mock.mockImplementation(() => {
      controller = new AbortController();
      return controller;
    });
    deps.router.routeExecution = mock.fn(async function* () {
      yield { type: 'text', catId: 'opus', content: 'before cancel', timestamp: Date.now() };
      controller.abort('user_cancel');
      yield { type: 'text', catId: 'opus', content: 'after cancel', timestamp: Date.now() };
      yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
    });

    enqueueEntry(deps.queue);

    const result = await processor.processNext('t1', 'u1');
    assert.equal(result.started, true);
    await new Promise((resolve) => setTimeout(resolve, 80));

    const broadcasts = deps.socketManager.broadcastAgentMessage.mock.calls.map((call) => call.arguments[0]);
    assert.ok(
      broadcasts.some((msg) => msg.type === 'text' && msg.content === 'before cancel'),
      'pre-cancel text should be broadcast',
    );
    assert.equal(
      broadcasts.some((msg) => msg.type === 'text' && msg.content === 'after cancel'),
      false,
      'post-cancel text must not be broadcast',
    );
    assert.equal(
      broadcasts.some((msg) => msg.type === 'done' && msg.catId === 'opus'),
      false,
      'post-cancel done from the stale producer must not be broadcast',
    );

    const canceledUpdate = deps.invocationRecordStore.update.mock.calls.find(
      (call) => call.arguments[1]?.status === 'canceled',
    );
    assert.ok(canceledUpdate, 'aborted queued invocation should be recorded as canceled');
  });

  it('user cancel during queued execution cleans up streaming placeholders', async () => {
    let controller;
    const streamingHook = {
      onStreamStart: mock.fn(async () => {}),
      onStreamChunk: mock.fn(async () => {}),
      onStreamEnd: mock.fn(async () => {}),
      cleanupPlaceholders: mock.fn(async () => {}),
    };
    deps.invocationTracker.startAll.mock.mockImplementation(() => {
      controller = new AbortController();
      return controller;
    });
    deps.router.routeExecution = mock.fn(async function* () {
      yield { type: 'text', catId: 'opus', content: 'before cancel', timestamp: Date.now() };
      controller.abort('user_cancel');
      yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
    });
    const cancelProcessor = new QueueProcessor({ ...deps, streamingHook });

    enqueueEntry(deps.queue);

    const result = await cancelProcessor.processNext('t1', 'u1');
    assert.equal(result.started, true);
    await waitFor(() => streamingHook.cleanupPlaceholders.mock.calls.length >= 1);

    assert.ok(streamingHook.onStreamStart.mock.calls.length >= 1, 'onStreamStart should be called');
    assert.ok(streamingHook.onStreamEnd.mock.calls.length >= 1, 'onStreamEnd should be called on cancel');
    assert.equal(
      streamingHook.cleanupPlaceholders.mock.calls.length,
      1,
      'cancel path should clean up the streaming placeholder exactly once',
    );
  });

  it('user cancel consumes the attempted durable Queue carrier instead of silently requeueing it', async () => {
    const durableStore = new MessageStore();
    let controller;
    const durableDeps = stubDeps({
      messageStore: durableStore,
      invocationTracker: {
        start: mock.fn(() => new AbortController()),
        startAll: mock.fn(() => {
          controller = new AbortController();
          return controller;
        }),
        complete: mock.fn(),
        completeAll: mock.fn(),
        has: mock.fn(() => false),
      },
      router: {
        routeExecution: mock.fn(async function* () {
          controller.abort('user_cancel');
          yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    durableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
    const durableProcessor = new QueueProcessor(durableDeps);
    const { entry, message } = enqueueCustodiedEntry(durableDeps.queue, durableStore);

    await durableProcessor.processNext('t1', 'u1');
    await waitFor(() =>
      durableDeps.invocationRecordStore.update.mock.calls.some((call) => call.arguments[1]?.status === 'canceled'),
    );
    await waitFor(() => durableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id) === null);

    const stored = durableStore.getById(message.id);
    assert.equal(stored.deliveryStatus, 'delivered', 'provider admission publishes the source into History');
    assert.equal(stored.queueCustody.status, 'terminal');
    assert.deepEqual(stored.queueCustody.failedByCatIds, ['opus']);
    assert.equal(stored.queueCustody.targetAttempts.at(-1).state, 'cancelled');
    assert.equal(stored.queueCustody.targetAttempts.at(-1).terminalReason, 'invocation_cancelled');
  });

  // ── processNext ──

  it('processNext starts the next entry', async () => {
    const entry = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    const result = await processor.processNext('t1', 'u1');
    assert.equal(result.started, true);
    assert.ok(result.entry);
  });

  it('PR7 continuation dequeue executes eligible siblings without reopening a failed target', async () => {
    const routedTargetSets = [];
    deps.router.routeExecution = mock.fn(async function* (_userId, _content, _threadId, _messageId, targetCats) {
      routedTargetSets.push([...targetCats]);
      yield { type: 'done', catId: targetCats[0], timestamp: Date.now() };
    });
    processor = new QueueProcessor(deps);
    const failed = enqueueEntry(deps.queue, { targetCats: ['opus'], source: 'agent', sourceCategory: 'a2a' });
    deps.queue.takeQueuedFailedTargetForCatAcrossUsers(
      failed.threadId,
      'opus',
      'failed-opus',
      new Set([failed.id]),
      'invocation_failed',
    );
    enqueueEntry(deps.queue, { targetCats: ['codex'], source: 'agent', sourceCategory: 'a2a' });

    const result = await processor.processNext('t1', 'u1');

    assert.equal(result.started, true, 'the nonfailed sibling remains dispatchable');
    await waitFor(() => routedTargetSets.length === 1);
    assert.deepEqual(routedTargetSets, [['codex']], 'ordinary dequeue must not reintroduce the failed sibling');
  });

  it('PR7 continuation dequeue preserves an eligible sibling on the same carrier', async () => {
    const routedTargetSets = [];
    deps.router.routeExecution = mock.fn(async function* (_userId, _content, _threadId, _messageId, targetCats) {
      routedTargetSets.push([...targetCats]);
      yield { type: 'done', catId: targetCats[0], timestamp: Date.now() };
    });
    processor = new QueueProcessor(deps);
    const mixed = enqueueEntry(deps.queue, {
      targetCats: ['opus', 'codex'],
      source: 'agent',
      sourceCategory: 'a2a',
    });
    deps.queue.takeQueuedFailedTargetForCatAcrossUsers(
      mixed.threadId,
      'opus',
      'failed-opus',
      new Set([mixed.id]),
      'invocation_failed',
    );

    const result = await processor.processNext('t1', 'u1');

    assert.equal(result.started, true, 'the carrier remains dispatchable for its nonfailed target');
    await waitFor(() => routedTargetSets.length === 1);
    assert.deepEqual(routedTargetSets, [['codex']], 'provider custody must exclude the failed sibling');
  });

  it('queued execution broadcasts intent_mode with invocationId when processing starts', async () => {
    enqueueEntry(deps.queue, { targetCats: ['codex'], intent: 'execute' });

    const result = await processor.processNext('t1', 'u1');
    assert.equal(result.started, true);

    await new Promise((r) => setTimeout(r, 50));

    const intentCall = deps.socketManager.broadcastToRoom.mock.calls.find((c) => c.arguments[1] === 'intent_mode');
    assert.ok(intentCall, 'should broadcast intent_mode for queued execution');
    assert.deepEqual(intentCall.arguments[2], {
      threadId: 't1',
      mode: 'execute',
      targetCats: ['codex'],
      invocationId: 'inv-stub',
    });
  });

  it('queued execution broadcasts spawn_started before waiting for first CLI event', async () => {
    let releaseFirstEvent;
    deps.router.routeExecution = mock.fn(async function* () {
      await new Promise((resolve) => {
        releaseFirstEvent = resolve;
      });
      yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
    });

    enqueueEntry(deps.queue, { targetCats: ['codex'], intent: 'execute' });

    const result = await processor.processNext('t1', 'u1');
    assert.equal(result.started, true);

    await new Promise((r) => setTimeout(r, 50));

    const spawnCall = deps.socketManager.broadcastToRoom.mock.calls.find((c) => c.arguments[1] === 'spawn_started');
    assert.ok(spawnCall, 'should broadcast spawn_started for queued execution before intent_mode');
    assert.deepEqual(spawnCall.arguments[2], {
      threadId: 't1',
      targetCats: ['codex'],
      invocationId: 'inv-stub',
    });

    const earlyIntentCall = deps.socketManager.broadcastToRoom.mock.calls.find((c) => c.arguments[1] === 'intent_mode');
    assert.equal(earlyIntentCall, undefined, 'intent_mode must stay deferred until the first CLI event');

    releaseFirstEvent();
    await new Promise((r) => setTimeout(r, 50));

    const intentCall = deps.socketManager.broadcastToRoom.mock.calls.find((c) => c.arguments[1] === 'intent_mode');
    assert.ok(intentCall, 'intent_mode should broadcast after the first CLI event');
  });

  it('emits queue_updated(action=completed) after entry is removed from queue', async () => {
    enqueueEntry(deps.queue, { targetCats: ['opus'] });

    const result = await processor.processNext('t1', 'u1');
    assert.equal(result.started, true);

    await new Promise((r) => setTimeout(r, 50));

    const queueUpdates = deps.socketManager.emitToUser.mock.calls
      .filter((c) => c.arguments[1] === 'queue_updated')
      .map((c) => c.arguments[2]);
    const completed = queueUpdates.find((u) => u.action === 'completed');
    assert.ok(completed, 'should emit queue_updated completed after cleanup');
    assert.equal(completed.threadId, 't1');
    assert.deepEqual(completed.queue, [], 'queue snapshot should be empty after processed entry cleanup');
  });

  it('processNext returns started=false when queue empty', async () => {
    const result = await processor.processNext('t1', 'u1');
    assert.equal(result.started, false);
  });

  // ── Mutex ──

  it('concurrent tryExecuteNext on same thread + same cat → only one starts (F108: per-slot mutex)', async () => {
    // Make executeEntry slow
    const slowDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* () {
          await new Promise((r) => setTimeout(r, 100));
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const slowProcessor = new QueueProcessor(slowDeps);

    // Both entries target same cat → same slot key
    enqueueEntry(slowDeps.queue, { content: 'a', targetCats: ['opus'] });
    enqueueEntry(slowDeps.queue, { content: 'b', targetCats: ['opus'] });

    // Fire two processNext concurrently
    const [r1, r2] = await Promise.all([slowProcessor.processNext('t1', 'u1'), slowProcessor.processNext('t1', 'u1')]);

    // One should start, other should not (per-slot mutex)
    const startedCount = [r1, r2].filter((r) => r.started).length;
    assert.equal(startedCount, 1, 'only one should start due to per-slot mutex');
  });

  // ── executeEntry creates InvocationRecord ──

  it('executeEntry creates InvocationRecord with queue idempotency key', async () => {
    const entry = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

    await processor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    const createCalls = deps.invocationRecordStore.create.mock.calls;
    assert.ok(createCalls.length > 0);
    const createArg = createCalls[0].arguments[0];
    assert.ok(createArg.idempotencyKey.startsWith('queue-'));
  });

  it('connector-sourced entry uses connector-${messageId} idempotency key', async () => {
    const entry = enqueueEntry(deps.queue, { source: 'connector' });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-conn-1');

    await processor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    const createCalls = deps.invocationRecordStore.create.mock.calls;
    assert.ok(createCalls.length > 0);
    const createArg = createCalls[0].arguments[0];
    assert.strictEqual(createArg.idempotencyKey, 'connector-msg-conn-1');
  });

  it('copies a queued wait continuation carrier into the exact child InvocationRecord', async () => {
    const waitContinuationCarrier = {
      v: 1,
      waitId: 'task-pr-7',
      outcomeId: 'wait:pr:owner/repo#7:g3:matched',
      ownerFence: { kind: 'containing_task', generation: 3 },
    };
    const entry = enqueueEntry(deps.queue, {
      source: 'connector',
      sourceCategory: 'review',
      waitContinuationCarrier,
    });
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-wait-queued');

    await processor.processNext('t1', 'u1');
    await new Promise((resolve) => setTimeout(resolve, 50));

    const createArg = deps.invocationRecordStore.create.mock.calls[0].arguments[0];
    assert.deepEqual(createArg.waitContinuationCarrier, waitContinuationCarrier);
    assert.deepEqual(createArg.actionLeaseCarrier, { kind: 'none' });
  });

  // ── P1 fix: chain auto-dequeue ──

  it('chain auto-dequeue: entry1 succeed → entry2 auto-starts', async () => {
    deps.router.routeExecution = mock.fn(async function* (_userId, _content, _threadId, _messageId, targetCats) {
      for (const catId of targetCats) {
        yield { type: 'done', catId, timestamp: Date.now() };
      }
    });
    // Enqueue two entries from different users
    const e1 = enqueueEntry(deps.queue, { userId: 'u1', content: 'first', targetCats: ['a'] });
    deps.queue.backfillMessageId('t1', 'u1', e1.id, 'msg-1');
    const e2 = enqueueEntry(deps.queue, { userId: 'u2', content: 'second', targetCats: ['b'] });
    deps.queue.backfillMessageId('t1', 'u2', e2.id, 'msg-2');

    // Trigger first entry via onInvocationComplete('succeeded')
    await processor.onInvocationComplete('t1', 'a', 'succeeded');

    // Wait for both executions to complete (e1 finishes → chains → e2 starts)
    await new Promise((r) => setTimeout(r, 200));

    // Both entries should have been processed (tracker.start called twice)
    assert.ok(
      deps.invocationTracker.startAll.mock.calls.length >= 2,
      `expected >=2 tracker.start calls, got ${deps.invocationTracker.startAll.mock.calls.length}`,
    );
  });

  it('#815: does not consume delivered historical A2A entries outside the current invocation context', async () => {
    const active = enqueueEntry(deps.queue, { targetCats: ['opus'], content: 'current user work' });
    const historicalA2A = enqueueEntry(deps.queue, {
      kind: 'message_wake',
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: ['opus'],
      autoExecute: true,
      content: 'historical handoff',
      messageId: 'historical-a2a-msg',
    });
    deps.messageStore.getById = mock.fn(async (id) => {
      if (id === 'historical-a2a-msg') {
        return { id, deliveryStatus: 'delivered', content: 'historical handoff', mentions: [] };
      }
      return null;
    });

    const processing = deps.queue.markProcessing('t1', 'u1');
    assert.equal(processing.id, active.id);

    const status = await processor.executeEntry(processing);

    assert.equal(status.status, 'succeeded');
    assert.ok(
      deps.queue.list('t1', 'u1').some((entry) => entry.id === historicalA2A.id),
      'historical delivered A2A trigger was not in this invocation context and must stay queued',
    );
  });

  it('uses SessionContinuationCoordinator to prepare context and commit outcome', async () => {
    const routeContents = [];
    const coordinator = {
      prepareInvocationContext: mock.fn(async ({ content }) => ({
        content: `prepared:${content}`,
        sessionPolicy: 'resume',
      })),
      commitInvocationOutcome: mock.fn(async () => {}),
    };
    const coordinatorDeps = stubDeps({
      sessionContinuationCoordinator: coordinator,
      router: {
        routeExecution: mock.fn(async function* (_userId, content) {
          routeContents.push(content);
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const coordinatorProcessor = new QueueProcessor(coordinatorDeps);
    enqueueEntry(coordinatorDeps.queue, { targetCats: ['opus'], content: 'work' });
    const processing = coordinatorDeps.queue.markProcessing('t1', 'u1');

    const status = await coordinatorProcessor.executeEntry(processing);

    assert.equal(status.status, 'succeeded');
    assert.equal(coordinator.prepareInvocationContext.mock.calls.length, 1);
    assert.deepEqual(coordinator.prepareInvocationContext.mock.calls[0].arguments[0], {
      threadId: 't1',
      catId: 'opus',
      userId: 'u1',
      content: 'work',
    });
    assert.deepEqual(routeContents, ['prepared:work']);
    assert.equal(coordinator.commitInvocationOutcome.mock.calls.length, 1);
    assert.equal(coordinator.commitInvocationOutcome.mock.calls[0].arguments[0].finalStatus, 'succeeded');
  });

  it('persists produced continuation even when it was already auto-queued', async () => {
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-queued-produced',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-queued-produced', sessionSeq: 1, reason: 'threshold' },
      },
    );
    const coordinator = {
      prepareInvocationContext: mock.fn(async ({ content }) => ({ content, sessionPolicy: 'resume' })),
      commitInvocationOutcome: mock.fn(async () => {}),
    };
    const coordinatorDeps = stubDeps({
      sessionContinuationCoordinator: coordinator,
      router: {
        routeExecution: mock.fn(async function* () {
          yield {
            type: 'system_info',
            catId: 'opus',
            content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: capsule }),
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const coordinatorProcessor = new QueueProcessor(coordinatorDeps);
    enqueueEntry(coordinatorDeps.queue, { targetCats: ['opus'], content: 'work' });
    const processing = coordinatorDeps.queue.markProcessing('t1', 'u1');

    const status = await coordinatorProcessor.executeEntry(processing);

    assert.equal(status.status, 'succeeded');
    assert.equal(coordinator.commitInvocationOutcome.mock.calls.length, 1);
    const commitInput = coordinator.commitInvocationOutcome.mock.calls[0].arguments[0];
    assert.deepEqual(Array.from(commitInput.producedCapsules ?? []), [capsule]);
    const queuedContinuation = coordinatorDeps.queue
      .list('t1', 'u1')
      .find((entry) => entry.sourceCategory === 'continuation');
    assert.ok(queuedContinuation, 'continuation should still be auto-queued');
  });

  it('deduplicates replayed dispatch-handled continuation capsules by stable disposition identity', async () => {
    const capsule = buildDispatchHandledContinuationCapsule({
      threadId: 't1',
      catId: 'opus',
      invocationId: 'child-dispatch-handled',
      dispositionAt: 2_000,
    });
    processor.continuationWindows.set(
      't1:opus',
      Array.from({ length: 5 }, () => Date.now()),
    );

    const first = await processor.enqueueContinuation({
      threadId: 't1',
      userId: 'u1',
      ownerAuthProvenance: 'strict',
      catId: 'opus',
      capsule,
    });
    const replay = await processor.enqueueContinuation({
      threadId: 't1',
      userId: 'u1',
      ownerAuthProvenance: 'strict',
      catId: 'opus',
      capsule,
    });

    assert.equal(first.outcome, 'enqueued');
    assert.equal(
      processor.continuationWindows.get('t1:opus').length,
      5,
      'dispatch liveness continuation must neither consume nor be suppressed by session-seal rate budget',
    );
    assert.equal(replay.outcome, 'skipped_existing_entry');
    assert.equal(deps.queue.list('t1', 'u1').filter((entry) => entry.sourceCategory === 'continuation').length, 1);
  });

  it('threshold seal capsule in queued execution starts bounded same-cat continuation without pending duplicate', async () => {
    let routeCalls = 0;
    let pendingContinuation = null;
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-first',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-1', sessionSeq: 1, reason: 'threshold' },
      },
    );
    const routeContents = [];
    const sealDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* (_userId, content) {
          routeCalls++;
          routeContents.push(content);
          if (routeCalls === 1) {
            yield {
              type: 'system_info',
              catId: 'opus',
              content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: capsule }),
              timestamp: Date.now(),
            };
          } else {
            yield { type: 'text', catId: 'opus', content: 'continued', timestamp: Date.now() };
          }
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
      threadStore: {
        isRebornSession: mock.fn(async () => false),
        setPendingContinuation: mock.fn(async (_threadId, _catId, _userId, entry) => {
          pendingContinuation = entry;
        }),
        consumePendingContinuation: mock.fn(async () => {
          const pending = pendingContinuation;
          pendingContinuation = null;
          return pending;
        }),
      },
    });
    const sealProcessor = new QueueProcessor(sealDeps);
    enqueueEntry(sealDeps.queue, { targetCats: ['opus'], content: 'initial work' });

    const result = await sealProcessor.processNext('t1', 'u1');
    assert.equal(result.started, true);

    await new Promise((r) => setTimeout(r, 150));

    assert.equal(routeCalls, 2, 'second route call should be the continuation');
    assert.match(routeContents[1], /previous session was sealed/i);
    assert.equal(
      (routeContents[1].match(/Continue the same structured work from the sealed session/g) ?? []).length,
      1,
      'queued continuation must not duplicate the bootstrap prompt',
    );
    assert.equal(
      sealDeps.threadStore.setPendingContinuation.mock.calls.length,
      1,
      'auto-queued continuation must also be persisted as durable pending state',
    );
    assert.equal(
      sealDeps.threadStore.consumePendingContinuation.mock.calls.length,
      2,
      'initial and continuation executions still check pending storage; the queued capsule supplies the continuation',
    );
    assert.ok(sealDeps.invocationTracker.startAll.mock.calls.length >= 2);
  });

  it('threshold seal capsule survives lost in-memory continuation queue entry via pending storage', async () => {
    let routeCalls = 0;
    let pendingContinuation = null;
    const routeContents = [];
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-lost-queue-entry',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-lost-queue-entry', sessionSeq: 1, reason: 'threshold' },
      },
    );
    const sealDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* (_userId, content) {
          routeCalls++;
          routeContents.push(content);
          if (routeCalls === 1) {
            yield {
              type: 'system_info',
              catId: 'opus',
              content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: capsule }),
              timestamp: Date.now(),
            };
          } else {
            yield { type: 'text', catId: 'opus', content: 'resumed from durable pending', timestamp: Date.now() };
          }
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
      threadStore: {
        isRebornSession: mock.fn(async () => false),
        setPendingContinuation: mock.fn(async (_threadId, _catId, _userId, entry) => {
          pendingContinuation = entry;
        }),
        consumePendingContinuation: mock.fn(async () => {
          const pending = pendingContinuation;
          pendingContinuation = null;
          return pending;
        }),
      },
    });
    const sealProcessor = new QueueProcessor(sealDeps);
    enqueueEntry(sealDeps.queue, { targetCats: ['opus'], content: 'initial work' });
    const initialProcessing = sealDeps.queue.markProcessing('t1', 'u1');

    const initialStatus = await sealProcessor.executeEntry(initialProcessing);
    assert.equal(initialStatus.status, 'succeeded');
    assert.equal(sealDeps.threadStore.setPendingContinuation.mock.calls.length, 1);

    const queuedContinuation = sealDeps.queue.list('t1', 'u1').find((entry) => entry.sourceCategory === 'continuation');
    assert.ok(queuedContinuation, 'continuation wake-up entry should be queued before simulated process loss');
    sealDeps.queue.remove('t1', 'u1', queuedContinuation.id);

    enqueueEntry(sealDeps.queue, { targetCats: ['opus'], content: 'follow-up work' });
    const followupProcessing = sealDeps.queue.markProcessing('t1', 'u1');

    const followupStatus = await sealProcessor.executeEntry(followupProcessing);
    assert.equal(followupStatus.status, 'succeeded');
    assert.equal(routeCalls, 2);
    assert.match(routeContents[1], /previous session was sealed/i);
    assert.match(routeContents[1], /follow-up work/);
    assert.equal(
      (routeContents[1].match(/Continue the same structured work from the sealed session/g) ?? []).length,
      1,
      'durable pending restore must inject the continuation prompt exactly once',
    );
  });

  it('threshold seal capsule in queued multi-cat execution resumes the capsule owner cat', async () => {
    let routeCalls = 0;
    const routeTargetCats = [];
    const routeContents = [];
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
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
    const sealDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* (_userId, content, _threadId, _messageId, targetCats) {
          routeCalls++;
          routeContents.push(content);
          routeTargetCats.push([...targetCats]);
          if (routeCalls === 1) {
            yield {
              type: 'system_info',
              catId: 'codex',
              content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: capsule }),
              timestamp: Date.now(),
            };
          } else {
            yield { type: 'text', catId: targetCats[0], content: 'continued', timestamp: Date.now() };
          }
          yield { type: 'done', catId: targetCats[0], timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const sealProcessor = new QueueProcessor(sealDeps);
    enqueueEntry(sealDeps.queue, { targetCats: ['opus', 'codex'], content: 'parallel work' });

    const result = await sealProcessor.processNext('t1', 'u1');
    assert.equal(result.started, true);

    await new Promise((r) => setTimeout(r, 150));

    assert.equal(routeCalls, 2, 'second route call should be the continuation');
    assert.deepEqual(routeTargetCats[0], ['opus', 'codex']);
    assert.deepEqual(routeTargetCats[1], ['codex']);
    assert.match(routeContents[1], /Cat: codex/);
  });

  it('threshold seal capsules in queued multi-cat execution resume every sealed cat', async () => {
    let routeCalls = 0;
    const routeTargetCats = [];
    const opusCapsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
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
        threadId: 't1',
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
    const sealDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* (_userId, _content, _threadId, _messageId, targetCats) {
          routeCalls++;
          routeTargetCats.push([...targetCats]);
          if (routeCalls === 1) {
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
          } else {
            yield { type: 'text', catId: targetCats[0], content: 'continued', timestamp: Date.now() };
          }
          yield { type: 'done', catId: targetCats[0], timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const sealProcessor = new QueueProcessor(sealDeps);
    enqueueEntry(sealDeps.queue, { targetCats: ['opus', 'codex'], content: 'parallel work' });

    const result = await sealProcessor.processNext('t1', 'u1');
    assert.equal(result.started, true);

    await new Promise((r) => setTimeout(r, 250));

    assert.equal(routeCalls, 3, 'both sealed cats should get continuation runs');
    assert.deepEqual(routeTargetCats[0], ['opus', 'codex']);
    assert.deepEqual(
      routeTargetCats.slice(1).sort((a, b) => a[0].localeCompare(b[0])),
      [['codex'], ['opus']],
    );
  });

  it('threshold seal capsule advances its successor without replaying the failed queued carrier', async () => {
    let routeCalls = 0;
    const routeContents = [];
    let pendingContinuation = null;
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-first',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-1', sessionSeq: 1, reason: 'threshold' },
      },
    );
    const failDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* (_userId, content) {
          routeCalls++;
          routeContents.push(content);
          if (routeCalls === 1) {
            yield {
              type: 'system_info',
              catId: 'opus',
              content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: capsule }),
              timestamp: Date.now(),
            };
            throw new Error('route failed after seal notice');
          }
          yield { type: 'text', catId: 'opus', content: 'continued', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
      threadStore: {
        isRebornSession: mock.fn(async () => false),
        setPendingContinuation: mock.fn(async (_threadId, _catId, _userId, entry) => {
          pendingContinuation = entry;
        }),
        consumePendingContinuation: mock.fn(async () => {
          const pending = pendingContinuation;
          pendingContinuation = null;
          return pending;
        }),
      },
    });
    const failProcessor = new QueueProcessor(failDeps);
    enqueueEntry(failDeps.queue, { targetCats: ['opus'], content: 'initial work' });

    const result = await failProcessor.processNext('t1', 'u1');
    assert.equal(result.started, true);

    await new Promise((r) => setTimeout(r, 150));

    assert.equal(routeCalls, 2, 'the sealed successor advances without an ordinary retry of the failed carrier');
    assert.match(routeContents[1], /previous session was sealed/i);
    assert.equal(
      (routeContents[1].match(/Continue the same structured work from the sealed session/g) ?? []).length,
      1,
      'stored pending continuation and queued continuation must not duplicate the bootstrap prompt',
    );
    assert.equal(
      failDeps.queue.list('t1', 'u1').some((candidate) => candidate.content === 'initial work'),
      false,
      'provider admission must not revive the failed carrier identity',
    );
  });

  it('failed continuation dispatches its newly sealed successor without replaying the attempted carrier', async () => {
    const routeContents = [];
    const successorCapsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-successor-seal',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-successor', sessionSeq: 2, reason: 'threshold' },
      },
    );
    const continuationDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* (_userId, content) {
          routeContents.push(content);
          if (routeContents.length === 1) {
            yield {
              type: 'system_info',
              catId: 'opus',
              content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: successorCapsule }),
              timestamp: Date.now(),
            };
            throw new Error('old continuation failed after sealing its successor');
          }
          yield { type: 'text', catId: 'opus', content: 'continued', timestamp: Date.now() };
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const continuationProcessor = new QueueProcessor(continuationDeps);
    const oldContinuation = enqueueEntry(continuationDeps.queue, {
      targetCats: ['opus'],
      content: 'old-continuation',
      source: 'agent',
      sourceCategory: 'continuation',
      autoExecute: true,
      continuationKey: 'old-continuation',
    });

    await continuationProcessor.requestDrain('t1');
    await waitFor(() => routeContents.length === 2);
    await new Promise((resolve) => setTimeout(resolve, 100));

    assert.equal(routeContents[0], 'old-continuation');
    assert.match(routeContents[1], /previous session was sealed/i, 'the exact new successor must dispatch next');
    assert.equal(
      continuationDeps.queue.getEntrySnapshot('t1', 'u1', oldContinuation.id),
      null,
      'the attempted continuation carrier does not return after provider admission',
    );
  });

  it('threshold seal capsule after user stop stores pending but does not auto-run continuation', async () => {
    let routeCalls = 0;
    let pendingContinuation = null;
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-first',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-user-stop', sessionSeq: 1, reason: 'user-stop-after-seal' },
      },
    );
    const stopDeps = stubDeps({
      invocationTracker: {
        start: mock.fn(() => new AbortController()),
        startAll: mock.fn(() => new AbortController()),
        complete: mock.fn(),
        completeAll: mock.fn(),
        completeSlot: mock.fn(),
        has: mock.fn(() => false),
        resolveFinalStatus: mock.fn(() => 'canceled_by_user'),
      },
      router: {
        routeExecution: mock.fn(async function* () {
          routeCalls++;
          if (routeCalls === 1) {
            yield {
              type: 'system_info',
              catId: 'opus',
              content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: capsule }),
              timestamp: Date.now(),
            };
          } else {
            yield { type: 'text', catId: 'opus', content: 'unexpected auto continuation', timestamp: Date.now() };
          }
          yield { type: 'done', catId: 'opus', timestamp: Date.now() };
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
      threadStore: {
        isRebornSession: mock.fn(async () => false),
        setPendingContinuation: mock.fn(async (_threadId, _catId, _userId, entry) => {
          pendingContinuation = entry;
        }),
        consumePendingContinuation: mock.fn(async () => {
          const pending = pendingContinuation;
          pendingContinuation = null;
          return pending;
        }),
      },
    });
    const stopProcessor = new QueueProcessor(stopDeps);
    enqueueEntry(stopDeps.queue, { targetCats: ['opus'], content: 'initial work' });

    const result = await stopProcessor.processNext('t1', 'u1');
    assert.equal(result.started, true);

    await new Promise((r) => setTimeout(r, 150));

    assert.equal(routeCalls, 1, 'user stop must not immediately auto-run the produced continuation');
    assert.equal(
      stopDeps.threadStore.setPendingContinuation.mock.calls.length,
      1,
      'capsule remains available for resume',
    );
    assert.equal(
      stopDeps.queue
        .list('t1', 'u1')
        .some((queued) => queued.sourceCategory === 'continuation' && queued.autoExecute === true),
      false,
      'user-stopped capsule must not be queued as autoExecute continuation',
    );
  });

  it('enqueueContinuation pins seal work ahead of queued user work without dropping either', async () => {
    enqueueEntry(deps.queue, { targetCats: ['opus'], source: 'user', content: 'new user work' });
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-1',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-1', sessionSeq: 1, reason: 'threshold' },
      },
    );

    const outcome = await processor.enqueueContinuation({
      threadId: 't1',
      userId: 'u1',
      ownerAuthProvenance: 'strict',
      catId: 'opus',
      capsule,
    });

    assert.equal(outcome.outcome, 'enqueued');
    const queue = deps.queue.list('t1', 'u1');
    assert.equal(queue.length, 2);
    assert.match(queue[0].content, /Continue the same structured work from the sealed session/);
    assert.equal(queue[0].ownerAuthProvenance, 'strict');
    assert.equal(queue[1].content, 'new user work');
  });

  it('enqueueContinuation rejects a carrier without explicit owner provenance', async () => {
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-missing-provenance',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-missing-provenance', sessionSeq: 1, reason: 'threshold' },
      },
    );

    await assert.rejects(
      () => processor.enqueueContinuation({ threadId: 't1', userId: 'u1', catId: 'opus', capsule }),
      /ownerAuthProvenance must be explicit/,
    );
  });

  it('enqueueContinuation pins seal work ahead of queued agent work without dropping either', async () => {
    const originalNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      enqueueEntry(deps.queue, { targetCats: ['opus'], source: 'agent', content: 'stale queued work' });
      now += 60_000 + 1;
      const capsule = completeCapsuleForSeal(
        buildCapsuleFromRouteState({
          threadId: 't1',
          catId: 'opus',
          mode: 'independent',
          a2aEnabled: true,
        }),
        {
          invocationId: 'inv-stale-queued',
          createdAt: now,
          seal: { sessionId: 'sess-stale-queued', sessionSeq: 1, reason: 'threshold' },
        },
      );

      const outcome = await processor.enqueueContinuation({
        threadId: 't1',
        userId: 'u1',
        ownerAuthProvenance: 'unknown',
        catId: 'opus',
        capsule,
      });

      assert.equal(outcome.outcome, 'enqueued');
      const queue = deps.queue.list('t1', 'u1');
      assert.equal(queue.length, 2);
      assert.match(queue[0].content, /Continue the same structured work from the sealed session/);
      assert.equal(queue[1].content, 'stale queued work', 'old queued agent work must not be dropped');
    } finally {
      Date.now = originalNow;
    }
  });

  it('enqueueContinuation does not retain empty continuation window after skipped duplicate', async () => {
    enqueueEntry(deps.queue, {
      targetCats: ['opus'],
      source: 'agent',
      sourceCategory: 'continuation',
      continuationKey: 't1:opus:inv-duplicate-window:sess-duplicate-window:1',
      content: 'pending continuation work',
    });
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-duplicate-window',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-duplicate-window', sessionSeq: 1, reason: 'threshold' },
      },
    );

    const outcome = await processor.enqueueContinuation({
      threadId: 't1',
      userId: 'u1',
      ownerAuthProvenance: 'unknown',
      catId: 'opus',
      capsule,
    });

    assert.equal(outcome.outcome, 'skipped_existing_entry');
    assert.equal(processor.continuationWindows.has('t1:opus'), false);
  });

  it('enqueueContinuation preserves distinct sealed work while deduping the same seal item', async () => {
    const firstCapsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-first-seal',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-first-seal', sessionSeq: 1, reason: 'threshold' },
      },
    );
    const secondCapsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-second-seal',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-second-seal', sessionSeq: 2, reason: 'threshold' },
      },
    );

    const first = await processor.enqueueContinuation({
      threadId: 't1',
      userId: 'u1',
      ownerAuthProvenance: 'unknown',
      catId: 'opus',
      capsule: firstCapsule,
    });
    const duplicateFirst = await processor.enqueueContinuation({
      threadId: 't1',
      userId: 'u1',
      ownerAuthProvenance: 'unknown',
      catId: 'opus',
      capsule: firstCapsule,
    });
    const second = await processor.enqueueContinuation({
      threadId: 't1',
      userId: 'u1',
      ownerAuthProvenance: 'unknown',
      catId: 'opus',
      capsule: secondCapsule,
    });

    assert.equal(first.outcome, 'enqueued');
    assert.equal(duplicateFirst.outcome, 'skipped_existing_entry');
    assert.equal(second.outcome, 'enqueued');
    assert.equal(deps.queue.list('t1', 'u1').length, 2);
  });

  it('enqueueContinuation pins seal work ahead of old queued user work without dropping either', async () => {
    const originalNow = Date.now;
    let now = 1_500_000;
    Date.now = () => now;
    try {
      enqueueEntry(deps.queue, { targetCats: ['opus'], source: 'user', content: 'old but real user work' });
      now += 60_000 + 1;
      const capsule = completeCapsuleForSeal(
        buildCapsuleFromRouteState({
          threadId: 't1',
          catId: 'opus',
          mode: 'independent',
          a2aEnabled: true,
        }),
        {
          invocationId: 'inv-old-user-work',
          createdAt: now,
          seal: { sessionId: 'sess-old-user-work', sessionSeq: 1, reason: 'threshold' },
        },
      );

      const outcome = await processor.enqueueContinuation({
        threadId: 't1',
        userId: 'u1',
        ownerAuthProvenance: 'unknown',
        catId: 'opus',
        capsule,
      });

      assert.equal(outcome.outcome, 'enqueued');
      const queue = deps.queue.list('t1', 'u1');
      assert.equal(queue.length, 2);
      assert.match(queue[0].content, /Continue the same structured work from the sealed session/);
      assert.equal(queue[1].content, 'old but real user work');
    } finally {
      Date.now = originalNow;
    }
  });

  it('enqueueContinuation ignores stale processing entries when checking existing pending work', async () => {
    const originalNow = Date.now;
    let now = 2_000_000;
    Date.now = () => now;
    try {
      const entry = enqueueEntry(deps.queue, {
        targetCats: ['opus'],
        source: 'agent',
        content: 'stale processing work',
      });
      deps.queue.markProcessingById('t1', entry.id);
      now += InvocationQueue.STALE_PROCESSING_THRESHOLD_MS + 1;
      const capsule = completeCapsuleForSeal(
        buildCapsuleFromRouteState({
          threadId: 't1',
          catId: 'opus',
          mode: 'independent',
          a2aEnabled: true,
        }),
        {
          invocationId: 'inv-stale-processing',
          createdAt: now,
          seal: { sessionId: 'sess-stale-processing', sessionSeq: 1, reason: 'threshold' },
        },
      );

      const outcome = await processor.enqueueContinuation({
        threadId: 't1',
        userId: 'u1',
        ownerAuthProvenance: 'unknown',
        catId: 'opus',
        capsule,
      });

      assert.equal(outcome.outcome, 'enqueued');
      assert.equal(outcome.entry?.targetCats[0], 'opus');
    } finally {
      Date.now = originalNow;
    }
  });

  it('continuation dispatch runs seal continuation first and preserves old queued agent work', async () => {
    const originalNow = Date.now;
    let now = 3_000_000;
    Date.now = () => now;
    const routeContents = [];
    try {
      const dispatchDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* (_userId, content, _threadId, _messageId, targetCats) {
            routeContents.push(content);
            yield { type: 'text', catId: targetCats[0], content: 'ok', timestamp: Date.now() };
            yield { type: 'done', catId: targetCats[0], timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const dispatchProcessor = new QueueProcessor(dispatchDeps);
      enqueueEntry(dispatchDeps.queue, {
        source: 'agent',
        targetCats: ['opus'],
        content: 'old queued handoff',
      });
      now += 60_000 + 1;
      const capsule = completeCapsuleForSeal(
        buildCapsuleFromRouteState({
          threadId: 't1',
          catId: 'opus',
          mode: 'independent',
          a2aEnabled: true,
        }),
        {
          invocationId: 'inv-fresh-continuation',
          createdAt: now,
          seal: { sessionId: 'sess-fresh-continuation', sessionSeq: 1, reason: 'threshold' },
        },
      );

      const outcome = await dispatchProcessor.enqueueContinuation({
        threadId: 't1',
        userId: 'u1',
        ownerAuthProvenance: 'unknown',
        catId: 'opus',
        capsule,
      });
      assert.equal(outcome.outcome, 'enqueued');
      assert.equal(dispatchDeps.queue.list('t1', 'u1').length, 2, 'continuation should wait behind agent work');

      await dispatchProcessor.onInvocationComplete('t1', 'opus', 'succeeded');
      await new Promise((r) => setTimeout(r, 80));

      assert.ok(routeContents.length > 0, 'seal continuation should be dispatched first');
      assert.match(routeContents[0], /Continue the same structured work from the sealed session/);

      await dispatchProcessor.onInvocationComplete('t1', 'opus', 'succeeded');
      await new Promise((r) => setTimeout(r, 80));

      assert.ok(routeContents.length > 1, 'old queued agent work should still dispatch after continuation');
      assert.match(routeContents[1], /old queued handoff/);
    } finally {
      Date.now = originalNow;
    }
  });

  it('enqueueContinuation rate-limits after five continuations per hour for a thread cat', async () => {
    const capsule = completeCapsuleForSeal(
      buildCapsuleFromRouteState({
        threadId: 't1',
        catId: 'opus',
        mode: 'independent',
        a2aEnabled: true,
      }),
      {
        invocationId: 'inv-rate-limit',
        createdAt: Date.now(),
        seal: { sessionId: 'sess-rate-limit', sessionSeq: 1, reason: 'threshold' },
      },
    );

    for (let i = 0; i < 5; i++) {
      const outcome = await processor.enqueueContinuation({
        threadId: 't1',
        userId: 'u1',
        ownerAuthProvenance: 'unknown',
        catId: 'opus',
        capsule,
      });
      assert.equal(outcome.outcome, 'enqueued');
      deps.queue.clear('t1', 'u1');
    }

    const sixth = await processor.enqueueContinuation({
      threadId: 't1',
      userId: 'u1',
      ownerAuthProvenance: 'unknown',
      catId: 'opus',
      capsule,
    });

    assert.equal(sixth.outcome, 'skipped_rate_limited');
    assert.equal(deps.queue.list('t1', 'u1').length, 0);
  });

  // ── #768: intent_mode deferred until CLI is alive ──

  it('#768 regression: intent_mode is NOT broadcast when routeExecution throws before yielding', async () => {
    const failDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* () {
          throw new Error('CLI spawn failed');
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const failProcessor = new QueueProcessor(failDeps);

    enqueueEntry(failDeps.queue);

    await failProcessor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 100));

    const intentCall = failDeps.socketManager.broadcastToRoom.mock.calls.find((c) => c.arguments[1] === 'intent_mode');
    assert.equal(intentCall, undefined, 'intent_mode must NOT be broadcast when CLI fails before producing events');
  });

  it('#768 regression: intent_mode IS broadcast once CLI produces first event', async () => {
    enqueueEntry(deps.queue, { targetCats: ['codex'], intent: 'execute' });

    await processor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    const intentCall = deps.socketManager.broadcastToRoom.mock.calls.find((c) => c.arguments[1] === 'intent_mode');
    assert.ok(intentCall, 'intent_mode should be broadcast after first CLI event');
  });

  it('#768 regression: intent_mode is NOT broadcast when routeExecution yields nothing (empty generator)', async () => {
    const emptyDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* () {
          // Generator completes without yielding any events
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const emptyProcessor = new QueueProcessor(emptyDeps);

    enqueueEntry(emptyDeps.queue);

    await emptyProcessor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 100));

    const intentCall = emptyDeps.socketManager.broadcastToRoom.mock.calls.find((c) => c.arguments[1] === 'intent_mode');
    assert.equal(intentCall, undefined, 'intent_mode must NOT be broadcast when CLI produces zero events');
  });

  // ── P1 fix: executeEntry failure marks InvocationRecord ──

  it('executeEntry failure marks InvocationRecord failed without reviving the admitted carrier', async () => {
    const failDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* () {
          throw new Error('route boom');
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
    });
    const failProcessor = new QueueProcessor(failDeps);

    enqueueEntry(failDeps.queue);

    await failProcessor.processNext('t1', 'u1');
    // Wait for background execution to complete
    await new Promise((r) => setTimeout(r, 100));

    // InvocationRecord should be updated with status='failed'
    const updateCalls = failDeps.invocationRecordStore.update.mock.calls;
    const failedUpdate = updateCalls.find((c) => c.arguments[1]?.status === 'failed');
    assert.ok(failedUpdate, 'should mark InvocationRecord as failed');
    assert.ok(failedUpdate.arguments[1].error, 'should include error message');
    assert.equal(
      failDeps.queue.list('t1', 'u1').length,
      0,
      'a provider-started Queue identity is never restored as pre-admission work',
    );
  });

  it('executeEntry failure CAS-terminalizes a record when the ordinary failed write throws', async () => {
    let recordStatus = 'pending';
    const failDeps = stubDeps({
      router: {
        routeExecution: mock.fn(async function* () {
          throw new Error('route boom');
        }),
        ackCollectedCursors: mock.fn(async () => {}),
      },
      invocationRecordStore: {
        create: mock.fn(async () => ({ outcome: 'created', invocationId: 'inv-backstop' })),
        update: mock.fn(async (_id, patch) => {
          if (patch?.status === 'failed' && patch?.expectedStatus === undefined) {
            throw new Error('Redis blip');
          }
          if (patch?.status) recordStatus = patch.status;
          return { invocationId: 'inv-backstop', status: recordStatus };
        }),
        get: mock.fn(async (id) => (id === 'inv-backstop' ? { invocationId: id, status: recordStatus } : null)),
      },
    });
    const failProcessor = new QueueProcessor(failDeps);

    enqueueEntry(failDeps.queue);

    await failProcessor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 100));

    const updateCalls = failDeps.invocationRecordStore.update.mock.calls;
    assert.ok(
      updateCalls.some(
        (call) => call.arguments[1]?.status === 'failed' && call.arguments[1]?.expectedStatus === undefined,
      ),
      'the ordinary error path should attempt its unguarded failed write',
    );
    assert.ok(
      updateCalls.some(
        (call) => call.arguments[1]?.status === 'failed' && call.arguments[1]?.expectedStatus === 'running',
      ),
      'the finally backstop should CAS running to failed',
    );
    assert.equal(recordStatus, 'failed');
  });

  it('claim-lost loser does not terminalize the winning executor invocation', async () => {
    let recordStatus = 'running';
    const claimLostDeps = stubDeps({
      invocationRecordStore: {
        create: mock.fn(async () => ({ outcome: 'created', invocationId: 'inv-claim-winner' })),
        update: mock.fn(async (_id, patch) => {
          if (patch?.status === 'running' && patch?.expectedStatus === 'queued') {
            return null;
          }
          if (patch?.status) recordStatus = patch.status;
          return { invocationId: 'inv-claim-winner', status: recordStatus };
        }),
        get: mock.fn(async (id) => (id === 'inv-claim-winner' ? { invocationId: id, status: recordStatus } : null)),
      },
    });
    const claimLostProcessor = new QueueProcessor(claimLostDeps);

    enqueueEntry(claimLostDeps.queue);
    const result = await claimLostProcessor.executeEntry(claimLostDeps.queue.markProcessing('t1', 'u1'));

    assert.equal(result.status, 'succeeded');
    assert.equal(claimLostDeps.router.routeExecution.mock.calls.length, 0);
    assert.equal(
      claimLostDeps.invocationRecordStore.update.mock.calls.filter(
        (call) => call.arguments[1]?.status === 'failed' && call.arguments[1]?.expectedStatus === 'running',
      ).length,
      0,
      'the claim-lost loser must leave terminal ownership with the winning executor',
    );
    assert.equal(recordStatus, 'running');
  });

  // ── F039 remaining bugfix: queue execution should include contentBlocks ──

  it('executeEntry passes contentBlocks from messageId to routeExecution', async () => {
    const contentBlocks = [{ type: 'image', url: 'https://example.com/1.png' }];
    const durableStore = new MessageStore();
    const contentDeps = stubDeps({ messageStore: durableStore });
    contentDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
    const contentProcessor = new QueueProcessor(contentDeps);
    const entry = enqueueEntry(contentDeps.queue);
    const message = durableStore.append(
      canonicalTestMessageInput({
        userId: entry.userId,
        catId: null,
        content: entry.content,
        contentBlocks,
        mentions: entry.targetCats,
        timestamp: entry.createdAt,
        threadId: entry.threadId,
        deliveryStatus: 'queued',
        queueCustody: createInitialQueuedMessageCustody(entry),
      }),
    );
    contentDeps.queue.backfillMessageId('t1', 'u1', entry.id, message.id);

    await contentProcessor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(contentDeps.router.routeExecution.mock.calls.length > 0);
    const call = contentDeps.router.routeExecution.mock.calls[0];
    const opts = call.arguments[6];
    assert.ok(opts && typeof opts === 'object', 'expected opts object');
    assert.deepEqual(opts.contentBlocks, contentBlocks);
  });

  it('executeEntry passes explicit A2A trigger id to routeExecution for agent queue entries', async () => {
    enqueueEntry(deps.queue, {
      source: 'agent',
      sourceCategory: 'a2a',
      a2aTriggerMessageId: 'msg-trigger',
    });

    await processor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(deps.router.routeExecution.mock.calls.length > 0);
    const call = deps.router.routeExecution.mock.calls[0];
    const opts = call.arguments[6];
    assert.ok(opts && typeof opts === 'object', 'expected opts object');
    assert.equal(opts.a2aTriggerMessageId, 'msg-trigger');
  });

  it('executeEntry preserves strict owner authentication provenance across queue replay', async () => {
    enqueueEntry(deps.queue, {
      ownerAuthProvenance: 'strict',
    });

    await processor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    const options = deps.router.routeExecution.mock.calls[0].arguments[6];
    assert.equal(options.ownerAuthProvenance, 'strict');
  });

  it('executeEntry binds an exact dispatch carrier independently for every A2A target', async () => {
    enqueueEntry(deps.queue, {
      source: 'agent',
      sourceCategory: 'a2a',
      callerCatId: 'codex-sol',
      targetCats: ['opus', 'codex-terra'],
      a2aTriggerMessageId: 'msg-dispatch',
    });

    await processor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    const opts = deps.router.routeExecution.mock.calls[0].arguments[6];
    assert.equal(opts.a2aTriggerMessageId, 'msg-dispatch');
    assert.equal(opts.a2aCallerCatId, 'codex-sol');
    assert.deepEqual(
      ['opus', 'codex-terra'].map((catId) => opts.turnCustodyWakeForCat(catId)),
      ['opus', 'codex-terra'].map((catId) => ({
        kind: 'structured',
        protocol: 'dispatch',
        subjectKey: 'ball:thread:t1',
        holderCatId: catId,
        handoff: {
          sourceEventId: `route:msg-dispatch:${catId}`,
          messageId: 'msg-dispatch',
          fromCatId: 'codex-sol',
        },
      })),
    );
  });

  it('executeEntry does not pass current user message id as A2A trigger for normal queue entries', async () => {
    enqueueEntry(deps.queue, { source: 'user' });

    await processor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(deps.router.routeExecution.mock.calls.length > 0);
    const call = deps.router.routeExecution.mock.calls[0];
    const opts = call.arguments[6];
    assert.ok(opts && typeof opts === 'object', 'expected opts object');
    assert.equal(opts.a2aTriggerMessageId, undefined);
  });

  it('fails closed before provider admission when the durable source lookup throws', async () => {
    deps.messageStore.getById = mock.fn(async () => {
      throw new Error('redis down');
    });

    const entry = enqueueEntry(deps.queue);
    deps.queue.backfillMessageId('t1', 'u1', entry.id, 'm1');

    await processor.processNext('t1', 'u1');
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(deps.router.routeExecution.mock.calls.length, 0, 'unverified source custody must not reach provider');
    const failedUpdate = deps.invocationRecordStore.update.mock.calls.find((c) => c.arguments[1]?.status === 'failed');
    assert.ok(failedUpdate, 'source-custody failure must terminalize the InvocationRecord');
    assert.ok(deps.log.warn.mock.calls.length > 0, 'source lookup failure should remain diagnosable');
  });

  // ── F108: QueueProcessor slot-aware (AC-A7) ──

  describe('slot-aware mutex and dequeue (F108)', () => {
    it('processing mutex is per-slot: different cats can execute concurrently in same thread', async () => {
      // Enqueue opus and codex entries for same thread
      const e1 = enqueueEntry(deps.queue, { content: 'opus task', targetCats: ['opus'] });
      deps.queue.backfillMessageId('t1', 'u1', e1.id, 'msg-opus');
      const e2 = enqueueEntry(deps.queue, { content: 'codex task', targetCats: ['codex'] });
      deps.queue.backfillMessageId('t1', 'u1', e2.id, 'msg-codex');

      // Complete opus slot → should dequeue opus entry
      await processor.onInvocationComplete('t1', 'opus', 'succeeded');
      await new Promise((r) => setTimeout(r, 50));

      // Now complete codex slot → should dequeue codex entry (not blocked by opus mutex)
      await processor.onInvocationComplete('t1', 'codex', 'succeeded');
      await new Promise((r) => setTimeout(r, 50));

      // Both entries should have been processed
      assert.ok(
        deps.invocationTracker.startAll.mock.calls.length >= 2,
        `expected >=2 tracker.start calls, got ${deps.invocationTracker.startAll.mock.calls.length}`,
      );
    });

    it('releaseSlot is slot-specific', async () => {
      const slowDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            await new Promise((r) => setTimeout(r, 200));
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const slowProcessor = new QueueProcessor(slowDeps);

      // Enqueue opus and codex
      const e1 = enqueueEntry(slowDeps.queue, { content: 'opus slow', targetCats: ['opus'] });
      slowDeps.queue.backfillMessageId('t1', 'u1', e1.id, 'msg-1');
      const e2 = enqueueEntry(slowDeps.queue, { content: 'codex fast', targetCats: ['codex'] });
      slowDeps.queue.backfillMessageId('t1', 'u1', e2.id, 'msg-2');

      // Start opus via processNext — takes mutex for opus slot
      await slowProcessor.processNext('t1', 'u1');

      // Release opus slot — should allow another opus entry to start
      slowProcessor.releaseSlot('t1', 'opus');

      // codex should still be startable (no mutex on codex slot)
      const r2 = await slowProcessor.processNext('t1', 'u1');
      assert.equal(r2.started, true, 'codex entry should start since opus slot was released');
    });

    it('onInvocationComplete requires catId parameter', async () => {
      enqueueEntry(deps.queue);

      // New signature: onInvocationComplete(threadId, catId, status)
      await processor.onInvocationComplete('t1', 'opus', 'succeeded');
      // Should not throw — catId is now required
    });

    it('tryExecuteNextAcrossUsers checks entryCat slot, not just completing cat slot (P1-2)', async () => {
      // Scenario: opus completes, oldest queued entry targets codex, but codex is already running.
      // Bug: code checks completing cat (opus) slot mutex, not the entry's cat (codex).
      // Expected: should NOT start codex entry when codex slot is busy.

      // Make routeExecution hang so codex stays "in progress"
      let resolveCodex;
      deps.router.routeExecution = mock.fn(async function* () {
        await new Promise((r) => {
          resolveCodex = r;
        });
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      });

      enqueueEntry(deps.queue, { targetCats: ['codex'] });

      // Start codex — it hangs (slot is busy)
      await processor.processNext('t1', 'u1');

      // Enqueue another codex entry while the first is still running
      enqueueEntry(deps.queue, { targetCats: ['codex'] });

      // Simulate opus completing — triggers auto-dequeue across users
      // Oldest remaining queued entry is codex, but codex slot is busy
      await processor.onInvocationComplete('t1', 'opus', 'succeeded');
      await new Promise((r) => setTimeout(r, 50));

      // routeExecution should only have been called once (for the first codex entry)
      const routeCalls = deps.router.routeExecution.mock.calls;
      assert.equal(routeCalls.length, 1, `should not double-start codex slot; got ${routeCalls.length} route calls`);

      // Cleanup: resolve the hanging codex execution
      resolveCodex?.();
    });

    it('tryExecuteNextForUser does not leave entry stuck in processing when slot is busy (P1-3)', async () => {
      // Scenario: codex is already running, user sends another message targeting codex.
      // Bug: markProcessing() called before mutex check, entry gets stuck as 'processing'.
      // Expected: entry should remain 'queued' if slot is busy.

      // Make routeExecution hang so codex stays "in progress"
      let resolveCodex;
      deps.router.routeExecution = mock.fn(async function* () {
        await new Promise((r) => {
          resolveCodex = r;
        });
        yield { type: 'done', catId: 'codex', timestamp: Date.now() };
      });

      const entry1 = enqueueEntry(deps.queue, { targetCats: ['codex'] });
      deps.queue.backfillMessageId('t1', 'u1', entry1.id, 'msg-1');

      // Process entry1 — codex slot becomes busy (hangs)
      await processor.processNext('t1', 'u1');

      // Use different intent to prevent auto-merge with entry1
      const entry2res = deps.queue.enqueue(
        canonicalTestQueueInput({
          threadId: 't1',
          userId: 'u1',
          kind: 'conversation_input',
          content: 'second message',
          source: 'user',
          ownerAuthProvenance: 'unknown',
          targetCats: ['codex'],
          intent: 'ideate',
        }),
      );
      const entry2 = entry2res.entry;
      deps.queue.backfillMessageId('t1', 'u1', entry2.id, 'msg-2');

      // Try to process entry2 while codex slot is busy
      const result = await processor.processNext('t1', 'u1');
      assert.equal(result.started, false, 'should not start when slot is busy');

      // Key assertion: entry2 should still be 'queued', not stuck as 'processing'
      const list = deps.queue.list('t1', 'u1');
      const entry2Status = list.find((e) => e.id === entry2.id);
      assert.ok(entry2Status, 'entry2 should still be in queue');
      assert.equal(entry2Status.status, 'queued', 'entry2 should remain queued, not stuck as processing');

      // Cleanup
      resolveCodex?.();
    });

    it('broadcast messages carry invocationId (AC-A8)', async () => {
      enqueueEntry(deps.queue);

      await processor.processNext('t1', 'u1');
      await new Promise((r) => setTimeout(r, 50));

      const broadcastCalls = deps.socketManager.broadcastAgentMessage.mock.calls;
      assert.ok(broadcastCalls.length > 0, 'should have broadcast at least one message');
      const msgArg = broadcastCalls[0].arguments[0];
      assert.equal(msgArg.invocationId, 'inv-stub', 'broadcast message should carry invocationId');
    });
  });

  it('canReleaseSlotForUser rejects foreign tracker and pre-start queue owners', () => {
    const ownershipDeps = stubDeps();
    ownershipDeps.invocationTracker.getUserId = mock.fn(() => null);
    const ownershipProcessor = new QueueProcessor(ownershipDeps);

    const foreignPreStart = enqueueEntry(ownershipDeps.queue, { userId: 'user-b', targetCats: ['opus'] });
    ownershipDeps.queue.markProcessingById('t1', foreignPreStart.id);

    assert.equal(ownershipProcessor.canReleaseSlotForUser('t1', 'opus', 'user-a'), false);
    assert.equal(ownershipProcessor.canReleaseSlotForUser('t1', 'opus', 'user-b'), true);

    ownershipDeps.queue.removeProcessedAcrossUsers('t1', foreignPreStart.id);
    ownershipDeps.invocationTracker.has = mock.fn(() => true);
    ownershipDeps.invocationTracker.getUserId = mock.fn(() => 'user-b');

    assert.equal(ownershipProcessor.canReleaseSlotForUser('t1', 'opus', 'user-a'), false);
    assert.equal(ownershipProcessor.canReleaseSlotForUser('t1', 'opus', 'user-b'), true);
  });

  // ── RFC #1356: event-driven strict Queue drain ──

  describe('requestDrain (RFC #1356 event-driven admission)', () => {
    it('PR7 executes only the eligible sibling from a mixed failed-target carrier', async () => {
      const routedTargetSets = [];
      deps.router.routeExecution = mock.fn(async function* (_userId, _content, _threadId, _messageId, targetCats) {
        routedTargetSets.push([...targetCats]);
        yield { type: 'done', catId: targetCats[0], timestamp: Date.now() };
      });
      processor = new QueueProcessor(deps);
      const mixed = enqueueEntry(deps.queue, {
        targetCats: ['opus', 'codex'],
        source: 'agent',
        sourceCategory: 'a2a',
        autoExecute: true,
      });
      deps.queue.takeQueuedFailedTargetForCatAcrossUsers(
        mixed.threadId,
        'opus',
        'failed-opus',
        new Set([mixed.id]),
        'invocation_failed',
      );

      await processor.requestDrain('t1');

      await waitFor(() => routedTargetSets.length === 1);
      assert.deepEqual(routedTargetSets, [['codex']]);
    });

    it('immediately executes autoExecute entry when target cat slot is free', async () => {
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['opus'],
        autoExecute: true,
        callerCatId: 'codex',
      });

      await processor.requestDrain('t1');
      // Give fire-and-forget a tick
      await new Promise((r) => setTimeout(r, 50));

      assert.ok(deps.invocationTracker.startAll.mock.calls.length > 0, 'should start execution');
    });

    it('does not execute autoExecute entry when target cat slot is busy', async () => {
      // Occupy opus slot
      deps.invocationTracker.has = mock.fn(() => true);
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['opus'],
        autoExecute: true,
        callerCatId: 'codex',
      });

      await processor.requestDrain('t1');
      await new Promise((r) => setTimeout(r, 50));

      // Entry stays queued, not executed
      assert.equal(deps.invocationTracker.startAll.mock.calls.length, 0, 'should not start when slot busy');
      const queued = deps.queue.list('t1', 'system');
      assert.equal(queued.length, 1, 'entry should remain in queue');
      assert.equal(queued[0].status, 'queued', 'entry should still be queued');
    });

    it('drains the strict head independent of legacy autoExecute metadata', async () => {
      enqueueEntry(deps.queue, {
        userId: 'u1',
        source: 'user',
        targetCats: ['opus'],
        // no autoExecute
      });

      await processor.requestDrain('t1');
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(deps.invocationTracker.startAll.mock.calls.length, 1, 'the Queue head must be admitted');
    });

    it('executes old queued autoExecute entries older than threshold when the slot is free', async () => {
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['opus'],
        autoExecute: true,
        callerCatId: 'codex',
      });
      // list() returns shallow-copied array with reference elements — mutating
      // createdAt here reaches the real entry inside the queue (coupling on purpose).
      const queued = deps.queue.list('t1', 'system');
      queued[0].createdAt = Date.now() - 120_000;

      await processor.requestDrain('t1');
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(deps.invocationTracker.startAll.mock.calls.length, 1, 'old autoExecute entry must still start');
      assert.equal(
        deps.queue.list('t1', 'system').length,
        0,
        'old autoExecute entry should be removed after execution',
      );
    });

    it('does not bypass a busy strict head to execute a later free-slot entry', async () => {
      // Entry 1: opus slot busy
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['opus'],
        autoExecute: true,
        callerCatId: 'gemini',
      });
      // Entry 2: codex slot free
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'gemini',
      });

      // Mock: opus is busy, codex is free
      deps.invocationTracker.has = mock.fn((threadId, catId) => catId === 'opus');

      await processor.requestDrain('t1');
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(deps.invocationTracker.startAll.mock.calls.length, 0, 'a busy strict head must block later work');
      assert.equal(deps.queue.list('t1', 'system').filter((entry) => entry.status === 'queued').length, 2);
    });

    it('starts multiple free-slot entries in one drain while comparator order stays unblocked', async () => {
      // Enqueue 3 entries for 3 different cats — all slots free
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['opus'],
        autoExecute: true,
        callerCatId: 'gemini',
      });
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'gemini',
      });
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['gemini'],
        autoExecute: true,
        callerCatId: 'opus',
      });

      await processor.requestDrain('t1');
      await new Promise((r) => setTimeout(r, 100));

      // All 3 should have been started (different cat slots, all free)
      const startCalls = deps.invocationTracker.startAll.mock.calls;
      assert.equal(startCalls.length, 3, 'should start all 3 entries in one call');
      // startAll receives catIds[] as second arg — flatten to get primary cats
      const startedCats = startCalls.map((c) => c.arguments[1][0]);
      assert.ok(startedCats.includes('opus'), 'opus should be started');
      assert.ok(startedCats.includes('codex'), 'codex should be started');
      assert.ok(startedCats.includes('gemini'), 'gemini should be started');
    });
  });

  // ── Tracker guard: prevent duplicate execution for CLI-active cats ──

  describe('tracker guard on completion chain (tryExecuteNextAcrossUsers)', () => {
    it('does NOT start queued entry when target cat has active CLI invocation', async () => {
      // Simulate: opus is running via CLI (tracked in invocationTracker but NOT in processingSlots)
      const entry = enqueueEntry(deps.queue, { targetCats: ['opus'] });
      deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      // invocationTracker reports opus is active (CLI invocation)
      deps.invocationTracker.has = mock.fn((_tid, catId) => catId === 'opus');

      // codex completes → triggers tryExecuteNextAcrossUsers which finds the opus entry
      await processor.onInvocationComplete('t1', 'codex', 'succeeded');
      await new Promise((r) => setTimeout(r, 50));

      // executeEntry must NOT have been called
      assert.equal(
        deps.invocationTracker.startAll.mock.calls.length,
        0,
        'must not call executeEntry (tracker.start not called)',
      );
      assert.equal(deps.router.routeExecution.mock.calls.length, 0, 'must not call routeExecution');

      // Entry must be rolled back to queued (not stuck as processing)
      const queue = deps.queue.list('t1', 'u1');
      assert.equal(queue.length, 1);
      assert.equal(queue[0].status, 'queued', 'entry must rollback to queued');
    });
  });

  describe('tracker guard on processNext (tryExecuteNextForUser)', () => {
    it('does NOT start queued entry when target cat has active CLI invocation', async () => {
      const entry = enqueueEntry(deps.queue, { targetCats: ['opus'] });
      deps.queue.backfillMessageId('t1', 'u1', entry.id, 'msg-1');

      // invocationTracker reports opus is active (CLI invocation)
      deps.invocationTracker.has = mock.fn((_tid, catId) => catId === 'opus');

      const result = await processor.processNext('t1', 'u1');

      assert.equal(result.started, false, 'must not start when tracker has active invocation');
      // executeEntry must NOT have been called
      assert.equal(
        deps.invocationTracker.startAll.mock.calls.length,
        0,
        'must not call executeEntry (tracker.start not called)',
      );
      assert.equal(deps.router.routeExecution.mock.calls.length, 0, 'must not call routeExecution');

      // Entry must still be queued (never marked processing since guard fires before markProcessing)
      const queue = deps.queue.list('t1', 'u1');
      assert.equal(queue.length, 1);
      assert.equal(queue[0].status, 'queued', 'entry must remain queued');
    });
  });

  // ── F088 fix: OutboundDeliveryHook regression tests ──

  describe('outbound delivery via QueueProcessor (F088)', () => {
    /** Poll until predicate returns true or timeout (deterministic, no fixed sleeps). */
    async function waitFor(predicate, timeoutMs = 5000, intervalMs = 10) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }

    it('single-cat execution: outboundHook.deliver called once with correct catId + content', async () => {
      const deliverCalls = [];
      const outboundHook = {
        deliver: mock.fn(async (threadId, content, catId, richBlocks, threadMeta) => {
          deliverCalls.push({ threadId, content, catId, richBlocks, threadMeta });
        }),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };
      const threadMetaLookup = mock.fn(async () => ({
        threadShortId: 't1-short',
        threadTitle: 'Test Thread',
        deepLinkUrl: 'https://example.com/threads/t1',
      }));

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: 'Hello from opus', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        threadMetaLookup,
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue);

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => deliverCalls.length >= 1);

      assert.equal(deliverCalls.length, 1, 'deliver should be called once for single-cat execution');
      assert.equal(deliverCalls[0].threadId, 't1');
      assert.equal(deliverCalls[0].catId, 'opus');
      assert.equal(deliverCalls[0].content, 'Hello from opus');
      assert.ok(deliverCalls[0].threadMeta, 'threadMeta should be provided');
      assert.equal(deliverCalls[0].threadMeta.threadTitle, 'Test Thread');

      assert.ok(streamingHook.onStreamStart.mock.calls.length >= 1, 'onStreamStart should be called');
      assert.ok(streamingHook.onStreamEnd.mock.calls.length >= 1, 'onStreamEnd should be called');

      await waitFor(() => streamingHook.cleanupPlaceholders.mock.calls.length >= 1);
      assert.ok(
        streamingHook.cleanupPlaceholders.mock.calls.length >= 1,
        'cleanupPlaceholders should be called on successful delivery',
      );
    });

    it('F254 Phase E: a superseded queued draft keeps the catch placeholder and sends no fallback answer', async () => {
      const outboundHook = { deliver: mock.fn(async () => {}) };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
        onClosureBlocked: mock.fn(async () => {}),
      };
      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* (_userId, _content, _threadId, _messageId, _cats, _intent, options) {
            yield { type: 'text', catId: 'opus', content: 'known-stale answer', timestamp: Date.now() };
            options.persistenceContext.outputCommitDecisions = {
              opus: {
                kind: 'superseded_positive_stale',
                closureId: 'closure-1',
                requiredFrontierMessageId: 'msg-newer',
              },
            };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
      });
      const hookProcessor = new QueueProcessor(hookDeps);
      enqueueEntry(hookDeps.queue);

      await hookProcessor.processNext('t1', 'u1');
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(outboundHook.deliver.mock.calls.length, 0);
      assert.equal(streamingHook.cleanupPlaceholders.mock.calls.length, 0);
      assert.equal(streamingHook.onClosureBlocked.mock.calls.length, 0);
    });

    it('ADR-042 delivers a queued published-with-unseen answer instead of a catching-up placeholder', async () => {
      const outboundHook = { deliver: mock.fn(async () => {}) };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
        onClosureCatchingUp: mock.fn(async () => {}),
      };
      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* (_userId, _content, _threadId, _messageId, _cats, _intent, options) {
            yield { type: 'text', catId: 'opus', content: 'published answer', timestamp: Date.now() };
            options.persistenceContext.outputCommitDecisions = {
              opus: {
                kind: 'published_with_unseen',
                messageId: 'msg-published',
                lineageId: 'msg-published',
                offeredSupplementId: 'f254-supplement:msg-published:1',
                requiredFrontierMessageId: 'msg-newer',
              },
            };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
      });
      const hookProcessor = new QueueProcessor(hookDeps);
      enqueueEntry(hookDeps.queue);

      await hookProcessor.processNext('t1', 'u1');
      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(outboundHook.deliver.mock.calls.length, 1);
      assert.equal(outboundHook.deliver.mock.calls[0].arguments[1], 'published answer');
      assert.ok(streamingHook.onStreamEnd.mock.calls.length >= 1);
      assert.ok(streamingHook.cleanupPlaceholders.mock.calls.length >= 1);
      assert.equal(streamingHook.onClosureCatchingUp.mock.calls.length, 0);
    });

    it('F254 Phase E: attributes connector closure projections to the decision owner cat', async () => {
      const scenarios = [
        {
          decision: {
            kind: 'superseded_positive_stale',
            closureId: 'closure-codex-stale',
            requiredFrontierMessageId: 'msg-newer',
          },
          expectedHook: 'onClosureCatchingUp',
        },
        {
          decision: {
            kind: 'blocked_known_closure',
            closureId: 'closure-codex-blocked',
            reason: 'provider_failure',
          },
          expectedHook: 'onClosureBlocked',
        },
      ];

      for (const scenario of scenarios) {
        const streamingHook = {
          onStreamStart: mock.fn(async () => {}),
          onStreamChunk: mock.fn(async () => {}),
          onStreamEnd: mock.fn(async () => {}),
          cleanupPlaceholders: mock.fn(async () => {}),
          onClosureCatchingUp: mock.fn(async () => {}),
          onClosureBlocked: mock.fn(async () => {}),
        };
        const hookDeps = stubDeps({
          router: {
            routeExecution: mock.fn(
              async function* (_userId, _content, _threadId, _messageId, _cats, _intent, options) {
                yield { type: 'text', catId: 'opus', content: 'primary answer', timestamp: Date.now() };
                yield { type: 'done', catId: 'opus', timestamp: Date.now() };
                yield { type: 'text', catId: 'codex', content: 'non-primary stale answer', timestamp: Date.now() };
                options.persistenceContext.outputCommitDecisions = { codex: scenario.decision };
                yield { type: 'done', catId: 'codex', timestamp: Date.now() };
              },
            ),
            ackCollectedCursors: mock.fn(async () => {}),
          },
          streamingHook,
        });
        const hookProcessor = new QueueProcessor(hookDeps);
        enqueueEntry(hookDeps.queue, { targetCats: ['opus', 'codex'] });
        const processing = hookDeps.queue.markProcessing('t1', 'u1');

        await hookProcessor.executeEntry(processing);

        const projectionCall = streamingHook[scenario.expectedHook].mock.calls[0];
        assert.ok(projectionCall, `${scenario.expectedHook} should be called`);
        assert.equal(projectionCall.arguments[1], 'codex', 'projection must be parked under the closure owner');
      }
    });

    it('F254 Phase E: filtered stale turns keep original delivery indexes', async () => {
      const deliverCalls = [];
      const outboundHook = {
        deliver: mock.fn(async (threadId, content, catId) => {
          deliverCalls.push({ threadId, content, catId });
        }),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
        onClosureCatchingUp: mock.fn(async () => {}),
      };
      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* (_userId, _content, _threadId, _messageId, _cats, _intent, options) {
            yield { type: 'text', catId: 'opus', content: 'known-stale answer', timestamp: Date.now() };
            options.persistenceContext.outputCommitDecisions = {
              opus: {
                kind: 'superseded_positive_stale',
                closureId: 'closure-opus-stale',
                requiredFrontierMessageId: 'msg-newer',
              },
            };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
            yield { type: 'text', catId: 'codex', content: 'fresh answer', timestamp: Date.now() };
            yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);
      enqueueEntry(hookDeps.queue, { targetCats: ['opus', 'codex'] });
      const processing = hookDeps.queue.markProcessing('t1', 'u1');

      await hookProcessor.executeEntry(processing);

      assert.deepEqual(deliverCalls, [{ threadId: 't1', content: 'fresh answer', catId: 'codex' }]);
    });

    it('replace-mode text overwrites server-side aggregated outbound and streaming content', async () => {
      const deliverCalls = [];
      const outboundHook = {
        deliver: mock.fn(async (threadId, content, catId) => {
          deliverCalls.push({ threadId, content, catId });
        }),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: '第一段。第二段。', timestamp: Date.now() };
            yield {
              type: 'text',
              catId: 'opus',
              content: '第一段。插入一句。第二段。',
              textMode: 'replace',
              timestamp: Date.now(),
            };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue);

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => deliverCalls.length >= 1);

      assert.equal(deliverCalls[0].content, '第一段。插入一句。第二段。');
      const lastChunkCall = streamingHook.onStreamChunk.mock.calls.at(-1);
      assert.ok(lastChunkCall, 'streaming hook should receive chunks');
      assert.equal(lastChunkCall.arguments[1], '第一段。插入一句。第二段。');
      const endCall = streamingHook.onStreamEnd.mock.calls.at(-1);
      assert.ok(endCall, 'streaming hook should receive final end');
      assert.equal(endCall.arguments[1], '第一段。插入一句。第二段。');
    });

    it('multi-cat execution: outboundHook.deliver called per-turn with each catId', async () => {
      const deliverCalls = [];
      const outboundHook = {
        deliver: mock.fn(async (threadId, content, catId, richBlocks, threadMeta) => {
          deliverCalls.push({ threadId, content, catId, richBlocks, threadMeta });
        }),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: 'Opus says hi. ', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
            yield { type: 'text', catId: 'codex', content: 'Codex chimes in.', timestamp: Date.now() };
            yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue, { targetCats: ['opus'] });

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => deliverCalls.length >= 2);

      assert.equal(deliverCalls.length, 2, 'deliver should be called once per cat turn');
      assert.equal(deliverCalls[0].catId, 'opus', 'first deliver should be for opus');
      assert.equal(deliverCalls[0].content, 'Opus says hi. ', 'opus content should match');
      assert.equal(deliverCalls[1].catId, 'codex', 'second deliver should be for codex');
      assert.equal(deliverCalls[1].content, 'Codex chimes in.', 'codex content should match');
    });

    it('BUG-5: multi-turn delivers per-turn (no merge needed, token reusable)', async () => {
      const deliverCalls = [];
      const outboundHook = {
        deliver: mock.fn(async (threadId, content, catId) => {
          deliverCalls.push({ threadId, content, catId });
        }),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: 'Opus says hi. ', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
            yield { type: 'text', catId: 'codex', content: 'Codex chimes in.', timestamp: Date.now() };
            yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue, { targetCats: ['opus'] });

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => deliverCalls.length >= 2);

      assert.equal(deliverCalls.length, 2, 'Multi-turn delivers per-turn');
      assert.strictEqual(deliverCalls[0].catId, 'opus');
      assert.ok(deliverCalls[0].content.includes('Opus says hi.'));
      assert.strictEqual(deliverCalls[1].catId, 'codex');
      assert.ok(deliverCalls[1].content.includes('Codex chimes in.'));
    });

    it('no outboundHook: execution completes normally without delivery', async () => {
      enqueueEntry(deps.queue);

      await processor.processNext('t1', 'u1');
      await waitFor(() =>
        deps.invocationRecordStore.update.mock.calls.some((c) => c.arguments[1]?.status === 'succeeded'),
      );

      const updateCalls = deps.invocationRecordStore.update.mock.calls;
      const succeededUpdate = updateCalls.find((c) => c.arguments[1]?.status === 'succeeded');
      assert.ok(succeededUpdate, 'should succeed even without outboundHook');
    });

    it('delivery failure: cleanupPlaceholders is NOT called after hard delivery failure (R5-P1)', async () => {
      // R5-P1 design: when delivery fails, placeholder is preserved as fallback indicator
      // for the next retry/invocation. Cleanup must NOT run on failure.
      // F151: mid-loop delivery retries failed turns in the final phase,
      // so use catId-based failure to ensure opus consistently fails.
      const outboundHook = {
        deliver: mock.fn(async (_threadId, _content, catId) => {
          if (catId === 'opus') throw new Error('delivery failed');
        }),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: 'Turn 1. ', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
            yield { type: 'text', catId: 'codex', content: 'Turn 2.', timestamp: Date.now() };
            yield { type: 'done', catId: 'codex', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue, { targetCats: ['opus'] });

      await hookProcessor.processNext('t1', 'u1');
      // F151: mid-loop delivers both, opus fails and retries in final phase = 3 calls total
      await waitFor(() => outboundHook.deliver.mock.calls.length >= 3);

      assert.equal(outboundHook.deliver.mock.calls.length, 3, 'mid-loop (2) + final-phase retry (1)');

      // Settle any pending allSettled callbacks
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(
        streamingHook.cleanupPlaceholders.mock.calls.length,
        0,
        'cleanupPlaceholders must NOT be called when delivery fails (R5-P1: preserve placeholder as fallback)',
      );
    });

    it('all deliveries succeed: cleanupPlaceholders called', async () => {
      const outboundHook = {
        deliver: mock.fn(async () => {}),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: 'Success text', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue);

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => streamingHook.cleanupPlaceholders.mock.calls.length >= 1);

      assert.equal(outboundHook.deliver.mock.calls.length, 1, 'deliver called once');
      assert.ok(
        streamingHook.cleanupPlaceholders.mock.calls.length >= 1,
        'cleanupPlaceholders should be called when all deliveries succeed',
      );
    });

    it('governance-blocked failure cleans up streaming placeholders', async () => {
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield {
              type: 'system_info',
              catId: 'opus',
              content: JSON.stringify({
                type: 'governance_blocked',
                projectPath: '/home/user/projects/EchoAgent',
                reasonKind: 'needs_bootstrap',
                invocationId: 'inv-stub',
              }),
              timestamp: Date.now(),
            };
            yield {
              type: 'done',
              catId: 'opus',
              timestamp: Date.now(),
              errorCode: 'GOVERNANCE_BOOTSTRAP_REQUIRED',
            };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        streamingHook,
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue);

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => streamingHook.cleanupPlaceholders.mock.calls.length >= 1);

      assert.ok(streamingHook.onStreamStart.mock.calls.length >= 1, 'onStreamStart should be called');
      assert.ok(
        streamingHook.onStreamEnd.mock.calls.length >= 1,
        'governance failure should finalize the streaming session',
      );
      assert.equal(
        streamingHook.cleanupPlaceholders.mock.calls.length,
        1,
        'governance failure should clean up the streaming placeholder exactly once',
      );
    });

    it('outboundHook set via late-bind setOutboundHook: deliver is called', async () => {
      const lateDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'text', catId: 'opus', content: 'Late-bound delivery', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const lateProcessor = new QueueProcessor(lateDeps);

      const deliverCalls = [];
      lateProcessor.setOutboundHook({
        deliver: mock.fn(async (threadId, content, catId) => {
          deliverCalls.push({ threadId, content, catId });
        }),
      });

      const entry = enqueueEntry(lateDeps.queue);

      await lateProcessor.processNext('t1', 'u1');
      await waitFor(() => deliverCalls.length >= 1);

      assert.equal(deliverCalls.length, 1, 'late-bound hook should be called');
      assert.equal(deliverCalls[0].content, 'Late-bound delivery');
    });

    it('P2-1 regression: failed invocation still triggers notifyDeliveryBatchDone', async () => {
      const batchDoneCalls = [];
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
        notifyDeliveryBatchDone: mock.fn(async (threadId, chainDone) => {
          batchDoneCalls.push({ threadId, chainDone });
        }),
      };

      const hookDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            throw new Error('invocation crashed');
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const hookProcessor = new QueueProcessor(hookDeps);

      const entry = enqueueEntry(hookDeps.queue);

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => batchDoneCalls.length >= 1);

      assert.equal(batchDoneCalls.length, 1, 'notifyDeliveryBatchDone must fire on failure');
      assert.equal(batchDoneCalls[0].threadId, 't1');
      assert.equal(
        batchDoneCalls[0].chainDone,
        true,
        'provider-admitted work is terminal and does not keep the Queue delivery chain open',
      );
    });

    it('P2: reject callback clears every admitted batch member and still signals completion', async () => {
      const batchDoneCalls = [];
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
        notifyDeliveryBatchDone: mock.fn(async (threadId, chainDone) => {
          batchDoneCalls.push({ threadId, chainDone });
        }),
      };

      // Make invocationTracker.completeAll throw before durable settlement in finally → executeEntry rejects.
      const durableStore = new MessageStore();
      const hookDeps = stubDeps({
        messageStore: durableStore,
        invocationTracker: {
          start: mock.fn(() => new AbortController()),
          startAll: mock.fn(() => new AbortController()),
          completeAll: mock.fn(() => {
            throw new Error('tracker.complete crashed');
          }),
          has: mock.fn(() => false),
        },
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        streamingHook,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      hookDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: durableStore });
      const hookProcessor = new QueueProcessor(hookDeps);

      const { entry: first } = enqueueCustodiedEntry(hookDeps.queue, durableStore, {
        content: 'batch-a',
        ownerAuthProvenance: 'strict',
      });
      const { entry: second } = enqueueCustodiedEntry(hookDeps.queue, durableStore, {
        content: 'batch-b',
        ownerAuthProvenance: 'strict',
      });
      const reserved = hookDeps.queue.reserveExactUserBatch('t1', 'u1', [first.id, second.id]);
      assert.equal(reserved.outcome, 'reserved');
      assert.equal(hookDeps.queue.beginExactSteerPreemption('t1', 'u1', reserved.reservationId), true);
      assert.equal(hookDeps.queue.activateExactSteerReservation('t1', 'u1', reserved.reservationId), true);

      await hookProcessor.processNext('t1', 'u1');
      await waitFor(() => batchDoneCalls.length >= 1);

      assert.equal(batchDoneCalls.length, 1, 'reject callback must also fire notifyDeliveryBatchDone');
      assert.equal(batchDoneCalls[0].threadId, 't1');
      assert.equal(
        hookProcessor.admittedEntries.size,
        0,
        'reject callback must release every admitted batch member, not only the primary entry',
      );
    });
  });

  describe('failure streaming cleanup ordering', () => {
    it('waits for stream start before ending the stream and cleaning placeholders', async () => {
      const order = [];
      let resolveStreamStart;
      const streamStartPromise = new Promise((resolve) => {
        resolveStreamStart = () => {
          order.push('stream-started');
          resolve();
        };
      });
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {
          order.push('stream-ended');
        }),
        cleanupPlaceholders: mock.fn(async () => {
          order.push('placeholders-cleaned');
        }),
      };
      const hookDeps = stubDeps({ streamingHook });
      const hookProcessor = new QueueProcessor(hookDeps);

      const cleanup = hookProcessor.cleanupStreamingOnFailure(
        't1',
        'inv-stream-order',
        streamStartPromise,
        hookDeps.log,
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(order, [], 'stream end must not race ahead of the pending stream start');

      resolveStreamStart();
      await cleanup;

      assert.deepEqual(order, ['stream-started', 'stream-ended', 'placeholders-cleaned']);
      assert.deepEqual(streamingHook.onStreamEnd.mock.calls[0].arguments, ['t1', '', 'inv-stream-order']);
      assert.deepEqual(streamingHook.cleanupPlaceholders.mock.calls[0].arguments, ['t1', 'inv-stream-order']);
    });

    it('contains stream-end cleanup failures without rejecting the Queue failure path', async () => {
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {
          throw new Error('stream end failed');
        }),
        cleanupPlaceholders: mock.fn(async () => {}),
      };
      const hookDeps = stubDeps({ streamingHook });
      const hookProcessor = new QueueProcessor(hookDeps);

      await assert.doesNotReject(() =>
        hookProcessor.cleanupStreamingOnFailure('t1', 'inv-stream-error', Promise.resolve(), hookDeps.log),
      );

      assert.equal(hookDeps.log.warn.mock.calls.length, 1);
      assert.equal(streamingHook.cleanupPlaceholders.mock.calls.length, 0);
    });
  });

  // ── R7: silent fallback late-success/failure cleanup ──

  describe('silent fallback late-success cleanup (R7)', () => {
    /** Poll until predicate returns true or timeout. */
    async function waitFor(predicate, timeoutMs = 5000, intervalMs = 10) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (predicate()) return;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }

    it('silent fallback timeout + late-success → cleanupPlaceholders called', async () => {
      // Silent invocation (only done, no text) → deliver times out → deliver
      // later succeeds → cleanupPlaceholders must be called on late-success.
      let resolveDeliver;
      const deliverGate = new Promise((r) => {
        resolveDeliver = r;
      });
      const outboundHook = {
        deliver: mock.fn(async () => {
          await deliverGate;
        }),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };

      // Silent router: only yields done, no text content.
      // deliverTimeoutMs: 50 — short timeout so test doesn't wait 10s.
      const silentDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'done', catId: 'opus', content: '', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        deliverTimeoutMs: 50,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const silentProcessor = new QueueProcessor(silentDeps);

      const entry = enqueueEntry(silentDeps.queue);

      await silentProcessor.processNext('t1', 'u1');

      // Timeout (50ms) has already fired; deliver still hanging on deliverGate
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(
        streamingHook.cleanupPlaceholders.mock.calls.length,
        0,
        'cleanup must NOT run immediately after silent timeout',
      );

      // Late-success: deliver finally resolves
      resolveDeliver();
      await waitFor(() => streamingHook.cleanupPlaceholders.mock.calls.length >= 1);
      assert.equal(
        streamingHook.cleanupPlaceholders.mock.calls.length,
        1,
        'cleanup must run after silent late-success delivery (R7)',
      );
    });

    it('silent fallback timeout + late-failure → cleanupPlaceholders NOT called', async () => {
      // Silent invocation → deliver times out → deliver later rejects
      // → cleanupPlaceholders must NOT be called (thinking card stays).
      let rejectDeliver;
      const deliverGate = new Promise((_, rej) => {
        rejectDeliver = rej;
      });
      const outboundHook = {
        deliver: mock.fn(async () => {
          await deliverGate;
        }),
      };
      const streamingHook = {
        onStreamStart: mock.fn(async () => {}),
        onStreamChunk: mock.fn(async () => {}),
        onStreamEnd: mock.fn(async () => {}),
        cleanupPlaceholders: mock.fn(async () => {}),
      };

      const silentDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            yield { type: 'done', catId: 'opus', content: '', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
        outboundHook,
        streamingHook,
        deliverTimeoutMs: 50,
        threadMetaLookup: mock.fn(async () => undefined),
      });
      const silentProcessor = new QueueProcessor(silentDeps);

      const entry = enqueueEntry(silentDeps.queue);

      await silentProcessor.processNext('t1', 'u1');

      // Timeout (50ms) has already fired; deliver still hanging on deliverGate
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(streamingHook.cleanupPlaceholders.mock.calls.length, 0, 'cleanup must NOT run after silent timeout');

      // Late-failure: deliver rejects
      rejectDeliver(new Error('connector down'));
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(
        streamingHook.cleanupPlaceholders.mock.calls.length,
        0,
        'cleanup must NOT run after silent hard failure (R7: preserve placeholder)',
      );
    });
  });

  // ── F175 Task 5: user-message batching at dequeue ──

  describe('user-message batching (F175)', () => {
    async function waitForQueue(queue, threadId, userId, predicate, timeoutMs = 2000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (predicate(queue.list(threadId, userId))) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`waitForQueue timed out after ${timeoutMs}ms`);
    }

    it('combines adjacent user entries into single routeExecution call', async () => {
      enqueueEntry(deps.queue, { content: 'msg-a' });
      enqueueEntry(deps.queue, { content: 'msg-b' });
      enqueueEntry(deps.queue, { content: 'msg-c' });

      await processor.processNext('t1', 'u1');
      await waitForQueue(deps.queue, 't1', 'u1', (q) => deps.router.routeExecution.mock.calls.length >= 1);

      assert.equal(deps.router.routeExecution.mock.calls.length, 1, 'should call routeExecution once');
      const calledContent = deps.router.routeExecution.mock.calls[0].arguments[1];
      assert.equal(calledContent, 'msg-a\nmsg-b\nmsg-c', 'content should be combined');
    });

    it('keeps a targetless public head in front of later explicit work while the thread is active', async () => {
      let threadActive = true;
      const targetlessDeps = stubDeps({
        invocationTracker: {
          start: mock.fn(() => new AbortController()),
          startAll: mock.fn(() => new AbortController()),
          complete: mock.fn(),
          completeAll: mock.fn(),
          has: mock.fn(() => threadActive),
        },
      });
      const targetlessProcessor = new QueueProcessor(targetlessDeps);
      const targetless = enqueueEntry(targetlessDeps.queue, { content: 'continue', targetCats: [] });
      const explicit = enqueueEntry(targetlessDeps.queue, { content: 'later explicit', targetCats: ['opus'] });

      await targetlessProcessor.requestDrain('t1');

      assert.equal(targetlessDeps.router.routeExecution.mock.calls.length, 0);
      assert.equal(targetlessDeps.queue.getEntrySnapshot('t1', 'u1', targetless.id)?.status, 'queued');
      assert.equal(targetlessDeps.queue.getEntrySnapshot('t1', 'u1', explicit.id)?.status, 'queued');

      threadActive = false;
      await targetlessProcessor.requestDrain('t1');
      await waitForQueue(
        targetlessDeps.queue,
        't1',
        'u1',
        () => targetlessDeps.router.routeExecution.mock.calls.length >= 1,
      );

      assert.equal(targetlessDeps.router.routeExecution.mock.calls[0].arguments[1], 'continue');
      assert.deepEqual(targetlessDeps.router.routeExecution.mock.calls[0].arguments[4], ['opus']);
    });

    it('shares one admission snapshot across adjacent targetless inputs without absorbing explicit work', async () => {
      enqueueEntry(deps.queue, { content: 'targetless-a', targetCats: [] });
      enqueueEntry(deps.queue, { content: 'targetless-b', targetCats: [] });
      enqueueEntry(deps.queue, { content: 'explicit-c', targetCats: ['opus'] });

      await processor.requestDrain('t1');
      await waitForQueue(deps.queue, 't1', 'u1', () => deps.router.routeExecution.mock.calls.length >= 1);

      const targetlessResolutions = deps.router.resolveConversationTargetsAtAdmission.mock.calls.filter(
        (call) => call.arguments[0].length === 0,
      );
      assert.equal(targetlessResolutions.length, 1);
      assert.equal(deps.router.routeExecution.mock.calls[0].arguments[1], 'targetless-a\ntargetless-b');
      assert.deepEqual(deps.router.routeExecution.mock.calls[0].arguments[4], ['opus']);
    });

    it('terminalizes a targetless public head when admission resolves no available target', async () => {
      const durableStore = new MessageStore();
      const unavailableDeps = stubDeps({
        messageStore: durableStore,
        router: {
          resolveConversationTargetsAtAdmission: mock.fn(async () => []),
        },
      });
      unavailableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({
        messageStore: durableStore,
      });
      const unavailableProcessor = new QueueProcessor(unavailableDeps);
      const { entry, message } = enqueueCustodiedEntry(unavailableDeps.queue, durableStore, {
        content: 'targetless input',
        targetCats: [],
      });

      await unavailableProcessor.requestDrain('t1');

      assert.equal(unavailableDeps.router.routeExecution.mock.calls.length, 0);
      assert.equal(unavailableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id), null);
      const publishedInput = durableStore.getById(message.id);
      assert.equal(publishedInput.deliveryStatus, 'delivered');
      assert.equal(publishedInput.queueCustody, undefined);
      assert.equal(publishedInput.lifecycle.kind, 'input');
      const failure = durableStore.getByIdempotencyKey(
        'system',
        't1',
        `message-lifecycle:pre-admission-failure:${entry.id}`,
      );
      assert.equal(failure.lifecycle.kind, 'delivery_failure');
      assert.equal(failure.lifecycle.reason, 'no_available_target');
      assert.equal(failure.lifecycle.inputMessageId, message.id);
      assert.deepEqual(failure.lifecycle.requestedTargets, []);
    });

    it('terminalizes an unavailable message wake without selecting a fallback member', async () => {
      const durableStore = new MessageStore();
      const unavailableDeps = stubDeps({
        messageStore: durableStore,
        router: {
          resolveExplicitTargets: mock.fn(async () => []),
        },
      });
      unavailableDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({
        messageStore: durableStore,
      });
      const unavailableProcessor = new QueueProcessor(unavailableDeps);
      const entry = enqueueEntry(unavailableDeps.queue, {
        kind: 'message_wake',
        source: 'agent',
        sourceCategory: 'a2a',
        a2aTriggerMessageId: 'wake-source-trigger',
        content: 'wake exact target only',
      });
      const siblingEntry = {
        ...structuredClone(entry),
        id: `${entry.id}:codex`,
        targetCats: ['codex'],
        allTargetCats: ['codex'],
      };
      const message = durableStore.append(
        canonicalTestMessageInput({
          userId: entry.userId,
          threadId: entry.threadId,
          catId: 'codex',
          content: entry.content,
          mentions: entry.targetCats,
          timestamp: entry.createdAt,
          origin: 'callback',
        }),
      );
      const initialized = durableStore.initializeQueueCustody(
        message.id,
        createInitialFanoutQueuedMessageCustody(message.id, [entry, siblingEntry]),
      );
      assert.equal(initialized.kind, 'initialized');
      unavailableDeps.queue.backfillMessageId(entry.threadId, entry.userId, entry.id, message.id);

      await unavailableProcessor.requestDrain('t1');

      assert.equal(unavailableDeps.router.routeExecution.mock.calls.length, 0);
      assert.equal(unavailableDeps.router.resolveConversationTargetsAtAdmission.mock.calls.length, 0);
      assert.equal(unavailableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id), null);
      const publishedSource = durableStore.getById(message.id);
      assert.equal(publishedSource.deliveryStatus, undefined);
      assert.deepEqual(publishedSource.queueCustody.pendingTargetCats, ['codex']);
      assert.deepEqual(publishedSource.queueCustody.failedByCatIds, ['opus']);
      assert.equal(publishedSource.queueCustody.status, 'queued');
      const failure = durableStore.getByIdempotencyKey(
        'system',
        't1',
        `message-lifecycle:pre-admission-failure:${entry.id}`,
      );
      assert.equal(failure.lifecycle.reason, 'invalid_explicit_target');
      assert.equal(failure.lifecycle.inputMessageId, message.id);
      assert.deepEqual(publishedSource.lifecycle.dispatchRefs, [
        { targetId: 'opus', phase: 'settled', statusMessageId: failure.id },
        { targetId: 'codex', phase: 'assigned' },
      ]);
    });

    it('removes an unavailable private input with only an internal terminal diagnostic', async () => {
      const unavailableDeps = stubDeps({
        router: {
          resolveExplicitTargets: mock.fn(async () => []),
        },
      });
      const unavailableProcessor = new QueueProcessor(unavailableDeps);
      const entry = enqueueEntry(unavailableDeps.queue, {
        kind: 'private_input',
        source: 'agent',
        messageId: null,
        content: 'private exact evidence',
      });

      await unavailableProcessor.requestDrain('t1');

      assert.equal(unavailableDeps.router.routeExecution.mock.calls.length, 0);
      assert.equal(unavailableDeps.messageStore.append.mock.calls.length, 0);
      assert.equal(unavailableDeps.queue.getEntrySnapshot('t1', 'u1', entry.id), null);
      assert.ok(
        unavailableDeps.log.warn.mock.calls.some(
          (call) => call.arguments[0]?.event === 'private_input_pre_admission_failed',
        ),
      );
    });

    it('binds the resolved default target into targetless custody before provider admission', async () => {
      const durableStore = new MessageStore();
      const targetlessDeps = stubDeps({ messageStore: durableStore });
      targetlessDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({
        messageStore: durableStore,
      });
      const targetlessProcessor = new QueueProcessor(targetlessDeps);
      const { message } = enqueueCustodiedEntry(targetlessDeps.queue, durableStore, {
        content: 'resolve me at the head',
        targetCats: [],
      });

      await targetlessProcessor.requestDrain('t1');
      await waitForQueue(
        targetlessDeps.queue,
        't1',
        'u1',
        () => targetlessDeps.router.routeExecution.mock.calls.length === 1,
      );

      assert.deepEqual(targetlessDeps.router.routeExecution.mock.calls[0].arguments[4], ['opus']);
      const admitted = durableStore.getById(message.id);
      assert.equal(admitted.deliveryStatus, 'delivered');
      assert.deepEqual(admitted.queueCustody.allTargetCats, ['opus']);
    });

    it('#1291 exact reservation executes selected A+B once without absorbing adjacent C', async () => {
      const a = enqueueEntry(deps.queue, { content: 'msg-a', ownerAuthProvenance: 'strict' });
      const b = enqueueEntry(deps.queue, { content: 'msg-b', ownerAuthProvenance: 'strict' });
      enqueueEntry(deps.queue, { content: 'msg-c', ownerAuthProvenance: 'strict' });
      const reserved = deps.queue.reserveExactUserBatch('t1', 'u1', [a.id, b.id]);
      assert.equal(reserved.outcome, 'reserved');
      assert.equal(deps.queue.beginExactSteerPreemption('t1', 'u1', reserved.reservationId), true);
      assert.equal(deps.queue.activateExactSteerReservation('t1', 'u1', reserved.reservationId), true);

      await processor.processNext('t1', 'u1');
      await waitForQueue(deps.queue, 't1', 'u1', () => deps.router.routeExecution.mock.calls.length >= 1);

      assert.equal(deps.router.routeExecution.mock.calls[0].arguments[1], 'msg-a\nmsg-b');
      await waitForQueue(deps.queue, 't1', 'u1', () => deps.router.routeExecution.mock.calls.length >= 2);
      assert.equal(
        deps.router.routeExecution.mock.calls[1].arguments[1],
        'msg-c',
        'unselected C may run next but is never absorbed into the selected invocation',
      );
    });

    it('#1291 restart fallback never lets persisted Steer intent absorb an unselected neighbor', async () => {
      const a = enqueueEntry(deps.queue, { content: 'msg-a', ownerAuthProvenance: 'strict' });
      const b = enqueueEntry(deps.queue, { content: 'msg-b', ownerAuthProvenance: 'strict' });
      enqueueEntry(deps.queue, { content: 'msg-c', ownerAuthProvenance: 'strict' });

      // exactSteerBatch is deliberately process-local. After restart, durable
      // custody restores the selected entries' Steer intent without the group
      // marker; fail closed to separate invocations instead of widening to C.
      assert.equal(deps.queue.markSteering('t1', 'u1', a.id, 'opus'), true);
      assert.equal(deps.queue.markSteering('t1', 'u1', b.id, 'opus'), true);

      await processor.processNext('t1', 'u1');
      await waitForQueue(deps.queue, 't1', 'u1', () => deps.router.routeExecution.mock.calls.length >= 3);

      assert.deepEqual(
        deps.router.routeExecution.mock.calls.slice(0, 3).map((call) => call.arguments[1]),
        ['msg-a', 'msg-b', 'msg-c'],
      );
    });

    it('#1291 exact reservation never revives selected members after provider admission fails', async () => {
      const failDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            throw new Error('provider unavailable');
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const failProcessor = new QueueProcessor(failDeps);
      const a = enqueueEntry(failDeps.queue, { content: 'a', ownerAuthProvenance: 'strict' });
      const b = enqueueEntry(failDeps.queue, { content: 'b', ownerAuthProvenance: 'strict' });
      const c = enqueueEntry(failDeps.queue, { content: 'c', ownerAuthProvenance: 'strict' });
      const reserved = failDeps.queue.reserveExactUserBatch('t1', 'u1', [a.id, b.id]);
      assert.equal(reserved.outcome, 'reserved');
      assert.equal(failDeps.queue.beginExactSteerPreemption('t1', 'u1', reserved.reservationId), true);
      assert.equal(failDeps.queue.activateExactSteerReservation('t1', 'u1', reserved.reservationId), true);

      await failProcessor.processNext('t1', 'u1');
      await new Promise((resolve) => setTimeout(resolve, 100));

      const byId = new Map(failDeps.queue.list('t1', 'u1').map((entry) => [entry.id, entry]));
      assert.equal(byId.has(a.id), false);
      assert.equal(byId.has(b.id), false);
      assert.equal(byId.get(c.id)?.exactSteerBatch, undefined);
    });

    it('#1291 exact reservation restores every selected member when processing custody cannot persist', async () => {
      const persistEntry = mock.fn(async () => {
        throw new Error('custody unavailable');
      });
      const persistDeps = stubDeps({ queueCustodyCoordinator: { persistEntry } });
      const persistProcessor = new QueueProcessor(persistDeps);
      const a = enqueueEntry(persistDeps.queue, { content: 'a', ownerAuthProvenance: 'strict' });
      const b = enqueueEntry(persistDeps.queue, { content: 'b', ownerAuthProvenance: 'strict' });
      const reserved = persistDeps.queue.reserveExactUserBatch('t1', 'u1', [a.id, b.id]);
      assert.equal(reserved.outcome, 'reserved');
      assert.equal(persistDeps.queue.beginExactSteerPreemption('t1', 'u1', reserved.reservationId), true);
      assert.equal(persistDeps.queue.activateExactSteerReservation('t1', 'u1', reserved.reservationId), true);

      const result = await persistProcessor.processNext('t1', 'u1');

      assert.equal(result.started, false);
      assert.equal(persistDeps.router.routeExecution.mock.calls.length, 0);
      const selected = persistDeps.queue.list('t1', 'u1').filter((entry) => entry.id === a.id || entry.id === b.id);
      assert.equal(selected.length, 2);
      assert.ok(selected.every((entry) => entry.status === 'queued'));
    });

    it('never lets fallback content ride a strict owner invocation', async () => {
      enqueueEntry(deps.queue, { content: 'strict-owner-message', ownerAuthProvenance: 'strict' });
      enqueueEntry(deps.queue, {
        content: 'fallback-owner-message',
        ownerAuthProvenance: 'compatibility_fallback',
      });

      await processor.processNext('t1', 'u1');
      await waitForQueue(deps.queue, 't1', 'u1', () => deps.router.routeExecution.mock.calls.length >= 1);

      const firstCall = deps.router.routeExecution.mock.calls[0];
      assert.equal(firstCall.arguments[1], 'strict-owner-message');
      assert.equal(firstCall.arguments[6].ownerAuthProvenance, 'strict');
    });

    it('does not merge a failed-target carrier into an eligible sibling provider call', async () => {
      const batchDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* (_userId, _content, _threadId, _messageId, targetCats) {
            for (const catId of targetCats) {
              yield { type: 'done', catId, timestamp: Date.now() };
            }
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const batchProcessor = new QueueProcessor(batchDeps);
      enqueueEntry(batchDeps.queue, {
        content: 'eligible-primary',
        targetCats: ['opus', 'codex'],
      });
      const failedSecondary = enqueueEntry(batchDeps.queue, {
        content: 'failed-secondary-must-stay-out',
        targetCats: ['opus', 'codex'],
      });
      batchDeps.queue.takeQueuedFailedTargetForCatAcrossUsers(
        't1',
        'opus',
        'inv-failed-secondary',
        new Set([failedSecondary.id]),
      );

      await batchProcessor.processNext('t1', 'u1');
      await waitForQueue(batchDeps.queue, 't1', 'u1', () => batchDeps.router.routeExecution.mock.calls.length >= 1);

      const firstCall = batchDeps.router.routeExecution.mock.calls[0];
      assert.equal(firstCall.arguments[1], 'eligible-primary');
      assert.deepEqual(firstCall.arguments[4], ['opus', 'codex']);
      await waitForQueue(batchDeps.queue, 't1', 'u1', () => batchDeps.router.routeExecution.mock.calls.length >= 2);
      const siblingCall = batchDeps.router.routeExecution.mock.calls[1];
      assert.equal(siblingCall.arguments[1], 'failed-secondary-must-stay-out');
      assert.deepEqual(siblingCall.arguments[4], ['codex']);
    });

    it('marks all batched entries as processing', async () => {
      enqueueEntry(deps.queue, { content: 'a' });
      enqueueEntry(deps.queue, { content: 'b' });

      await processor.processNext('t1', 'u1');

      const remaining = deps.queue.list('t1', 'u1').filter((e) => e.status === 'queued');
      assert.equal(remaining.length, 0, 'no queued entries should remain after batch');
    });

    it('batches compatible connector conversation inputs into one dispatch', async () => {
      enqueueEntry(deps.queue, { content: 'conn-a', source: 'connector' });
      enqueueEntry(deps.queue, { content: 'conn-b', source: 'connector' });

      await processor.processNext('t1', 'u1');
      await waitForQueue(deps.queue, 't1', 'u1', () => deps.router.routeExecution.mock.calls.length >= 1);

      const calledContent = deps.router.routeExecution.mock.calls[0].arguments[1];
      assert.equal(calledContent, 'conn-a\nconn-b');
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(deps.router.routeExecution.mock.calls.length, 1, 'compatible public inputs share one dispatch');
    });

    it('stops batch at different intent', async () => {
      enqueueEntry(deps.queue, { content: 'exec-a', intent: 'execute' });
      enqueueEntry(deps.queue, { content: 'search-b', intent: 'search' });

      await processor.processNext('t1', 'u1');
      await waitForQueue(deps.queue, 't1', 'u1', () => deps.router.routeExecution.mock.calls.length >= 1);

      const calledContent = deps.router.routeExecution.mock.calls[0].arguments[1];
      assert.equal(calledContent, 'exec-a', 'should only include matching-intent entries');
    });

    it('removes all batched entries after successful execution', async () => {
      enqueueEntry(deps.queue, { content: 'a' });
      enqueueEntry(deps.queue, { content: 'b' });
      enqueueEntry(deps.queue, { content: 'c' });

      await processor.processNext('t1', 'u1');
      await waitForQueue(deps.queue, 't1', 'u1', (q) => q.length === 0);

      const all = deps.queue.list('t1', 'u1');
      assert.equal(all.length, 0, 'all batched entries should be removed after completion');
    });

    it('failed provider execution never rolls admitted batch members back into Queue', async () => {
      const failDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* () {
            throw new Error('CLI spawn failed');
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const failProcessor = new QueueProcessor(failDeps);

      enqueueEntry(failDeps.queue, { content: 'primary' });
      enqueueEntry(failDeps.queue, { content: 'batched-a' });
      enqueueEntry(failDeps.queue, { content: 'batched-b' });

      await failProcessor.processNext('t1', 'u1');
      await new Promise((r) => setTimeout(r, 100));

      const remaining = failDeps.queue.list('t1', 'u1');
      assert.equal(remaining.length, 0, 'provider-started batch identities must not re-enter pre-admission Queue');
    });

    it('P1-1: admits primary and batched sources into History before provider execution', async () => {
      const batchStore = new MessageStore();
      let messagesAtProviderStart;
      let sourceMessageIds = [];
      const batchDeps = stubDeps({
        messageStore: batchStore,
        router: {
          routeExecution: mock.fn(async function* () {
            messagesAtProviderStart = await Promise.all(sourceMessageIds.map((id) => batchStore.getById(id)));
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      batchDeps.queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore: batchStore });
      const batchProcessor = new QueueProcessor(batchDeps);
      const sources = ['first', 'second'].map((content) =>
        enqueueCustodiedEntry(batchDeps.queue, batchStore, { content }),
      );
      sourceMessageIds = sources.map(({ message }) => message.id);

      await batchProcessor.processNext('t1', 'u1');
      await waitForQueue(batchDeps.queue, 't1', 'u1', () => messagesAtProviderStart !== undefined);

      assert.deepEqual(
        messagesAtProviderStart.map(({ id, deliveryStatus }) => ({ id, deliveryStatus })),
        sourceMessageIds.map((id) => ({ id, deliveryStatus: 'delivered' })),
      );
    });

    it('keeps user and connector identities independent while sharing one compatible dispatch', async () => {
      enqueueEntry(deps.queue, { content: 'user-msg', source: 'user' });
      enqueueEntry(deps.queue, { content: 'connector-msg', source: 'connector' });

      await processor.processNext('t1', 'u1');
      await waitForQueue(deps.queue, 't1', 'u1', () => deps.router.routeExecution.mock.calls.length >= 1);

      const calledContent = deps.router.routeExecution.mock.calls[0].arguments[1];
      assert.equal(calledContent, 'user-msg\nconnector-msg');
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(deps.router.routeExecution.mock.calls.length, 1);
    });

    it('keeps the strict comparator head when its target slot is busy', async () => {
      const slowDeps = stubDeps({
        invocationTracker: {
          start: mock.fn(() => new AbortController()),
          startAll: mock.fn(() => new AbortController()),
          complete: mock.fn(),
          completeAll: mock.fn(),
          has: mock.fn((tid, catId) => catId === 'codex'),
        },
      });
      const slowProcessor = new QueueProcessor(slowDeps);

      // urgent entry for codex (slot busy), normal entry for opus (slot free)
      enqueueEntry(slowDeps.queue, { content: 'urgent-codex', targetCats: ['codex'], priority: 'urgent' });
      enqueueEntry(slowDeps.queue, { content: 'normal-opus', targetCats: ['opus'], priority: 'normal' });

      // Trigger across-users chain (simulates codex slot completing, then scanning queue)
      // codex is still busy (has() returns true), opus is free
      await slowProcessor.onInvocationComplete('t1', 'opus', 'succeeded');
      await new Promise((r) => setTimeout(r, 100));

      // Neither entry may execute: the Queue comparator chose codex, and slot
      // availability cannot become a second ordering policy that bypasses it.
      const routeCalls = slowDeps.router.routeExecution.mock.calls;
      assert.equal(routeCalls.length, 0, 'must not bypass the busy comparator head');

      // Both entries remain queued until the strict head becomes dispatchable.
      const codexEntries = slowDeps.queue.list('t1', 'u1').filter((e) => e.content === 'urgent-codex');
      assert.equal(codexEntries.length, 1, 'codex entry should remain');
      assert.equal(codexEntries[0].status, 'queued', 'codex entry should still be queued');
      const opusEntries = slowDeps.queue.list('t1', 'u1').filter((e) => e.content === 'normal-opus');
      assert.equal(opusEntries.length, 1, 'later opus entry should remain behind the comparator head');
      assert.equal(opusEntries[0].status, 'queued');
    });

    it('P1: duplicate primary does not mark batched entries as processing', async () => {
      let callCount = 0;
      const dupeDeps = stubDeps({
        invocationRecordStore: {
          create: mock.fn(async () => {
            callCount++;
            if (callCount === 1) return { outcome: 'duplicate', invocationId: 'inv-dupe' };
            return { outcome: 'created', invocationId: `inv-${callCount}` };
          }),
          update: mock.fn(async () => {}),
        },
      });
      const dupeProcessor = new QueueProcessor(dupeDeps);

      enqueueEntry(dupeDeps.queue, { content: 'a' });
      enqueueEntry(dupeDeps.queue, { content: 'b' });
      enqueueEntry(dupeDeps.queue, { content: 'c' });

      await dupeProcessor.processNext('t1', 'u1');
      await new Promise((r) => setTimeout(r, 100));

      // Entry 'a' hits duplicate → returns early. With the fix, b and c are NOT
      // marked processing on the duplicate path. The chain then dequeues b (non-duplicate),
      // which batches c. So routeExecution sees b+c content, not a+b+c.
      const routeCalls = dupeDeps.router.routeExecution.mock.calls;
      assert.ok(routeCalls.length >= 1, 'chain should process remaining entries');
      const calledContent = routeCalls[0].arguments[1];
      assert.ok(!calledContent.includes('a'), 'duplicate entry content must not appear in batched execution');
    });
  });

  // ── RFC #1356 strict comparator fairness ──

  describe('strict comparator fairness', () => {
    it('admits the strict user head before a later agent entry without serializing free slots', async () => {
      let releaseUser;
      const userGate = new Promise((resolve) => {
        releaseUser = resolve;
      });
      const routeCalls = [];
      const fairnessDeps = stubDeps({
        router: {
          routeExecution: mock.fn(async function* (...args) {
            routeCalls.push(args);
            await userGate;
            yield { type: 'done', catId: args[4][0], timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });
      const fairnessProcessor = new QueueProcessor(fairnessDeps);
      // User entry queued (non-agent)
      enqueueEntry(fairnessDeps.queue, {
        userId: 'u1',
        source: 'user',
        targetCats: ['opus'],
      });
      // Agent autoExecute entry queued
      enqueueEntry(fairnessDeps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'opus',
      });

      await fairnessProcessor.requestDrain('t1');
      await new Promise((r) => setTimeout(r, 50));

      assert.equal(routeCalls.length, 2, 'both free slots may run after ordered admission');
      assert.deepEqual(routeCalls[0][4], ['opus']);
      assert.deepEqual(routeCalls[1][4], ['codex']);

      releaseUser();
    });

    it('AC-11: A2A chain + connector entry → connector dispatches before autoExecute', async () => {
      // Connector entry queued first
      enqueueEntry(deps.queue, {
        userId: 'u1',
        source: 'connector',
        targetCats: ['opus'],
      });
      // Agent A2A chain entry queued after
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'opus',
      });

      await processor.requestDrain('t1');
      await new Promise((r) => setTimeout(r, 50));

      assert.ok(deps.invocationTracker.startAll.mock.calls.length > 0, 'the protected connector must be dispatched');
      assert.deepEqual(
        deps.invocationTracker.startAll.mock.calls[0].arguments[1],
        ['opus'],
        'the agent entry must not jump ahead of the connector',
      );
    });

    it('allows auto-execute when only agent entries are queued', async () => {
      enqueueEntry(deps.queue, {
        userId: 'system',
        source: 'agent',
        targetCats: ['codex'],
        autoExecute: true,
        callerCatId: 'opus',
      });

      await processor.requestDrain('t1');
      await new Promise((r) => setTimeout(r, 50));

      assert.ok(
        deps.invocationTracker.startAll.mock.calls.length > 0,
        'should auto-execute when only agent entries are queued',
      );
    });
  });

  // ── F216 c3: supersede tombstone guard + immediate restart regression ──

  describe('F216 c3: pre-start window supersede tombstone', () => {
    it('FIRST never reaches routeExecution and SECOND restarts immediately (no 10s pause)', async () => {
      // This test catches the exact bug from review R3: if the tombstone guard returns
      // plain 'canceled' instead of 'canceled_by_user', onInvocationComplete pauses the
      // slot for 10s and SECOND doesn't start promptly. 22/22 existing tests were green
      // on that broken commit — THIS test would have caught it.

      const routedContents = [];
      let createResolve;
      const createPromise = new Promise((resolve) => {
        createResolve = resolve;
      });

      const deps = stubDeps({
        invocationRecordStore: {
          // Delayed create() — simulates the pre-start window (markProcessing → startAll gap)
          create: mock.fn(async () => {
            await createPromise; // blocks until we manually resolve
            return { outcome: 'created', invocationId: 'inv-supersede-test' };
          }),
          update: mock.fn(async () => {}),
        },
        router: {
          routeExecution: mock.fn(async function* (_userId, content, _threadId, _messageId, targetCats) {
            routedContents.push(content);
            yield { type: 'done', catId: targetCats[0], timestamp: Date.now() };
          }),
          ackCollectedCursors: mock.fn(async () => {}),
        },
      });

      const processor = new QueueProcessor(deps);

      // 1. Enqueue FIRST and trigger execution — it will block at create()
      const first = enqueueEntry(deps.queue, {
        content: 'FIRST: do task X',
        source: 'agent',
        targetCats: ['antig-opus'],
        autoExecute: true,
      });
      deps.queue.backfillMessageId('t1', 'u1', first.id, 'msg-first');
      await processor.requestDrain('t1');

      // At this point: FIRST is marked processing, executeEntry is awaiting createPromise.
      // Verify FIRST is processing (slot taken).
      assert.equal(
        deps.queue.list('t1', 'u1').some((e) => e.id === first.id && e.status === 'processing'),
        true,
        'FIRST should be processing (pre-start window open)',
      );

      // 2. Simulate supersede: remove FIRST (tombstone) + enqueue SECOND (follow-up)
      deps.queue.removeProcessed('t1', 'u1', first.id);
      deps.queue.enqueue(
        canonicalTestQueueInput({
          threadId: 't1',
          userId: 'u1',
          kind: 'private_input',
          content: 'SECOND: answer 3 questions first',
          source: 'agent',
          ownerAuthProvenance: 'unknown',
          targetCats: ['antig-opus'],
          intent: 'execute',
          autoExecute: true,
        }),
      );

      // 3. Release the create() — executeEntry continues to startAll → tombstone guard fires
      createResolve();

      // Wait for the full chain: startAll → guard → return 'canceled_by_user' → .then →
      // processingSlots.delete → onInvocationComplete → requestDrain → SECOND starts
      await new Promise((r) => setTimeout(r, 100));

      // 4. FIRST must NOT have been routed
      const firstRouted = routedContents.some((c) => c.includes('FIRST'));
      assert.equal(firstRouted, false, 'FIRST must NOT reach routeExecution (tombstone guard)');

      // 5. SECOND must have been routed (immediate restart, not 10s pause)
      const secondRouted = routedContents.some((c) => c.includes('SECOND'));
      assert.equal(secondRouted, true, 'SECOND must route promptly via immediate restart (not 10s pause)');

      // 6. Queue should be empty (both entries consumed)
      const remaining = deps.queue.list('t1', 'u1').filter((e) => e.status === 'queued');
      assert.equal(remaining.length, 0, 'queue should be empty after supersede lifecycle');
    });
  });

  describe('F222 P1: frustrationAutoIssueEligible source whitelist', () => {
    for (const { source, expected, label } of [
      { source: 'user', expected: true, label: 'user source → eligible=true' },
      { source: 'agent', expected: false, label: 'agent source → eligible=false' },
      { source: 'connector', expected: false, label: 'connector source → eligible=false' },
    ]) {
      it(label, async () => {
        let capturedEligible;
        let capturedDispositionOrigin;
        deps.router.routeExecution = mock.fn(
          async function* (_userId, _content, _threadId, _messageId, _targetCats, _intent, options) {
            capturedEligible = options?.frustrationAutoIssueEligible;
            capturedDispositionOrigin = options?.humanDispositionInvocationOrigin;
            yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
          },
        );

        enqueueEntry(deps.queue, { source });
        const result = await processor.processNext('t1', 'u1');
        assert.equal(result.started, true);
        await new Promise((resolve) => setTimeout(resolve, 80));

        assert.equal(
          capturedEligible,
          expected,
          `source:'${source}' must pass frustrationAutoIssueEligible=${expected}`,
        );
        assert.equal(
          capturedDispositionOrigin,
          'queue_replay',
          `source:'${source}' is queue replay even when the queued author is the owner`,
        );
      });
    }
  });
});
