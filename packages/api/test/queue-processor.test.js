import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { CallerDispatchObservationRegistry } = await import(
  '../dist/domains/cats/services/agents/invocation/CallerDispatchObservationRegistry.js'
);
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { DraftStore } = await import('../dist/domains/cats/services/stores/ports/DraftStore.js');
const { InMemoryTurnExecutionStore } = await import(
  '../dist/domains/cats/services/stores/memory/InMemoryTurnExecutionStore.js'
);
const { MessageStore, settleLifecycleResponseInputs } = await import(
  '../dist/domains/cats/services/stores/ports/MessageStore.js'
);
const { responseOutcomeForEndedTurn, settleResponseFromDraft } = await import(
  '../dist/domains/cats/services/agents/invocation/response-draft-settlement.js'
);
const { TurnExecutionStartupReconciler } = await import(
  '../dist/domains/cats/services/agents/invocation/TurnExecutionStartupReconciler.js'
);

let sourceSequence = 0;

function waitFor(predicate, timeoutMs = 3_000) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error('timed out waiting for Queue transition'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

function createInvocationRecordStore() {
  const records = new Map();
  let invocationSequence = 0;
  return {
    records,
    create: mock.fn(async (input) => {
      const invocationId = `inv-${++invocationSequence}`;
      const now = Date.now();
      records.set(invocationId, {
        id: invocationId,
        ...input,
        userMessageId: null,
        status: 'queued',
        createdAt: now,
        updatedAt: now,
      });
      return { outcome: 'created', invocationId };
    }),
    get: mock.fn(async (invocationId) => records.get(invocationId) ?? null),
    update: mock.fn(async (invocationId, patch) => {
      const current = records.get(invocationId);
      if (!current) return null;
      if (patch.expectedStatus && current.status !== patch.expectedStatus) return null;
      const { expectedStatus: _expectedStatus, ...changes } = patch;
      const next = { ...current, ...changes, updatedAt: Date.now() };
      records.set(invocationId, next);
      return next;
    }),
  };
}

function createHarness({
  routeExecution,
  tracker = new InvocationTracker(),
  callerDispatchObservationRegistry = new CallerDispatchObservationRegistry(),
  // A failed attempt's retry wait is long by default so no retry fires behind a later test.
  processorOptions = { retryDeferral: { baseDelayMs: 60_000 } },
  draftStore,
  turnExecutionStore,
  actionSuccessorLeaseStore,
  deploymentWaitStartGuard,
  autoDrain = false,
} = {}) {
  let processor;
  const queue = new InvocationQueue(
    undefined,
    autoDrain
      ? {
          onAdmitted: ({ threadId }) => {
            void processor.requestDrain(threadId);
          },
        }
      : {},
  );
  const messageStore = new MessageStore();
  const invocationRecordStore = createInvocationRecordStore();
  const routeCalls = [];
  const router = {
    resolveExplicitTargets: mock.fn(async (targetCats) => [...targetCats]),
    resolveConversationTargetsAtAdmission: mock.fn(async (targetCats) =>
      targetCats.length > 0 ? [...targetCats] : ['opus'],
    ),
    routeExecution: mock.fn(
      routeExecution ??
        async function* (...args) {
          routeCalls.push(args);
          const [userId, , threadId, , targetCats, , options] = args;
          const startedAt = Date.now();
          await options.onLifecycleInvocationStarted({
            threadId,
            userId,
            catId: targetCats[0],
            invocationId: `turn-default-${routeCalls.length}`,
            parentInvocationId: options.parentInvocationId,
            startedAt,
          });
          yield { type: 'done', catId: args[4][0], isFinal: true, timestamp: Date.now() };
        },
    ),
    ackCollectedCursors: mock.fn(async () => {}),
  };
  const socketManager = {
    broadcastAgentMessage: mock.fn(),
    broadcastToRoom: mock.fn(),
    emitToUser: mock.fn(),
  };
  const deps = {
    queue,
    invocationTracker: tracker,
    invocationRecordStore,
    router,
    socketManager,
    messageStore,
    callerDispatchObservationRegistry,
    log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
    ...(draftStore ? { draftStore } : {}),
    ...(turnExecutionStore ? { turnExecutionStore } : {}),
    ...(actionSuccessorLeaseStore ? { actionSuccessorLeaseStore } : {}),
    ...(deploymentWaitStartGuard ? { deploymentWaitStartGuard } : {}),
  };
  processor = new QueueProcessor(deps, processorOptions);
  return { ...deps, processor, routeCalls };
}

/** Records and ends the child turn the way invoke-single-cat does, entering the response-pending ledger. */
async function endChildTurn(turns, args, invocationId, terminal, catId = args[4][0]) {
  const [userId, , threadId, , , , options] = args;
  await turns.createRunning({
    invocationId,
    parentInvocationId: options.parentInvocationId,
    threadId,
    userId,
    catId,
    executionKind: 'ordinary',
    startedAt: Date.now() - 1,
    // As the real route does: a child of an action-fenced dispatch is created gated.
    ...(options.beforeOutputCommit ? { outputFence: 'gated' } : {}),
  });
  await turns.transitionTerminal(invocationId, { endedAt: Date.now(), ...terminal });
}

/** Production startup wiring: the next process settles every ended turn left in the ledger. */
function nextStartup(turns, messageStore, draftStore) {
  return new TurnExecutionStartupReconciler({
    store: turns,
    settleEndedTurnResponse: (turn) =>
      settleResponseFromDraft(
        { messageStore, draftStore, turnStore: turns },
        {
          userId: turn.userId,
          threadId: turn.threadId,
          invocationId: turn.invocationId,
          ...responseOutcomeForEndedTurn(turn),
        },
      ),
  }).reconcile({ processStartedAt: Date.now() + 1_000 });
}

function pendingTurnIds(turns) {
  return turns.listResponsePending().map((turn) => turn.invocationId);
}

async function startLifecycle(args, invocationId) {
  const [userId, , threadId, , targetCats, , options] = args;
  return options.onLifecycleInvocationStarted({
    threadId,
    userId,
    catId: targetCats[0],
    invocationId,
    parentInvocationId: options.parentInvocationId,
    startedAt: Date.now(),
  });
}

function errorLog(harness) {
  return harness.log.error.mock.calls.map((call) =>
    call.arguments.map((argument) => {
      if (argument?.err instanceof Error) {
        return { ...argument, err: { message: argument.err.message, stack: argument.err.stack } };
      }
      return argument;
    }),
  );
}

async function admitMessage(harness, overrides = {}) {
  sourceSequence += 1;
  const queueInput = canonicalTestQueueInput({
    threadId: 'thread-1',
    userId: 'user-1',
    kind: 'conversation_input',
    ownerAuthProvenance: 'strict',
    sourceId: `queue-processor-${sourceSequence}`,
    content: `body-${sourceSequence}`,
    targetCats: ['opus'],
    intent: 'execute',
    ...overrides,
  });
  const messageInput = canonicalTestMessageInput({
    threadId: queueInput.threadId,
    userId: queueInput.userId,
    catId: null,
    from: queueInput.from,
    ...(overrides.messageSource ? { source: overrides.messageSource } : {}),
    content: queueInput.content,
    mentions: queueInput.targetCats,
    timestamp: Date.now(),
    deliveryStatus: 'queued',
  });
  const result = await harness.queue.send(harness.messageStore, messageInput, queueInput);
  assert.equal(result.outcome, 'enqueued');
  assert.ok(result.entry);
  return result;
}

function bindActiveRun(
  harness,
  { catId = 'opus', invocationId = 'turn-active', parentInvocationId = 'parent-active' } = {},
) {
  const startedAt = Date.now();
  harness.invocationTracker.start('thread-1', catId, 'user-1', [catId], parentInvocationId);
  const response = harness.messageStore.append({
    from: { kind: 'agent', catId },
    userId: 'user-1',
    content: '',
    mentions: [],
    origin: 'stream',
    timestamp: startedAt,
    threadId: 'thread-1',
    lifecycle: {
      kind: 'response',
      orderKey: `${startedAt}:${invocationId}`,
      invocationId,
      targetId: catId,
      inputEntryIds: [],
      inputMessageIds: [],
      status: 'processing',
      startedAt,
    },
  });
  assert.equal(
    harness.invocationTracker.bindLifecycleActiveRun(
      {
        threadId: 'thread-1',
        targetId: catId,
        invocationId,
        responseMessageId: response.id,
        inputEntryIds: [],
        inputMessageIds: [],
        privateInputEntryIds: [],
        startedAt,
      },
      parentInvocationId,
    ),
    true,
  );
  return { invocationId, response, startedAt };
}

describe('QueueProcessor over the source-row pending Queue', () => {
  it('reconciles a stale Queue target that already has a durable response without reentering the provider', async () => {
    const harness = createHarness();
    const admitted = await admitMessage(harness, { targetCats: ['opus', 'codex'] });
    const source = await harness.messageStore.getById(admitted.message.id);
    const dispatched = await harness.messageStore.advanceLifecycleInputDispatch(source.id, {
      orderKey: source.lifecycle.orderKey,
      from: source.from,
      targetId: 'opus',
      phase: 'dispatched',
      statusMessageId: 'response-already-durable',
      dispatchedAt: source.timestamp + 1,
    });
    assert.equal(dispatched.kind, 'applied');
    const settled = await harness.messageStore.advanceLifecycleInputDispatch(source.id, {
      orderKey: source.lifecycle.orderKey,
      from: source.from,
      targetId: 'opus',
      phase: 'settled',
      statusMessageId: 'response-already-durable',
    });
    assert.equal(settled.kind, 'applied');

    const started = await harness.processor.processNext('thread-1', 'user-1');

    assert.equal(started.started, false);
    assert.equal(harness.router.routeExecution.mock.calls.length, 0);
    const remaining = await harness.queue.getDurableEntry('thread-1', admitted.entry.id);
    assert.equal(remaining.status, 'queued');
    assert.deepEqual(remaining.targets, ['codex']);
  });

  it('reconciles dispatchRefs when a prior response is itself the source of successor work', async () => {
    const harness = createHarness();
    const source = await harness.messageStore.append({
      from: { kind: 'agent', catId: 'caller' },
      userId: 'user-1',
      content: 'successor source',
      mentions: ['opus', 'codex'],
      origin: 'stream',
      timestamp: 10,
      threadId: 'thread-1',
      lifecycle: {
        kind: 'response',
        orderKey: '10:caller-response',
        invocationId: 'caller-response',
        targetId: 'caller',
        inputEntryIds: ['caller-entry'],
        inputMessageIds: ['caller-input'],
        status: 'completed',
        startedAt: 9,
        completedAt: 10,
        dispatchRefs: [{ targetId: 'opus', phase: 'settled', statusMessageId: 'opus-response', dispatchedAt: 10 }],
      },
    });
    const queued = await harness.queue.enqueueDurable(
      canonicalTestQueueInput({
        threadId: 'thread-1',
        userId: 'user-1',
        kind: 'conversation_input',
        ownerAuthProvenance: 'strict',
        sourceId: source.id,
        messageId: source.id,
        content: source.content,
        from: source.from,
        targetCats: ['opus', 'codex'],
        intent: 'execute',
      }),
    );

    const started = await harness.processor.processNext('thread-1', 'user-1');

    assert.equal(started.started, false);
    assert.equal(harness.router.routeExecution.mock.calls.length, 0);
    const remaining = await harness.queue.getDurableEntry('thread-1', queued.entry.id);
    assert.equal(remaining.status, 'queued');
    assert.deepEqual(remaining.targets, ['codex']);
  });

  it('claims and removes admitted work from Queue without leaving a terminal tombstone', async () => {
    const harness = createHarness();
    const admitted = await admitMessage(harness);

    const started = await harness.processor.processNext('thread-1', 'user-1');
    assert.equal(started.started, true);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id) === null);

    assert.equal(
      await harness.queue.getDurableEntry('thread-1', admitted.entry.id),
      null,
      JSON.stringify(errorLog(harness)),
    );
    assert.equal((await harness.messageStore.getById(admitted.message.id)).deliveryStatus, 'delivered');
    const processingProjection = harness.socketManager.emitToUser.mock.calls.find(
      (call) => call.arguments[1] === 'queue_updated' && call.arguments[2]?.action === 'processing',
    );
    assert.ok(processingProjection, 'provider admission must publish a processing projection');
    assert.deepEqual(
      processingProjection.arguments[2].queue,
      [],
      'History admission and Queue retirement must reach the browser in the same projection',
    );
  });

  // A connector notice admitted as queued work reaches the timeline through this delivery, so the
  // delivered projection is the only place a live client can learn it is a connector at all.
  // #1398 routed hold-ball wakes through this path while the projection still carried no `source`,
  // and the client then classified the envelope by `from.kind` alone — `system` — so the hold-ball
  // card degraded to a plain text block. Asserting `markDelivered`'s return value (as the existing
  // F117 case does) cannot see this: the store was always right, the broadcast was not.
  it('carries connector source on the delivered projection', async () => {
    const harness = createHarness();
    const originalClaim = harness.queue.markProcessingGroupDurable.bind(harness.queue);
    let claimedAt;
    harness.queue.markProcessingGroupDurable = mock.fn(async (...args) => {
      const result = await originalClaim(...args);
      claimedAt = result?.entry.claimedAt;
      return result;
    });
    const from = { kind: 'system', service: 'managed-command-wake' };
    const source = {
      connector: 'hold-ball',
      label: '持球通知',
      icon: '🏓',
      meta: { managedHold: true, phase: 'wake', taskId: 'hold-ball-test-1', wakeWhen: true },
    };
    const queueInput = canonicalTestQueueInput({
      threadId: 'thread-1',
      userId: 'user-1',
      kind: 'conversation_input',
      ownerAuthProvenance: 'strict',
      sourceId: 'queue-processor-connector-source',
      content: '[定时任务] 持球唤醒（命令完成）',
      from,
      targetCats: ['opus'],
      intent: 'execute',
    });
    const admitted = await harness.queue.send(
      harness.messageStore,
      canonicalTestMessageInput({
        threadId: queueInput.threadId,
        userId: queueInput.userId,
        catId: null,
        from,
        content: queueInput.content,
        mentions: queueInput.targetCats,
        timestamp: Date.now(),
        deliveryStatus: 'queued',
        source,
      }),
      queueInput,
    );
    assert.equal(admitted.outcome, 'enqueued');

    const started = await harness.processor.processNext('thread-1', 'user-1');
    assert.equal(started.started, true);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id) === null);

    const delivered = harness.socketManager.emitToUser.mock.calls.find(
      (call) => call.arguments[1] === 'messages_delivered',
    );
    assert.ok(delivered, `delivery must publish messages_delivered: ${JSON.stringify(errorLog(harness))}`);
    const projected = delivered.arguments[2].messages.find((message) => message.id === admitted.message.id);
    assert.ok(projected, 'the delivered connector notice must be in the projection');
    assert.equal(projected.source?.connector, 'hold-ball');
    assert.equal(projected.source?.meta?.taskId, 'hold-ball-test-1');
    const stored = await harness.messageStore.getById(admitted.message.id);
    assert.equal(stored.deliveredAt, claimedAt, 'connector notices share the durable dequeue clock');
  });

  it('native dispatcher readiness wakes guidance queued during provider preparation', async () => {
    let releasePreparation;
    let releaseTurn;
    const preparation = new Promise((resolve) => {
      releasePreparation = resolve;
    });
    const turn = new Promise((resolve) => {
      releaseTurn = resolve;
    });
    let parentStarted = false;
    const dispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
    const harness = createHarness({
      routeExecution: async function* (...args) {
        const [userId, , threadId, , targets, , options] = args;
        await options.onLifecycleInvocationStarted({
          threadId,
          userId,
          catId: targets[0],
          invocationId: 'preparing-child',
          parentInvocationId: options.parentInvocationId,
          startedAt: Date.now(),
        });
        parentStarted = true;
        await preparation;
        const release = options.onAgentClientActiveRunReady({
          catId: targets[0],
          dispatcher: {
            invocationId: 'preparing-child',
            capabilities: { append: true, steer: true },
            handle: {
              provider: 'openai_codex',
              carrier: 'codex_app_server',
              threadId: 'native',
              turnId: 'native-turn',
            },
            dispatch,
          },
        });
        try {
          await turn;
        } finally {
          release();
        }
        yield { type: 'done', catId: targets[0], isFinal: true, timestamp: Date.now() };
      },
    });
    await admitMessage(harness);
    await harness.processor.requestDrain('thread-1');
    try {
      await waitFor(() => parentStarted);
      const followup = await admitMessage(harness, {
        authorIntentByCatId: {
          opus: {
            requested: 'continue_current',
            boundParentInvocationId: harness.invocationTracker.getExecutionId('thread-1', 'opus'),
          },
        },
      });
      await harness.processor.requestDrain('thread-1');
      assert.equal(
        harness.queue.getEntrySnapshot('thread-1', 'user-1', followup.entry.id).delivery.authorIntentByTarget.opus
          .fallbackAt,
        undefined,
      );
      releasePreparation();
      await waitFor(() => dispatch.mock.calls.length === 1);
      assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', followup.entry.id), null);
      assert.equal(harness.router.routeExecution.mock.calls.length, 1, 'guidance does not start a second turn');
    } finally {
      releasePreparation();
      releaseTurn();
    }
  });

  it('starts every idle target of one source before either target completes', async () => {
    let releaseInvocations;
    const release = new Promise((resolve) => {
      releaseInvocations = resolve;
    });
    const startedTargets = [];
    const harness = createHarness({
      routeExecution: async function* (...args) {
        const [userId, , threadId, , targetCats, , options] = args;
        assert.deepEqual(targetCats, ['opus', 'codex']);
        assert.equal(options.targetDispatchMode, 'parallel');
        await Promise.all(
          targetCats.map(async (catId) => {
            await options.onLifecycleInvocationStarted({
              threadId,
              userId,
              catId,
              invocationId: `turn-parallel-${catId}`,
              parentInvocationId: options.parentInvocationId,
              startedAt: Date.now(),
            });
            startedTargets.push(catId);
          }),
        );
        await release;
        for (const catId of targetCats) {
          yield { type: 'done', catId, isFinal: true, timestamp: Date.now() };
        }
      },
    });
    const admitted = await admitMessage(harness, { targetCats: ['opus', 'codex'] });

    await harness.processor.requestDrain('thread-1');
    try {
      await waitFor(() => startedTargets.length === 2, 250).catch((error) => {
        error.message += `: ${JSON.stringify(errorLog(harness))}`;
        throw error;
      });
      assert.deepEqual(new Set(startedTargets), new Set(['opus', 'codex']));
      assert.deepEqual(
        harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id),
        null,
        'both target claims should retire before either provider completes',
      );
    } finally {
      releaseInvocations();
    }
  });

  it('names each target response on every event that target streams', async () => {
    const responseIdByCat = new Map();
    const harness = createHarness({
      routeExecution: async function* (...args) {
        const [userId, , threadId, , targetCats, , options] = args;
        for (const catId of targetCats) {
          const admission = await options.onLifecycleInvocationStarted({
            threadId,
            userId,
            catId,
            invocationId: `turn-stamp-${catId}`,
            parentInvocationId: options.parentInvocationId,
            startedAt: Date.now(),
          });
          responseIdByCat.set(catId, admission.responseMessageId);
        }
        for (const catId of targetCats) {
          yield { type: 'text', catId, content: `${catId} speaks`, timestamp: Date.now() };
          yield { type: 'tool_use', catId, toolName: 'shell', toolInput: { command: 'ls' }, timestamp: Date.now() };
          yield {
            type: 'system_info',
            catId,
            content: JSON.stringify({ type: 'thinking', text: 'hmm' }),
            timestamp: Date.now(),
          };
        }
        yield {
          type: 'system_info',
          catId: 'opus',
          messageId: 'stored-system-row',
          content: JSON.stringify({ type: 'routing_preflight' }),
          timestamp: Date.now(),
        };
        for (const catId of targetCats) {
          yield { type: 'done', catId, isFinal: catId === 'codex', timestamp: Date.now() };
        }
      },
    });
    await admitMessage(harness, { targetCats: ['opus', 'codex'] });

    await harness.processor.requestDrain('thread-1');
    await waitFor(() =>
      harness.socketManager.broadcastAgentMessage.mock.calls.some(
        (call) => call.arguments[0].type === 'done' && call.arguments[0].catId === 'codex',
      ),
    );

    const broadcasts = harness.socketManager.broadcastAgentMessage.mock.calls.map((call) => call.arguments[0]);
    for (const catId of ['opus', 'codex']) {
      const responseId = responseIdByCat.get(catId);
      assert.ok(responseId, `${catId} must be admitted`);
      const streamed = broadcasts.filter(
        (event) => event.catId === catId && event.messageId !== 'stored-system-row' && event.type !== 'error',
      );
      assert.deepEqual(
        streamed.map((event) => event.type),
        ['text', 'tool_use', 'system_info', 'done'],
      );
      assert.deepEqual(
        streamed.map((event) => event.messageId),
        streamed.map(() => responseId),
        `${catId} events must all name its response`,
      );
    }
    assert.notEqual(responseIdByCat.get('opus'), responseIdByCat.get('codex'));
    assert.ok(
      broadcasts.some((event) => event.messageId === 'stored-system-row'),
      'an event that already names its stored message keeps it',
    );
  });

  it('publishes a target committed response at its done, before sibling targets settle', async () => {
    let releaseSibling;
    const siblingGate = new Promise((resolve) => {
      releaseSibling = resolve;
    });
    const responseIdByCat = new Map();
    let harness;
    harness = createHarness({
      routeExecution: async function* (...args) {
        const [userId, , threadId, , targetCats, , options] = args;
        for (const catId of targetCats) {
          const invocationId = `turn-committed-${catId}`;
          const admission = await options.onLifecycleInvocationStarted({
            threadId,
            userId,
            catId,
            invocationId,
            parentInvocationId: options.parentInvocationId,
            startedAt: Date.now(),
          });
          responseIdByCat.set(catId, admission.responseMessageId);
          yield { type: 'text', catId, content: `${catId} answer`, timestamp: Date.now() };
          const committed = await harness.messageStore.commitLifecycleResponseTerminal(admission.responseMessageId, {
            invocationId,
            status: 'completed',
            completedAt: Date.now(),
            content: `${catId} answer`,
            mentions: [],
            origin: 'stream',
          });
          assert.ok(committed.kind === 'applied' || committed.kind === 'replayed');
          yield { type: 'done', catId, isFinal: catId === targetCats.at(-1), timestamp: Date.now() };
          if (catId === targetCats[0]) await siblingGate;
        }
      },
    });
    await admitMessage(harness, { targetCats: ['opus', 'codex'] });
    const committedSnapshots = () =>
      harness.socketManager.emitToUser.mock.calls
        .filter((call) => call.arguments[1] === 'message_lifecycle_updated')
        .map((call) => call.arguments[2].message)
        .filter((message) => message.lifecycle?.kind === 'response' && message.lifecycle.status === 'completed');

    await harness.processor.requestDrain('thread-1');
    try {
      await waitFor(() => committedSnapshots().some((message) => message.id === responseIdByCat.get('opus')));
      assert.equal(
        committedSnapshots().some((message) => message.id === responseIdByCat.get('codex')),
        false,
        'the sibling has not committed yet',
      );
      assert.equal(
        committedSnapshots().find((message) => message.id === responseIdByCat.get('opus')).content,
        'opus answer',
      );
    } finally {
      releaseSibling();
    }
  });

  it('F117 KD-21: a thrown route settles its R out of the ledger; a settlement that fails stays in it', async () => {
    const draftStore = new DraftStore();
    const turns = new InMemoryTurnExecutionStore();
    const responseIds = new Map();
    const harness = createHarness({
      draftStore,
      turnExecutionStore: turns,
      routeExecution: async function* (...args) {
        const [userId, , threadId, , targetCats, , options] = args;
        for (const [catId, invocationId] of [
          [targetCats[0], 'turn-settles'],
          [targetCats[1], 'turn-stuck'],
        ]) {
          const admission = await options.onLifecycleInvocationStarted({
            threadId,
            userId,
            catId,
            invocationId,
            parentInvocationId: options.parentInvocationId,
            startedAt: Date.now(),
          });
          responseIds.set(invocationId, admission.responseMessageId);
          draftStore.upsert({
            userId,
            threadId,
            invocationId,
            catId,
            content: `${invocationId} streamed`,
            updatedAt: Date.now(),
          });
          await endChildTurn(
            turns,
            args,
            invocationId,
            { status: 'failed', terminalReason: 'provider_execution_failed' },
            catId,
          );
          yield { type: 'text', catId, content: 'partial', timestamp: Date.now() };
        }
        throw new Error('route exploded mid-stream');
      },
    });
    const commit = harness.messageStore.commitLifecycleResponseTerminal.bind(harness.messageStore);
    harness.messageStore.commitLifecycleResponseTerminal = async (id, patch) => {
      if (patch.invocationId === 'turn-stuck') throw new Error('redis unavailable');
      return commit(id, patch);
    };
    await admitMessage(harness, { targetCats: ['opus', 'codex'] });

    await harness.processor.requestDrain('thread-1');
    // Settled in order: turn-settles commits first, then turn-stuck's commit fails and is logged.
    await waitFor(() =>
      harness.log.warn.mock.calls.some((call) => String(call.arguments[1]).includes('failed to settle a response')),
    );

    assert.equal(harness.messageStore.getById(responseIds.get('turn-settles')).content, 'turn-settles streamed');
    assert.equal(harness.messageStore.getById(responseIds.get('turn-stuck')).lifecycle.status, 'processing');
    assert.deepEqual(pendingTurnIds(turns), ['turn-stuck'], 'the next startup settles the one that failed');
    assert.deepEqual(
      draftStore.getByThread('user-1', 'thread-1').map((draft) => draft.invocationId),
      ['turn-stuck'],
    );
  });

  /** A fenced action whose lease has moved on: its failure stays hidden and its output is rejected. */
  function fencedHiddenFailure(draftStore, turns) {
    const actionSuccessorLeaseStore = {
      preflight: mock.fn(async () => ({ ok: true, reason: 'active' })),
      preflightOutput: mock.fn(async () => ({ ok: true, reason: 'active' })),
      commitOutcome: mock.fn(async () => ({ outcome: 'stale_generation' })),
    };
    const route = { responseMessageId: undefined };
    const harness = createHarness({
      draftStore,
      turnExecutionStore: turns,
      actionSuccessorLeaseStore,
      routeExecution: async function* (...args) {
        const [userId, , threadId, , targetCats] = args;
        route.responseMessageId = (await startLifecycle(args, 'turn-fenced')).responseMessageId;
        draftStore.upsert({
          userId,
          threadId,
          invocationId: 'turn-fenced',
          catId: targetCats[0],
          content: 'HIDDEN_ACTION_OUTPUT',
          thinking: 'hidden reasoning',
          updatedAt: Date.now(),
        });
        await endChildTurn(turns, args, 'turn-fenced', {
          status: 'failed',
          terminalReason: 'provider_execution_failed',
        });
        yield { type: 'text', catId: targetCats[0], content: 'partial', timestamp: Date.now() };
        throw new Error('route exploded after the lease moved on');
      },
    });
    const admit = () =>
      admitMessage(harness, {
        actionSuccessorFence: {
          leaseId: 'lease-1',
          generation: 1,
          dispatchId: 'multi-mention:req-1',
          terminalPredicateDigest: 'predicate-digest-1',
        },
      });
    return { harness, actionSuccessorLeaseStore, route, admit };
  }

  function assertRejectedOutput(harness, responseMessageId) {
    const response = harness.messageStore.getById(responseMessageId);
    assert.equal(response.lifecycle.status, 'interrupted');
    assert.equal(response.lifecycle.reason, 'output_commit_rejected');
    assert.equal(response.content, '');
    assert.equal(response.thinking, undefined);
  }

  it('F117 KD-21: a fenced action whose failure stays hidden ends R as a rejected output, recorded on the turn', async () => {
    const draftStore = new DraftStore();
    const turns = new InMemoryTurnExecutionStore();
    const { harness, actionSuccessorLeaseStore, route, admit } = fencedHiddenFailure(draftStore, turns);
    await admit();

    await harness.processor.requestDrain('thread-1');
    await waitFor(() => harness.messageStore.getById(route.responseMessageId)?.lifecycle.status === 'interrupted');

    assertRejectedOutput(harness, route.responseMessageId);
    assert.equal(actionSuccessorLeaseStore.commitOutcome.mock.calls.length, 1);
    assert.equal(turns.get('turn-fenced').outputFence, 'rejected');
    assert.equal(draftStore.getByThread('user-1', 'thread-1').length, 0);
    assert.deepEqual(pendingTurnIds(turns), []);
  });

  it('F117 KD-21: a hidden failure whose R commit fails publishes nothing at the next startup', async () => {
    const draftStore = new DraftStore();
    const turns = new InMemoryTurnExecutionStore();
    const { harness, route, admit } = fencedHiddenFailure(draftStore, turns);
    const commit = harness.messageStore.commitLifecycleResponseTerminal.bind(harness.messageStore);
    let failures = 1;
    harness.messageStore.commitLifecycleResponseTerminal = async (id, patch) => {
      if (patch.invocationId === 'turn-fenced' && failures > 0) {
        failures -= 1;
        throw new Error('redis unavailable');
      }
      return commit(id, patch);
    };
    await admit();

    await harness.processor.requestDrain('thread-1');
    await waitFor(() =>
      harness.log.warn.mock.calls.some((call) => String(call.arguments[1]).includes('failed to settle a response')),
    );
    assert.equal(harness.messageStore.getById(route.responseMessageId).lifecycle.status, 'processing');
    assert.equal(turns.get('turn-fenced').outputFence, 'rejected');
    assert.deepEqual(pendingTurnIds(turns), ['turn-fenced']);
    // The draft is still there: keeping it secret no longer depends on deleting it first.
    assert.equal(draftStore.getByThread('user-1', 'thread-1')[0].content, 'HIDDEN_ACTION_OUTPUT');

    const restart = await nextStartup(turns, harness.messageStore, draftStore);

    assert.equal(restart.settledResponseCount, 1);
    assertRejectedOutput(harness, route.responseMessageId);
    assert.equal(draftStore.getByThread('user-1', 'thread-1').length, 0);
    assert.deepEqual(pendingTurnIds(turns), []);
  });

  it('F117 KD-21: a hidden failure whose draft cannot be deleted still never publishes it', async () => {
    const draftStore = new DraftStore();
    const turns = new InMemoryTurnExecutionStore();
    const { harness, route, admit } = fencedHiddenFailure(draftStore, turns);
    const deleteDraft = draftStore.delete.bind(draftStore);
    let failures = 1;
    draftStore.delete = async (userId, threadId, invocationId) => {
      if (invocationId === 'turn-fenced' && failures > 0) {
        failures -= 1;
        throw new Error('redis unavailable');
      }
      return deleteDraft(userId, threadId, invocationId);
    };
    await admit();

    await harness.processor.requestDrain('thread-1');
    await waitFor(() =>
      harness.log.warn.mock.calls.some((call) => String(call.arguments[1]).includes('failed to settle a response')),
    );
    assertRejectedOutput(harness, route.responseMessageId);

    await nextStartup(turns, harness.messageStore, draftStore);

    assertRejectedOutput(harness, route.responseMessageId);
    assert.deepEqual(pendingTurnIds(turns), []);
  });

  it('F117 KD-21: a response the route committed takes its ended turn out of the ledger', async () => {
    const turns = new InMemoryTurnExecutionStore();
    let responseMessageId;
    const harness = createHarness({
      turnExecutionStore: turns,
      routeExecution: async function* (...args) {
        const [, , , , targetCats] = args;
        responseMessageId = (await startLifecycle(args, 'turn-done')).responseMessageId;
        // invoke-single-cat ends the turn before the route commits its R.
        await endChildTurn(turns, args, 'turn-done', { status: 'succeeded' });
        assert.deepEqual(pendingTurnIds(turns), ['turn-done']);
        const committed = await harness.messageStore.commitLifecycleResponseTerminal(responseMessageId, {
          invocationId: 'turn-done',
          status: 'completed',
          completedAt: Date.now(),
          content: 'answer',
          mentions: [],
          origin: 'stream',
        });
        assert.ok(committed.kind === 'applied' || committed.kind === 'replayed');
        yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: Date.now() };
      },
    });
    await admitMessage(harness);

    await harness.processor.requestDrain('thread-1');
    await waitFor(
      () => responseMessageId && harness.messageStore.getById(responseMessageId)?.lifecycle.status === 'completed',
    );
    // The processor's completion pass confirms the committed R after the route returns.
    await waitFor(() => pendingTurnIds(turns).length === 0);
  });

  it('F117 KD-23: a committed turn leaves the ledger only after its draft is gone', async () => {
    const draftStore = new DraftStore();
    const deleteDraft = draftStore.delete.bind(draftStore);
    let draftDeleteFailures = 1;
    draftStore.delete = (...args) => {
      if (draftDeleteFailures-- > 0) throw new Error('redis unavailable');
      return deleteDraft(...args);
    };
    const turns = new InMemoryTurnExecutionStore();
    let responseMessageId;
    const harness = createHarness({
      draftStore,
      turnExecutionStore: turns,
      routeExecution: async function* (...args) {
        const [userId, , threadId, , targetCats] = args;
        responseMessageId = (await startLifecycle(args, 'turn-done')).responseMessageId;
        draftStore.upsert({
          userId,
          threadId,
          invocationId: 'turn-done',
          catId: targetCats[0],
          content: 'answer',
          updatedAt: Date.now(),
        });
        await endChildTurn(turns, args, 'turn-done', { status: 'succeeded' });
        // The route commits R; its own early draft delete is not relied on.
        const committed = await harness.messageStore.commitLifecycleResponseTerminal(responseMessageId, {
          invocationId: 'turn-done',
          status: 'completed',
          completedAt: Date.now(),
          content: 'answer',
          mentions: [],
          origin: 'stream',
        });
        assert.ok(committed.kind === 'applied' || committed.kind === 'replayed');
        yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: Date.now() };
      },
    });
    await admitMessage(harness);

    await harness.processor.requestDrain('thread-1');
    await waitFor(() =>
      harness.log.warn.mock.calls.some((call) =>
        String(call.arguments[1]).includes('failed to release a settled response turn'),
      ),
    );
    assert.deepEqual(pendingTurnIds(turns), ['turn-done'], 'a draft that could not be deleted keeps its turn');
    assert.equal(draftStore.getByThread('user-1', 'thread-1').length, 1);

    const restart = await nextStartup(turns, harness.messageStore, draftStore);

    assert.equal(restart.settledResponseCount, 1);
    assert.deepEqual(draftStore.getByThread('user-1', 'thread-1'), [], 'the next startup deletes it');
    assert.deepEqual(pendingTurnIds(turns), []);
    assert.equal(harness.messageStore.getById(responseMessageId).content, 'answer', 'R keeps its committed body');
  });

  it('F117 KD-21: a route that throws fails the response it left processing with its draft body', async () => {
    const draftStore = new DraftStore();
    const turns = new InMemoryTurnExecutionStore();
    let responseMessageId;
    const harness = createHarness({
      draftStore,
      turnExecutionStore: turns,
      routeExecution: async function* (...args) {
        const [userId, , threadId, , targetCats] = args;
        const admission = await startLifecycle(args, 'turn-thrown');
        responseMessageId = admission.responseMessageId;
        draftStore.upsert({
          userId,
          threadId,
          invocationId: 'turn-thrown',
          catId: targetCats[0],
          content: '已经写到一半',
          updatedAt: Date.now(),
        });
        // An unfenced child, as invoke-single-cat creates it: its draft may be published.
        await endChildTurn(turns, args, 'turn-thrown', {
          status: 'failed',
          terminalReason: 'provider_execution_failed',
        });
        yield { type: 'text', catId: targetCats[0], content: '已经写到一半', timestamp: Date.now() };
        throw new Error('route exploded mid-stream');
      },
    });
    await admitMessage(harness);

    await harness.processor.requestDrain('thread-1');
    await waitFor(() => harness.messageStore.getById(responseMessageId)?.lifecycle.status === 'failed');

    const failed = harness.messageStore.getById(responseMessageId);
    assert.equal(failed.lifecycle.reason, 'execution_error');
    assert.equal(failed.content, '已经写到一半');
    assert.deepEqual(draftStore.getByThread('user-1', 'thread-1'), []);
    assert.equal(turns.get('turn-thrown').outputFence, 'open', 'an unfenced child records no verdict');
    assert.deepEqual(pendingTurnIds(turns), []);
  });

  it('a thrown admitted agent route preserves strict caller return provenance and wakes only that caller', async () => {
    const turns = new InMemoryTurnExecutionStore();
    let responseMessageId;
    const harness = createHarness({
      turnExecutionStore: turns,
      routeExecution: async function* (...args) {
        responseMessageId = (await startLifecycle(args, 'agent-thrown')).responseMessageId;
        await endChildTurn(turns, args, 'agent-thrown', { status: 'failed', terminalReason: 'provider_error' });
        throw new Error('admitted agent route failed');
      },
    });
    // The callback remains queued while its caller is busy; no test provider runs it.
    harness.invocationTracker.start('thread-1', 'codex', 'user-1', ['codex'], 'caller-busy');
    const admitted = await admitMessage(harness, { from: { kind: 'agent', catId: 'codex' } });
    await harness.processor.requestDrain('thread-1');
    await waitFor(
      () => responseMessageId && harness.messageStore.getById(responseMessageId)?.lifecycle.status === 'failed',
    );
    const response = harness.messageStore.getById(responseMessageId);
    assert.deepEqual(response.extra.a2aFailureReturn, {
      triggerMessageId: admitted.message.id,
      callerCatId: 'codex',
      ownerAuthProvenance: 'strict',
      parentInvocationId: response.extra.stream.invocationId,
      isFailureReport: false,
    });
    const rows = await harness.queue.listAllDurable('thread-1');
    const wake = rows.find((row) => row.sourceCategory === 'a2a_failure');
    assert.ok(wake);
    assert.deepEqual(wake.targets, ['codex']);
    assert.equal(wake.payload.messageId, response.id);
    await waitFor(() => pendingTurnIds(turns).length === 0);
  });

  it('keeps an exact target set queued when one sibling is busy', async () => {
    const harness = createHarness();
    bindActiveRun(harness, { catId: 'opus', invocationId: 'turn-busy-opus' });
    const admitted = await admitMessage(harness, { targetCats: ['opus', 'codex'] });
    const before = structuredClone(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id));

    const started = await harness.processor.processNext('thread-1', 'user-1');

    assert.equal(started.started, false);
    assert.equal(harness.router.routeExecution.mock.calls.length, 0);
    assert.deepEqual(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id), before);
  });

  it('starts the next source only after the prior source completes durable target handoff', async () => {
    let releaseFirstAdmission;
    const firstAdmission = new Promise((resolve) => {
      releaseFirstAdmission = resolve;
    });
    let releaseInvocations;
    const release = new Promise((resolve) => {
      releaseInvocations = resolve;
    });
    const routeOrder = [];
    const harness = createHarness({
      routeExecution: async function* (...args) {
        const [userId, content, threadId, , targetCats, , options] = args;
        routeOrder.push({ content, targetCats: [...targetCats] });
        if (content === 'source-one') await firstAdmission;
        await Promise.all(
          targetCats.map((catId) =>
            options.onLifecycleInvocationStarted({
              threadId,
              userId,
              catId,
              invocationId: `turn-${content}-${catId}`,
              parentInvocationId: options.parentInvocationId,
              startedAt: Date.now(),
            }),
          ),
        );
        await release;
        for (const catId of targetCats) {
          yield { type: 'done', catId, isFinal: true, timestamp: Date.now() };
        }
      },
    });
    await admitMessage(harness, { content: 'source-one', targetCats: ['opus', 'codex'] });
    await admitMessage(harness, { content: 'source-two', targetCats: ['gemini'] });

    await harness.processor.requestDrain('thread-1');
    try {
      await waitFor(() => routeOrder.length === 1, 250);
      await new Promise((resolve) => setTimeout(resolve, 25));
      assert.deepEqual(routeOrder, [{ content: 'source-one', targetCats: ['opus', 'codex'] }]);
      releaseFirstAdmission();
      await waitFor(() => routeOrder.length === 2, 250);
      assert.deepEqual(routeOrder, [
        { content: 'source-one', targetCats: ['opus', 'codex'] },
        { content: 'source-two', targetCats: ['gemini'] },
      ]);
    } finally {
      releaseFirstAdmission();
      releaseInvocations();
    }
  });

  it('treats a blocked try-drain as a no-op and retries from the active target terminal', async () => {
    let releaseFirst;
    const firstRun = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const calls = [];
    const harness = createHarness({
      routeExecution: async function* (...args) {
        calls.push(args);
        await startLifecycle(args, `turn-retry-${calls.length}`);
        if (calls.length === 1) await firstRun;
        yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
      },
    });
    const first = await admitMessage(harness, { content: 'first same-target source' });
    const second = await admitMessage(harness, { content: 'second same-target source' });

    await harness.processor.requestDrain('thread-1');
    await waitFor(() => calls.length === 1);
    await harness.processor.requestDrain('thread-1');
    await harness.processor.requestDrain('thread-1');
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.equal(calls.length, 1);
    assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', first.entry.id), null);
    assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', second.entry.id)?.status, 'queued');

    releaseFirst();
    await waitFor(() => calls.length === 2);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', second.entry.id) === null);
  });

  it('restores a claimed target when routing fails before the response receiver exists', async () => {
    let atRouter;
    let harness;
    harness = createHarness({
      routeExecution: async function* () {
        atRouter = {
          queue: harness.queue.list('thread-1', 'user-1'),
          history: harness.messageStore.getByThread('thread-1', 50, 'user-1'),
        };
        throw new Error('injected before lifecycle receiver');
      },
    });
    const admitted = await admitMessage(harness);

    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await waitFor(
      () =>
        harness.invocationRecordStore.records.get('inv-1')?.status === 'failed' &&
        !harness.invocationTracker.has('thread-1'),
    );

    assert.equal(atRouter.queue.length, 1, 'the short claim must still own the target at the router boundary');
    assert.equal(atRouter.queue[0].status, 'claimed');
    assert.equal(
      atRouter.history.some((message) => message.lifecycle?.kind === 'response'),
      false,
    );
    const restored = harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id);
    assert.equal(restored.status, 'queued');
    assert.deepEqual(restored.targets, ['opus']);
    assert.equal((await harness.messageStore.getById(admitted.message.id)).lifecycle.dispatchRefs.length, 0);
  });

  it('keeps the History receiver when Queue retirement loses its acknowledgement', async () => {
    const harness = createHarness();
    const admitted = await admitMessage(harness);
    const originalRetire = harness.queue.retireClaimedLifecycleTarget.bind(harness.queue);
    let injected = false;
    harness.queue.retireClaimedLifecycleTarget = mock.fn(async (...args) => {
      if (!injected) {
        injected = true;
        await originalRetire(...args);
        throw new Error('injected Queue retirement acknowledgement loss');
      }
      return originalRetire(...args);
    });

    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await waitFor(
      () =>
        harness.invocationRecordStore.records.get('inv-1')?.status === 'failed' &&
        !harness.invocationTracker.has('thread-1'),
    );

    const source = await harness.messageStore.getById(admitted.message.id);
    assert.deepEqual(
      source.lifecycle.dispatchRefs.map((ref) => [ref.targetId, ref.phase]),
      [['opus', 'settled']],
    );
    const response = await harness.messageStore.getById(source.lifecycle.dispatchRefs[0].statusMessageId);
    assert.equal(response.lifecycle.kind, 'response');
    assert.ok(
      response.lifecycle.latestInputTimelineOrderAt >= source.timelineOrderAt,
      'the receiver presentation floor must include its triggering input',
    );
    assert.equal(response.lifecycle.status, 'interrupted');
    assert.equal(response.lifecycle.reason, 'queue_target_retirement_pending');
    assert.equal(await harness.queue.getDurableEntry('thread-1', admitted.entry.id), null);
  });

  it('publishes queued input at durable dequeue time even when provider start is delayed', async () => {
    let harness;
    let claimedAt;
    harness = createHarness({
      routeExecution: async function* (...args) {
        const [userId, , threadId, , targetCats, , options] = args;
        const claimed = harness.queue.list(threadId, userId)[0];
        assert.equal(claimed.status, 'claimed');
        claimedAt = claimed.claimedAt;
        assert.ok(Number.isFinite(claimedAt));
        await new Promise((resolve) => setTimeout(resolve, 10));
        await options.onLifecycleInvocationStarted({
          threadId,
          userId,
          catId: targetCats[0],
          invocationId: 'turn-delayed-provider-start',
          parentInvocationId: options.parentInvocationId,
          startedAt: Date.now(),
        });
        yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: Date.now() };
      },
    });
    const admitted = await admitMessage(harness);

    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await waitFor(() => harness.invocationRecordStore.records.get('inv-1')?.status === 'succeeded');

    const source = await harness.messageStore.getById(admitted.message.id);
    const response = await harness.messageStore.getById(source.lifecycle.dispatchRefs[0].statusMessageId);
    assert.equal(source.deliveredAt, claimedAt, 'source delivery must reuse the durable dequeue clock');
    assert.equal(source.timelineOrderAt, claimedAt);
    assert.ok(response.lifecycle.startedAt > source.timelineOrderAt);
  });

  it('preserves the enqueue clock floor if the durable Queue clock runs ahead of wall time', async () => {
    const harness = createHarness();
    harness.queue.lastEnqueuedAt = Date.now() + 10_000;
    const admitted = await admitMessage(harness);
    assert.ok(admitted.entry.enqueuedAt > Date.now());

    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await waitFor(() => harness.invocationRecordStore.records.get('inv-1')?.status === 'succeeded');

    const source = await harness.messageStore.getById(admitted.message.id);
    const response = await harness.messageStore.getById(source.lifecycle.dispatchRefs[0].statusMessageId);
    assert.equal(source.deliveredAt, admitted.entry.enqueuedAt);
    assert.equal(source.timelineOrderAt, admitted.entry.enqueuedAt);
    assert.ok(response.lifecycle.startedAt < source.timelineOrderAt);
    assert.ok(response.lifecycle.latestInputTimelineOrderAt >= source.timelineOrderAt);
  });

  it('restores only the target whose parallel admission failed before its dispatchRef committed', async () => {
    let harness;
    harness = createHarness({
      routeExecution: async function* (...args) {
        const [userId, , threadId, , targetCats, , options] = args;
        harness.processor.suppressAutoResume(threadId, targetCats[0], [options.parentInvocationId]);
        const admissions = await Promise.allSettled(
          targetCats.map((catId) =>
            options.onLifecycleInvocationStarted({
              threadId,
              userId,
              catId,
              invocationId: `turn-partial-admission-${catId}`,
              parentInvocationId: options.parentInvocationId,
              startedAt: Date.now(),
            }),
          ),
        );
        for (const [index, admission] of admissions.entries()) {
          const catId = targetCats[index];
          if (admission.status === 'fulfilled') {
            const terminal = await harness.messageStore.commitLifecycleResponseTerminal(
              admission.value.responseMessageId,
              {
                invocationId: `turn-partial-admission-${catId}`,
                status: 'completed',
                completedAt: Date.now(),
                content: `${catId} completed`,
                mentions: [],
                origin: 'stream',
              },
            );
            assert.ok(terminal.kind === 'applied' || terminal.kind === 'replayed');
            await settleLifecycleResponseInputs(
              harness.messageStore,
              terminal.message,
              admission.value.responseMessageId,
            );
            yield { type: 'done', catId, isFinal: true, timestamp: Date.now() };
          } else {
            yield {
              type: 'error',
              catId,
              error: admission.reason,
              errorDisposition: 'terminal',
              timestamp: Date.now(),
            };
          }
        }
      },
    });
    const admitted = await admitMessage(harness, { targetCats: ['opus', 'codex'] });
    const originalAdvance = harness.messageStore.advanceLifecycleInputDispatch.bind(harness.messageStore);
    harness.messageStore.advanceLifecycleInputDispatch = mock.fn(async (messageId, patch) =>
      patch.targetId === 'codex'
        ? { kind: 'conflict', reason: 'injected_parallel_admission_conflict' }
        : originalAdvance(messageId, patch),
    );

    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await waitFor(
      () =>
        !harness.invocationTracker.has('thread-1') &&
        harness.messageStore
          .getByThread('thread-1', 50, 'user-1')
          .some(
            (message) =>
              message.lifecycle?.kind === 'response' &&
              message.lifecycle.targetId === 'opus' &&
              message.lifecycle.status === 'completed',
          ),
    );
    assert.equal(harness.invocationRecordStore.records.get('inv-1')?.status, 'succeeded');

    const source = await harness.messageStore.getById(admitted.message.id);
    assert.deepEqual(
      source.lifecycle.dispatchRefs.map((ref) => [ref.targetId, ref.phase]),
      [['opus', 'settled']],
    );
    const remaining = await harness.queue.getDurableEntry('thread-1', admitted.entry.id);
    assert.equal(remaining.status, 'queued');
    assert.deepEqual(remaining.targets, ['codex']);
    const responses = harness.messageStore
      .getByThread('thread-1', 50, 'user-1')
      .filter((message) => message.lifecycle?.kind === 'response');
    assert.equal(responses.length, 2);
    const responseByTarget = new Map(responses.map((message) => [message.lifecycle.targetId, message]));
    assert.equal(responseByTarget.get('opus').lifecycle.status, 'completed');
    assert.equal(responseByTarget.get('codex').lifecycle.status, 'interrupted');
    assert.equal(responseByTarget.get('codex').lifecycle.reason, 'input_dispatch_projection_conflict');
  });

  it('records child awakening and prompt exposure only on the process-local attempt', async () => {
    const childInvocationId = 'turn-receipt-evidence';
    const startedAt = Date.now();
    let harness;
    let observedAttempt;
    let observedEvidence;
    harness = createHarness({
      routeExecution: async function* (...args) {
        const [userId, , threadId, messageId, targetCats, , options] = args;
        await options.onLifecycleInvocationStarted({
          threadId,
          userId,
          catId: targetCats[0],
          invocationId: childInvocationId,
          parentInvocationId: options.parentInvocationId,
          startedAt,
        });
        await options.onPromptMessagesExposed({
          threadId,
          userId,
          catId: targetCats[0],
          invocationId: childInvocationId,
          messageIds: [messageId],
          seenAt: startedAt + 1,
        });
        observedAttempt = harness.queue.findProcessingByCat(threadId, targetCats[0]);
        observedEvidence = harness.queue.getAdmittedAttemptEvidence(
          threadId,
          observedAttempt.id,
          targetCats[0],
          userId,
        );
        yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: startedAt + 2 };
      },
    });
    const admitted = await admitMessage(harness);

    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id) === null);

    assert.equal(await harness.queue.getDurableEntry('thread-1', admitted.entry.id), null);
    assert.equal(observedAttempt.status, 'processing');
    assert.equal(observedEvidence.awakenedInvocationId, childInvocationId);
    assert.equal(observedEvidence.awakenedAt, startedAt);
    assert.equal(observedEvidence.seenInvocationId, childInvocationId);
    assert.equal(observedEvidence.seenAt, startedAt + 1);
    assert.equal('bodyExposures' in observedAttempt.delivery, false);
  });

  it('adopts an exactly exposed target into the current response and leaves sibling targets queued', async () => {
    const harness = createHarness();
    const admitted = await admitMessage(harness, { targetCats: ['opus', 'codex'] });
    const sourceEntry = admitted.entry;

    const { invocationId, response, startedAt } = bindActiveRun(harness);

    const result = await harness.processor.adoptExposedQueuedEntries({
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'opus',
      invocationId,
      entries: [{ entryId: sourceEntry.id, messageId: admitted.message.id }],
      seenAt: startedAt + 1,
    });

    assert.deepEqual(result, { outcome: 'adopted', adoptedEntryIds: [sourceEntry.id] });
    const durable = await harness.queue.getDurableEntry('thread-1', sourceEntry.id);
    assert.equal(durable.status, 'queued');
    assert.deepEqual(durable.targets, ['codex']);
    assert.equal(durable.delivery.seenInvocationId, undefined);
    assert.equal('bodyExposures' in durable.delivery, false);

    const source = await harness.messageStore.getById(admitted.message.id);
    assert.equal(source.deliveryStatus, 'delivered');
    assert.equal(source.lifecycle.dispatchRefs.length, 1);
    assert.equal(source.lifecycle.dispatchRefs[0].targetId, 'opus');
    assert.equal(source.lifecycle.dispatchRefs[0].phase, 'dispatched');
    assert.equal(source.lifecycle.dispatchRefs[0].statusMessageId, response.id);
    assert.equal(source.lifecycle.dispatchRefs[0].dispatchedAt, startedAt + 1);
    assert.deepEqual((await harness.messageStore.getById(response.id)).lifecycle.inputMessageIds, [
      admitted.message.id,
    ]);
    assert.deepEqual(harness.invocationTracker.getActiveSlots('thread-1')[0].activeRun.inputEntryIds, [sourceEntry.id]);
    assert.deepEqual(harness.invocationTracker.getActiveSlots('thread-1')[0].activeRun.inputMessageIds, [
      admitted.message.id,
    ]);
  });

  it('settles multi-target Append independently when one provider accepts and its sibling rejects', async () => {
    const harness = createHarness();
    const admitted = await admitMessage(harness, { targetCats: ['opus', 'codex'] });
    const opus = bindActiveRun(harness, {
      catId: 'opus',
      invocationId: 'turn-append-opus',
      parentInvocationId: 'parent-opus',
    });
    const codex = bindActiveRun(harness, {
      catId: 'codex',
      invocationId: 'turn-append-codex',
      parentInvocationId: 'parent-codex',
    });
    const opusDispatch = mock.fn(async () => ({ accepted: true, handle: {} }));
    const codexDispatch = mock.fn(async () => ({ accepted: false, reason: 'provider_rejected' }));
    assert.ok(
      harness.invocationTracker.bindAgentClientActiveRunDispatcher('thread-1', 'opus', {
        invocationId: opus.invocationId,
        capabilities: { append: true, steer: true },
        handle: { provider: 'anthropic', carrier: 'claude_print_sdk' },
        dispatch: opusDispatch,
      }),
    );
    assert.ok(
      harness.invocationTracker.bindAgentClientActiveRunDispatcher('thread-1', 'codex', {
        invocationId: codex.invocationId,
        capabilities: { append: true, steer: true },
        handle: { provider: 'openai_codex', carrier: 'codex_app_server' },
        dispatch: codexDispatch,
      }),
    );

    const expectedRuns = [
      { targetId: 'opus', invocationId: opus.invocationId, responseMessageId: opus.response.id },
      { targetId: 'codex', invocationId: codex.invocationId, responseMessageId: codex.response.id },
    ];
    assert.deepEqual(
      await harness.processor.appendExactEntry({
        threadId: 'thread-1',
        userId: 'user-1',
        entryId: admitted.entry.id,
        expectedQueueRevision: 'stale-revision',
        expectedRuns,
      }),
      { outcome: 'rejected', reason: 'state_changed' },
    );
    assert.equal(opusDispatch.mock.calls.length, 0);
    assert.equal(codexDispatch.mock.calls.length, 0);

    const result = await harness.processor.appendExactEntry({
      threadId: 'thread-1',
      userId: 'user-1',
      entryId: admitted.entry.id,
      expectedQueueRevision: harness.queue.snapshotRevision('thread-1', 'user-1'),
      expectedRuns,
    });

    assert.equal(result.outcome, 'appended');
    assert.deepEqual(result.acceptedTargetIds, ['opus']);
    assert.deepEqual(result.rejectedTargetIds, ['codex']);
    assert.equal(opusDispatch.mock.calls.length, 1);
    assert.equal(codexDispatch.mock.calls.length, 1);
    assert.equal(await harness.queue.getDurableEntry('thread-1', admitted.entry.id), null);
    assert.deepEqual(
      (await harness.messageStore.getById(admitted.message.id)).lifecycle.dispatchRefs.map((ref) => [
        ref.targetId,
        ref.phase,
      ]),
      [
        ['opus', 'dispatched'],
        ['codex', 'settled'],
      ],
    );
  });

  it('retires Append on client acceptance and keeps optional read proof on its exact response only', async () => {
    const harness = createHarness();
    const admitted = await admitMessage(harness, { targetCats: ['opus', 'codex'] });
    const runs = ['opus', 'codex'].map((catId) =>
      bindActiveRun(harness, { catId, invocationId: `read-${catId}`, parentInvocationId: `parent-${catId}` }),
    );
    const inputs = new Map();
    for (let index = 0; index < runs.length; index++) {
      const run = runs[index];
      const catId = index === 0 ? 'opus' : 'codex';
      harness.invocationTracker.bindAgentClientActiveRunDispatcher('thread-1', catId, {
        invocationId: run.invocationId,
        capabilities: { append: true, steer: true, ...(catId === 'opus' ? { inputReadReceipt: true } : {}) },
        handle: { provider: 'anthropic', carrier: 'claude_agent_sdk' },
        dispatch: async (input) => {
          inputs.set(catId, input);
          return { accepted: true, handle: {} };
        },
      });
    }
    const result = await harness.processor.appendExactEntry({
      threadId: 'thread-1',
      userId: 'user-1',
      entryId: admitted.entry.id,
      expectedQueueRevision: harness.queue.snapshotRevision('thread-1', 'user-1'),
      expectedRuns: runs.map((run, index) => ({
        targetId: index === 0 ? 'opus' : 'codex',
        invocationId: run.invocationId,
        responseMessageId: run.response.id,
      })),
    });
    assert.equal(result.outcome, 'appended');
    assert.equal(await harness.queue.getDurableEntry('thread-1', admitted.entry.id), null);
    const before = await harness.messageStore.getById(admitted.message.id);
    assert.deepEqual(before.lifecycle.dispatchRefs[0].inputRead, { status: 'pending' });
    assert.equal(before.lifecycle.dispatchRefs[1].inputRead, undefined);
    assert.equal(inputs.get('codex').onInputRead, undefined);
    // A terminal event may win the persistence race; late proof must not revert it.
    const ref = before.lifecycle.dispatchRefs[0];
    await harness.messageStore.advanceLifecycleInputDispatch(admitted.message.id, {
      ...ref,
      orderKey: before.lifecycle.orderKey,
      phase: 'settled',
    });
    await inputs.get('opus').onInputRead();
    await inputs.get('opus').onInputRead();
    const after = await harness.messageStore.getById(admitted.message.id);
    assert.equal(after.lifecycle.dispatchRefs[0].phase, 'settled');
    assert.equal(after.lifecycle.dispatchRefs[0].inputRead.status, 'read');
    assert.deepEqual(after.lifecycle.dispatchRefs[1], before.lifecycle.dispatchRefs[1]);
    assert.equal(await harness.queue.getDurableEntry('thread-1', admitted.entry.id), null);
    assert.deepEqual((await harness.messageStore.getById(runs[0].response.id)).lifecycle.inputMessageIds, [
      admitted.message.id,
    ]);
  });

  it('restores the exact row without attaching it when History publication fails', async () => {
    const harness = createHarness();
    const admitted = await admitMessage(harness);
    const { invocationId, response, startedAt } = bindActiveRun(harness);
    const markDelivered = mock.method(harness.messageStore, 'markDelivered', () => null);

    const result = await harness.processor.adoptExposedQueuedEntries({
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'opus',
      invocationId,
      entries: [{ entryId: admitted.entry.id, messageId: admitted.message.id }],
      seenAt: startedAt + 1,
    });
    markDelivered.mock.restore();

    assert.deepEqual(result, {
      outcome: 'rejected',
      reason: 'persistence_unavailable',
      entryId: admitted.entry.id,
    });
    assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id)?.status, 'queued');
    assert.equal((await harness.messageStore.getById(admitted.message.id)).deliveryStatus, 'queued');
    assert.deepEqual((await harness.messageStore.getById(response.id)).lifecycle.inputMessageIds, []);
    assert.deepEqual(harness.invocationTracker.getActiveSlots('thread-1')[0].activeRun.inputMessageIds, []);
  });

  it('keeps lifecycle-owned adoption outside Queue when target removal persistence must fail closed', async () => {
    const harness = createHarness();
    const admitted = await admitMessage(harness);
    const { invocationId, response, startedAt } = bindActiveRun(harness);
    const commitExposure = mock.method(harness.queue, 'commitClaimedAdoptionDurable', async () => null);
    const terminalize = mock.method(harness.queue, 'removeProcessedDurable', async () => null);

    const result = await harness.processor.adoptExposedQueuedEntries({
      threadId: 'thread-1',
      userId: 'user-1',
      catId: 'opus',
      invocationId,
      entries: [{ entryId: admitted.entry.id, messageId: admitted.message.id }],
      seenAt: startedAt + 1,
    });
    commitExposure.mock.restore();
    terminalize.mock.restore();

    assert.deepEqual(result, {
      outcome: 'rejected',
      reason: 'persistence_unavailable',
      entryId: admitted.entry.id,
    });
    assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id), null);
    assert.equal(harness.queue.findProcessingByCat('thread-1', 'opus')?.status, 'processing');
    assert.equal((await harness.messageStore.getById(admitted.message.id)).deliveryStatus, 'delivered');
    assert.deepEqual((await harness.messageStore.getById(response.id)).lifecycle.inputMessageIds, [
      admitted.message.id,
    ]);
  });

  it('admits consecutive FIFO sources separately without concatenating bodies', async () => {
    const calls = [];
    const harness = createHarness({
      routeExecution: async function* (...args) {
        calls.push(args);
        await startLifecycle(args, `turn-fifo-source-${calls.length}`);
        yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
      },
    });
    const first = await admitMessage(harness, { content: 'first author body' });
    const second = await admitMessage(harness, { content: 'second author body' });

    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await waitFor(() => harness.queue.list('thread-1', 'user-1').length === 0);

    assert.equal(calls.length, 2, JSON.stringify(errorLog(harness)));
    assert.deepEqual(
      calls.map(([userId, content, threadId, messageId, targetCats, , options]) => ({
        userId,
        content,
        threadId,
        messageId,
        targetCats,
        promptMessages: options.persistedPromptMessages.map((message) => ({
          messageId: message.messageId,
          content: message.content,
        })),
      })),
      [
        {
          userId: 'user-1',
          content: 'first author body',
          threadId: 'thread-1',
          messageId: first.message.id,
          targetCats: ['opus'],
          promptMessages: [{ messageId: first.message.id, content: 'first author body' }],
        },
        {
          userId: 'user-1',
          content: 'second author body',
          threadId: 'thread-1',
          messageId: second.message.id,
          targetCats: ['opus'],
          promptMessages: [{ messageId: second.message.id, content: 'second author body' }],
        },
      ],
    );
  });

  it('keeps provider failure out of Queue after admission', async () => {
    const harness = createHarness({
      routeExecution: async function* (...args) {
        await startLifecycle(args, 'turn-provider-failure');
        throw new Error('provider failed');
      },
    });
    const admitted = await admitMessage(harness);

    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id) === null);

    assert.equal(await harness.queue.getDurableEntry('thread-1', admitted.entry.id), null);
  });

  it('does not enqueue a runtime-replacement continuation after the recovered turn completes', async () => {
    const capsule = {
      v: 1,
      threadId: 'thread-1',
      catId: 'opus',
      invocationId: 'turn-recovered',
      mode: 'independent',
      a2aEnabled: true,
      ballState: 'in_progress',
      continuationReason: 'runtime_replacement',
      createdAt: 2_000,
      seal: { sessionId: 'session-old', sessionSeq: 2, reason: 'cli_session_replaced' },
      replacement: {
        cause: 'active_writer_reborn',
        previousNativeThreadId: 'native-old',
        detectedAt: 1_900,
        attempt: 1,
        diagnostics: {
          observedAt: 1_900,
          classification: 'native_active_turn_without_local_lease',
          confidence: 'medium',
          localHostLease: { state: 'not_observed', source: 'carrier_affinity' },
          nativeThread: {
            readOutcome: 'succeeded',
            threadId: 'native-old',
            status: 'active',
            activeTurn: { turnId: 'turn-old', startedAt: 1_800 },
          },
          writerClientIdentity: 'unavailable',
        },
      },
    };
    let routeInvocations = 0;
    const harness = createHarness({
      routeExecution: async function* (...args) {
        routeInvocations++;
        await startLifecycle(args, `turn-runtime-replacement-${routeInvocations}`);
        if (routeInvocations === 1) {
          yield {
            type: 'system_info',
            catId: 'opus',
            content: JSON.stringify({ type: 'session_seal_requested', continuityCapsule: capsule }),
            timestamp: 2_000,
          };
        }
        yield { type: 'done', catId: 'opus', isFinal: true, timestamp: 2_001 };
      },
    });
    const admitted = await admitMessage(harness);

    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id) === null);

    assert.deepEqual(harness.queue.list('thread-1', 'user-1'), []);
    assert.equal(routeInvocations, 1, 'a completed recovery attempt must not create a second provider turn');
  });

  it('keeps a canceled admitted attempt out of Queue instead of rolling it back behind later work', async () => {
    let releaseProvider;
    let providerStarted;
    const providerStartedPromise = new Promise((resolve) => {
      providerStarted = resolve;
    });
    const harness = createHarness({
      routeExecution: async function* (...args) {
        await startLifecycle(args, 'turn-canceled-admitted');
        providerStarted();
        await new Promise((resolve) => {
          releaseProvider = resolve;
        });
      },
    });
    const first = await admitMessage(harness, { content: 'first' });
    const second = await admitMessage(harness, { content: 'second', targetCats: ['codex'] });

    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await providerStartedPromise;
    harness.invocationTracker.cancel('thread-1', 'opus', 'user-1', 'preempted');
    releaseProvider();
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', first.entry.id) === null);

    assert.equal(await harness.queue.getDurableEntry('thread-1', first.entry.id), null);
    assert.equal(
      harness.queue.list('thread-1', 'user-1').some((entry) => entry.id === first.entry.id),
      false,
    );
    assert.equal(
      harness.queue.list('thread-1', 'user-1').some((entry) => entry.id === second.entry.id),
      true,
    );
  });

  it('commits an exact Steer target out of Queue before provider execution', async () => {
    let harness;
    let observedStatus;
    harness = createHarness({
      routeExecution: async function* (...args) {
        await startLifecycle(args, 'turn-exact-steer');
        observedStatus = harness.queue.findProcessingByCat('thread-1', 'opus')?.status;
        yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
      },
    });
    const admitted = await admitMessage(harness);
    const claim = await harness.queue.claimExactSteerEntryDurable('thread-1', 'user-1', admitted.entry.id, 'opus');
    assert.equal(claim.outcome, 'claimed');
    assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id).status, 'claimed');

    const started = await harness.processor.processClaimedSteerEntries(
      'thread-1',
      'user-1',
      [admitted.entry.id],
      'opus',
    );
    assert.equal(started.started, true);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id) === null);
    assert.equal(observedStatus, 'processing', JSON.stringify(errorLog(harness)));
  });

  it('restores a claimed Steer row in its original place when the target slot is busy', async () => {
    const harness = createHarness();
    const admitted = await admitMessage(harness);
    const claim = await harness.queue.claimExactSteerEntryDurable('thread-1', 'user-1', admitted.entry.id, 'opus');
    assert.equal(claim.outcome, 'claimed');
    harness.invocationTracker.start('thread-1', 'opus', 'user-1');

    const started = await harness.processor.processClaimedSteerEntries(
      'thread-1',
      'user-1',
      [admitted.entry.id],
      'opus',
    );
    assert.equal(started.started, false);
    assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id).status, 'queued');
  });

  it('removes a public head and publishes failure when explicit routing resolves no target', async () => {
    const harness = createHarness();
    harness.router.resolveConversationTargetsAtAdmission.mock.mockImplementation(async () => []);
    const admitted = await admitMessage(harness);

    const result = await harness.processor.processNext('thread-1', 'user-1');
    assert.equal(result.started, false);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id) === null);
    assert.equal(await harness.queue.getDurableEntry('thread-1', admitted.entry.id), null);
    const history = harness.messageStore.getByThread('thread-1');
    assert.ok(history.some((message) => message.lifecycle?.kind === 'delivery_failure'));
  });

  it('keeps a targetless head queued while the thread is active and resolves it only after idle', async () => {
    const harness = createHarness();
    const admitted = await admitMessage(harness, { targetCats: [] });
    harness.invocationTracker.start('thread-1', 'codex', 'user-1');

    const blocked = await harness.processor.processNext('thread-1', 'user-1');
    assert.equal(blocked.started, false);
    assert.equal(
      harness.router.resolveConversationTargetsAtAdmission.mock.callCount(),
      0,
      'an active thread must not guess a target for a targetless head',
    );
    assert.equal(harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id).status, 'queued');

    harness.invocationTracker.complete('thread-1', 'codex');
    const resumed = await harness.processor.processNext('thread-1', 'user-1');
    assert.equal(resumed.started, true);
    assert.equal(harness.router.resolveConversationTargetsAtAdmission.mock.callCount(), 1);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', admitted.entry.id) === null);
  });

  it('injects a caller terminal observation on its next natural turn and clears only after success', async () => {
    const observedPrompts = [];
    let turnSequence = 0;
    const harness = createHarness({
      routeExecution: async function* (...args) {
        turnSequence += 1;
        const [userId, , threadId, , targetCats, , options] = args;
        observedPrompts.push(options.modeSystemPromptByCat?.[targetCats[0]] ?? '');
        await options.onLifecycleInvocationStarted({
          threadId,
          userId,
          catId: targetCats[0],
          invocationId: `turn-observation-${turnSequence}`,
          parentInvocationId: options.parentInvocationId,
          startedAt: Date.now(),
        });
        yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: Date.now() };
      },
    });

    const outbound = await admitMessage(harness, {
      from: { kind: 'agent', catId: 'caller' },
      targetCats: ['worker'],
    });
    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', outbound.entry.id) === null);

    const source = await harness.messageStore.getById(outbound.message.id);
    const responseId = source.lifecycle.dispatchRefs[0].statusMessageId;
    const response = await harness.messageStore.getById(responseId);
    const terminal = await harness.messageStore.commitLifecycleResponseTerminal(responseId, {
      invocationId: response.lifecycle.invocationId,
      status: 'completed',
      completedAt: Date.now(),
      content: 'worker finished',
      mentions: [],
      origin: 'stream',
    });
    assert.ok(terminal.kind === 'applied' || terminal.kind === 'replayed');
    await settleLifecycleResponseInputs(harness.messageStore, terminal.message, responseId);
    assert.equal(harness.queue.list('thread-1', 'user-1').length, 0, 'terminal observation must not wake caller');

    const callerWake = await admitMessage(harness, { targetCats: ['caller'] });
    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', callerWake.entry.id) === null);
    assert.match(observedPrompts[1], /→ worker: completed/);
    assert.match(observedPrompts[1], /worker finished/);

    const nextCallerWake = await admitMessage(harness, { targetCats: ['caller'] });
    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', nextCallerWake.entry.id) === null);
    assert.equal(observedPrompts[2], '');
  });

  it('registers a persisted direct delivery failure for the caller without creating a wake', async () => {
    const observedPrompts = [];
    const harness = createHarness({
      routeExecution: async function* (...args) {
        const [userId, , threadId, , targetCats, , options] = args;
        observedPrompts.push(options.modeSystemPromptByCat?.[targetCats[0]] ?? '');
        await options.onLifecycleInvocationStarted({
          threadId,
          userId,
          catId: targetCats[0],
          invocationId: 'turn-after-delivery-failure',
          parentInvocationId: options.parentInvocationId,
          startedAt: Date.now(),
        });
        yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: Date.now() };
      },
    });
    harness.router.resolveConversationTargetsAtAdmission.mock.mockImplementation(async () => []);
    const outbound = await admitMessage(harness, {
      from: { kind: 'agent', catId: 'caller' },
      targetCats: ['missing'],
    });
    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, false);
    assert.equal(harness.queue.list('thread-1', 'user-1').length, 0, 'terminal observation must not enqueue caller');

    harness.router.resolveConversationTargetsAtAdmission.mock.mockImplementation(async (targets) => [...targets]);
    const callerWake = await admitMessage(harness, { targetCats: ['caller'] });
    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', callerWake.entry.id) === null);
    assert.match(observedPrompts[0], /delivery_failure\(invalid_explicit_target\)/);
    assert.match(observedPrompts[0], new RegExp(outbound.message.id));
  });

  it('retains an included terminal observation when the caller invocation fails', async () => {
    const observedPrompts = [];
    let callerAttempt = 0;
    const registry = new CallerDispatchObservationRegistry();
    const harness = createHarness({
      callerDispatchObservationRegistry: registry,
      routeExecution: async function* (...args) {
        const [userId, , threadId, , targetCats, , options] = args;
        observedPrompts.push(options.modeSystemPromptByCat?.[targetCats[0]] ?? '');
        callerAttempt += 1;
        await options.onLifecycleInvocationStarted({
          threadId,
          userId,
          catId: targetCats[0],
          invocationId: `turn-retain-${callerAttempt}`,
          parentInvocationId: options.parentInvocationId,
          startedAt: Date.now(),
        });
        if (callerAttempt === 1) throw new Error('provider failed after prompt admission');
        yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: Date.now() };
      },
    });
    const response = await harness.messageStore.append({
      from: { kind: 'agent', catId: 'worker' },
      userId: 'user-1',
      content: 'worker finished',
      mentions: [],
      origin: 'stream',
      timestamp: 2,
      threadId: 'thread-1',
      lifecycle: {
        kind: 'response',
        orderKey: '2:response-worker',
        invocationId: 'inv-worker',
        targetId: 'worker',
        inputEntryIds: ['entry-source'],
        inputMessageIds: [],
        status: 'completed',
        startedAt: 1,
        completedAt: 2,
      },
    });
    const source = await harness.messageStore.append({
      from: { kind: 'agent', catId: 'caller' },
      userId: 'user-1',
      content: '@worker handle this',
      mentions: ['worker'],
      origin: 'stream',
      timestamp: 1,
      threadId: 'thread-1',
      lifecycle: {
        kind: 'input',
        orderKey: '1:source-caller',
        dispatchRefs: [{ targetId: 'worker', phase: 'settled', statusMessageId: response.id, dispatchedAt: 1 }],
      },
    });
    response.lifecycle.inputMessageIds.push(source.id);
    registry.registerPersistedSource(source, ['worker']);

    const firstWake = await admitMessage(harness, { targetCats: ['caller'] });
    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', firstWake.entry.id) === null);
    assert.match(observedPrompts[0], /worker finished/);
    assert.equal(registry.list({ ownerId: 'user-1', threadId: 'thread-1', callerCatId: 'caller' }).length, 1);

    const secondWake = await admitMessage(harness, { targetCats: ['caller'] });
    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', secondWake.entry.id) === null);
    assert.match(observedPrompts[1], /worker finished/);
    assert.equal(registry.list({ ownerId: 'user-1', threadId: 'thread-1', callerCatId: 'caller' }).length, 0);
  });

  it('delivers one process-start notice without scanning History and keeps current-process observations independent', async () => {
    const observedPrompts = [];
    let invocationAttempt = 0;
    const registry = new CallerDispatchObservationRegistry();
    const harness = createHarness({
      callerDispatchObservationRegistry: registry,
      processorOptions: {
        callerDispatchProcessStart: {
          processGenerationId: 'api:restart-test:42',
        },
      },
      routeExecution: async function* (...args) {
        const [userId, , threadId, , targetCats, , options] = args;
        observedPrompts.push(options.modeSystemPromptByCat?.[targetCats[0]] ?? '');
        invocationAttempt += 1;
        await options.onLifecycleInvocationStarted({
          threadId,
          userId,
          catId: targetCats[0],
          invocationId: `turn-after-process-start-${invocationAttempt}`,
          parentInvocationId: options.parentInvocationId,
          startedAt: Date.now(),
        });
        if (invocationAttempt === 1) throw new Error('first process-start prompt was not completed');
        yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: Date.now() };
      },
    });

    for (let index = 0; index < 250; index += 1) {
      await harness.messageStore.append({
        from: { kind: 'user', userId: 'user-1' },
        userId: 'user-1',
        content: `old history ${index}`,
        mentions: [],
        timestamp: index + 1,
        threadId: 'thread-1',
      });
    }
    const getByThreadBefore = harness.messageStore.getByThreadBefore.bind(harness.messageStore);
    harness.messageStore.getByThreadBefore = mock.fn((...args) => getByThreadBefore(...args));

    const source = await harness.messageStore.append({
      from: { kind: 'agent', catId: 'caller' },
      userId: 'user-1',
      content: '@worker current process work',
      mentions: ['worker'],
      origin: 'stream',
      timestamp: 300,
      threadId: 'thread-1',
      lifecycle: {
        kind: 'input',
        orderKey: '300:current-process-source',
        dispatchRefs: [
          { targetId: 'worker', phase: 'dispatched', statusMessageId: 'response-current', dispatchedAt: 300 },
        ],
      },
    });
    registry.registerPersistedSource(source, ['worker']);

    const callerWake = await admitMessage(harness, { targetCats: ['caller'] });
    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', callerWake.entry.id) === null);
    assert.match(observedPrompts[0], /process_start processGeneration=api:restart-test:42/);
    assert.match(observedPrompts[0], new RegExp(`${source.id} → worker: executing`));
    assert.doesNotMatch(observedPrompts[0], /runtime_restart|recoveryRequired|old history/);

    const retryWake = await admitMessage(harness, { targetCats: ['caller'] });
    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', retryWake.entry.id) === null);
    assert.match(observedPrompts[1], /process_start processGeneration=api:restart-test:42/);
    assert.match(observedPrompts[1], new RegExp(`${source.id} → worker: executing`));

    const afterAckWake = await admitMessage(harness, { targetCats: ['caller'] });
    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await waitFor(() => harness.queue.getEntrySnapshot('thread-1', 'user-1', afterAckWake.entry.id) === null);
    assert.doesNotMatch(observedPrompts[2], /process_start|runtime_restart|recoveryRequired/);
    assert.doesNotMatch(observedPrompts[2], new RegExp(`${source.id} → worker: executing`));
    assert.equal(harness.messageStore.getByThreadBefore.mock.calls.length, 0);
    assert.equal(registry.list({ ownerId: 'user-1', threadId: 'thread-1', callerCatId: 'caller' }).length, 1);
  });
});

describe('F117 soak: a waiting entry does not stop its thread’s queue', () => {
  const routedTargets = (harness) => harness.routeCalls.map((args) => [...args[4]]);
  const queuedIds = (harness) =>
    harness.queue.list('thread-1', 'user-1').flatMap((entry) => (entry.status === 'queued' ? [entry.id] : []));

  it('starts a source for an idle member while the head waits for a busy one', async () => {
    const harness = createHarness();
    bindActiveRun(harness, { catId: 'opus', invocationId: 'turn-busy-opus' });
    const waiting = await admitMessage(harness, { targetCats: ['opus'] });
    await admitMessage(harness, { targetCats: ['codex'] });

    await harness.processor.requestDrain('thread-1');
    await waitFor(() => harness.routeCalls.length === 1);

    assert.deepEqual(routedTargets(harness), [['codex']]);
    assert.deepEqual(queuedIds(harness), [waiting.entry.id]);
  });

  it('keeps a later source for the busy member behind the earlier one', async () => {
    const harness = createHarness();
    bindActiveRun(harness, { catId: 'opus', invocationId: 'turn-busy-opus' });
    const first = await admitMessage(harness, { targetCats: ['opus'] });
    const second = await admitMessage(harness, { targetCats: ['opus'] });
    await admitMessage(harness, { targetCats: ['codex'] });

    await harness.processor.requestDrain('thread-1');
    await waitFor(() => harness.routeCalls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.deepEqual(routedTargets(harness), [['codex']]);
    assert.deepEqual(queuedIds(harness), [first.entry.id, second.entry.id]);
  });

  it('holds back a later source for the idle member of a source that waits on its busy member', async () => {
    const harness = createHarness();
    bindActiveRun(harness, { catId: 'opus', invocationId: 'turn-busy-opus' });
    const pair = await admitMessage(harness, { targetCats: ['opus', 'codex'] });
    const codexOnly = await admitMessage(harness, { targetCats: ['codex'] });
    await admitMessage(harness, { targetCats: ['gemini'] });

    await harness.processor.requestDrain('thread-1');
    await waitFor(() => harness.routeCalls.length === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));

    assert.deepEqual(routedTargets(harness), [['gemini']], 'codex keeps its order behind the waiting pair');
    assert.deepEqual(queuedIds(harness), [pair.entry.id, codexOnly.entry.id]);
  });

  it('keeps draining past an attempt that failed before handoff, and retries it after its wait', async () => {
    const attempts = [];
    const harness = createHarness({
      processorOptions: { retryDeferral: { baseDelayMs: 150 } },
      routeExecution: async function* (...args) {
        const [, content, , , targetCats] = args;
        attempts.push({ content, at: Date.now() });
        if (content === 'fails before handoff' && attempts.length === 1) {
          throw new Error('injected before lifecycle receiver');
        }
        await startLifecycle(args, `turn-${attempts.length}`);
        yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: Date.now() };
      },
    });
    const failing = await admitMessage(harness, { content: 'fails before handoff', targetCats: ['opus'] });
    await admitMessage(harness, { content: 'behind it', targetCats: ['codex'] });

    await harness.processor.requestDrain('thread-1');
    await waitFor(() => attempts.length === 2);

    assert.deepEqual(
      attempts.map((attempt) => attempt.content),
      ['fails before handoff', 'behind it'],
      'the thread drains past the failed entry without a new message',
    );
    assert.deepEqual(queuedIds(harness), [failing.entry.id], 'the failed entry waits in its place');

    await waitFor(() => attempts.length === 3);
    assert.equal(attempts[2].content, 'fails before handoff');
    assert.ok(attempts[2].at - attempts[0].at >= 140, 'retried only after its wait');
    await waitFor(() => queuedIds(harness).length === 0);
  });

  const deferralLogs = (harness) =>
    harness.log.warn.mock.calls
      .filter((call) => String(call.arguments[1]).includes('waits for its retry time'))
      .map((call) => call.arguments[0]);

  // Actual backend failure before a response receiver exists; no availability lookup.
  const routeFailingBeforeAcceptance = (attempts, refusedCatIds) =>
    async function* (...args) {
      const [userId, content, threadId, , targetCats, , options] = args;
      attempts.push({ at: Date.now(), content, targetCats: [...targetCats] });
      const refused = attempts.length === 1 ? targetCats.filter((catId) => refusedCatIds.includes(catId)) : [];
      for (const catId of refused) {
        yield {
          type: 'error',
          catId,
          errorCode: 'backend_start_failed',
          error: 'backend failed before accepting the source',
          timestamp: Date.now(),
        };
      }
      const started = targetCats.filter((catId) => !refused.includes(catId));
      for (const [index, catId] of started.entries()) {
        await options.onLifecycleInvocationStarted({
          threadId,
          userId,
          catId,
          invocationId: `turn-${attempts.length}-${catId}`,
          parentInvocationId: options.parentInvocationId,
          startedAt: Date.now(),
        });
        yield { type: 'done', catId, isFinal: index === started.length - 1, timestamp: Date.now() };
      }
    };

  it('retries an actual backend failure before input acceptance', async () => {
    const attempts = [];
    let automaticRetryAt;
    const harness = createHarness({
      processorOptions: { retryDeferral: { baseDelayMs: 20 } },
      routeExecution: routeFailingBeforeAcceptance(attempts, ['opus']),
    });
    automaticRetryAt = Date.now() + 400;
    const refused = await admitMessage(harness, { targetCats: ['opus'] });

    await harness.processor.requestDrain('thread-1');
    await waitFor(() => deferralLogs(harness).length === 1);
    const [deferral] = deferralLogs(harness);
    assert.equal(deferral.entryId, refused.entry.id);

    assert.ok(deferral.retryAt < automaticRetryAt, 'availability cannot impose an extra wait');

    await waitFor(() => attempts.length === 2);

    await waitFor(() => queuedIds(harness).length === 0);
  });

  it('a cross-thread callback uses normal admission and recovers an actual failed backend handoff', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const attempts = [];
    const retryAt = Date.now() + 200;
    const harness = createHarness({
      autoDrain: true,
      processorOptions: { retryDeferral: { baseDelayMs: 20 } },
      routeExecution: routeFailingBeforeAcceptance(attempts, ['opus']),
    });
    const trigger = harness.messageStore.append({
      from: { kind: 'agent', catId: 'opus' },
      userId: 'user-1',
      threadId: 'thread-1',
      content: 'Cross-thread delivery must survive temporary refusal',
      mentions: ['opus'],
      origin: 'callback',
      timestamp: Date.now(),
      extra: { crossPost: { sourceThreadId: 'other-thread', effectClass: 'coordinate' }, targetCats: ['opus'] },
    });
    const receipt = await enqueueA2ATargets(
      {
        invocationQueue: harness.queue,
        messageStore: harness.messageStore,
        queueProcessor: harness.processor,
        socketManager: harness.socketManager,
        log: harness.log,
        routingDispatchPreflight: {
          async preflight(input) {
            return {
              v: 1,
              ownerId: input.ownerId,
              observedAt: Date.now(),
              resolverState: 'fresh',
              targets: [
                {
                  targetCatId: 'opus',
                  disposition: 'rejected',
                  automaticRetryAt: retryAt,
                  reasons: [
                    { code: 'provider_timeout', summary: 'temporarily unavailable', sourceRefs: ['turn:other'] },
                  ],
                  alternatives: [],
                },
              ],
            };
          },
        },
      },
      {
        targetCats: ['opus'],
        content: trigger.content,
        threadId: 'thread-1',
        userId: 'user-1',
        ownerAuthProvenance: 'unknown',
        callerCatId: 'opus',
        triggerMessage: trigger,
      },
    );
    assert.deepEqual(receipt.enqueued, ['opus'], 'the exact source must get durable Queue custody');
    await waitFor(() => deferralLogs(harness).length === 1);
    assert.equal(attempts.length, 1);
    assert.deepEqual(attempts[0].targetCats, ['opus']);
    assert.equal(
      (await harness.messageStore.getById(trigger.id)).lifecycle?.dispatchRefs?.length ?? 0,
      0,
      'a refused attempt must not forge a dispatch/read receipt',
    );
    assert.equal(queuedIds(harness).length, 1, 'refused source stays queued');
    await waitFor(() => attempts.length === 2);

    assert.deepEqual(attempts[1].targetCats, ['opus'], 'recovery preserves target, without another message or reroute');
    await waitFor(() => queuedIds(harness).length === 0);
    assert.equal((await harness.messageStore.getById(trigger.id)).lifecycle.dispatchRefs.length, 1);
  });

  it('uses backend backoff for a failed targetless source handoff', async () => {
    const attempts = [];
    let automaticRetryAt;
    const harness = createHarness({
      processorOptions: { retryDeferral: { baseDelayMs: 20 } },
      routeExecution: routeFailingBeforeAcceptance(attempts, ['opus']),
    });
    automaticRetryAt = Date.now() + 400;
    const targetless = await admitMessage(harness, { targetCats: [] });

    await harness.processor.requestDrain('thread-1');
    await waitFor(() => deferralLogs(harness).length === 1);
    assert.deepEqual(attempts[0].targetCats, ['opus'], 'admission resolved the targetless source to opus');
    assert.deepEqual(
      harness.queue.getEntrySnapshotAcrossUsers('thread-1', targetless.entry.id)?.targets,
      [],
      'the row went back to the Queue without the member it resolved to',
    );
    const [deferral] = deferralLogs(harness);
    assert.equal(deferral.entryId, targetless.entry.id);
    assert.equal(deferral.refusedTargets, undefined);

    assert.ok(deferral.retryAt < automaticRetryAt, 'availability cannot impose an extra wait');

    await waitFor(() => attempts.length === 2);

    await waitFor(() => queuedIds(harness).length === 0);
  });

  it('retries only the sibling whose backend handoff actually failed', async () => {
    const attempts = [];
    let automaticRetryAt;
    const harness = createHarness({
      processorOptions: { retryDeferral: { baseDelayMs: 20 } },
      routeExecution: routeFailingBeforeAcceptance(attempts, ['codex']),
    });
    automaticRetryAt = Date.now() + 400;
    const pair = await admitMessage(harness, { targetCats: ['opus', 'codex'] });

    await harness.processor.requestDrain('thread-1');
    await waitFor(() => deferralLogs(harness).length === 1);
    assert.deepEqual(attempts[0].targetCats, ['opus', 'codex']);
    assert.deepEqual(
      harness.queue.getEntrySnapshotAcrossUsers('thread-1', pair.entry.id)?.targets,
      ['codex'],
      'only the refused member is left in the Queue',
    );
    assert.ok(deferralLogs(harness)[0].retryAt < automaticRetryAt);

    await waitFor(() => attempts.length === 2);
    assert.deepEqual(attempts[1].targetCats, ['codex']);

    await waitFor(() => queuedIds(harness).length === 0);
  });

  it('scans again when the owner reorders the Queue while the drain resolves the source it selected', async () => {
    const harness = createHarness();
    await admitMessage(harness, { content: 'earlier', targetCats: ['codex'] });
    const later = await admitMessage(harness, { content: 'later', targetCats: ['codex'] });
    let releaseResolution;
    const resolutionGate = new Promise((resolve) => {
      releaseResolution = resolve;
    });
    let markResolutionStarted;
    const resolutionStarted = new Promise((resolve) => {
      markResolutionStarted = resolve;
    });
    let paused = false;
    harness.router.resolveConversationTargetsAtAdmission = async (targetCats) => {
      if (!paused) {
        paused = true;
        markResolutionStarted();
        await resolutionGate;
      }
      return [...targetCats];
    };

    const drained = harness.processor.requestDrain('thread-1');
    await resolutionStarted;
    assert.equal(
      await harness.queue.setPositionDurable('thread-1', 'user-1', later.entry.id, 0),
      true,
      'the owner moves the later source ahead while the scan awaits',
    );
    releaseResolution();
    await drained;
    await waitFor(() => harness.routeCalls.length === 2);

    assert.deepEqual(
      harness.routeCalls.map((args) => args[1]),
      ['later', 'earlier'],
      'codex receives its sources in the order the owner set',
    );
  });
});

describe('deployment continuation at the canonical Queue boundary', () => {
  const carrier = {
    v: 1,
    waitId: 'task-deployment',
    outcomeId: 'wait:deployment:abc123def456:runtime:g1:matched',
    ownerFence: { kind: 'containing_task', generation: 1 },
  };
  const waiting = {
    from: { kind: 'external', connectorId: 'deployment-wait' },
    waitContinuationCarrier: carrier,
    messageSource: {
      connector: 'deployment-wait',
      label: 'Deployment Wait',
      meta: { waitContinuationCarrier: carrier },
    },
  };
  it('unknown runtime readiness preserves the pending source without creating an invocation', async () => {
    const h = createHarness();
    const admitted = await admitMessage(h, waiting);
    await h.processor.processNext('thread-1', 'user-1');
    await waitFor(() => !h.invocationTracker.has('thread-1', 'opus'));
    assert.equal(h.router.routeExecution.mock.calls.length, 0);
    assert.equal(h.invocationRecordStore.create.mock.calls.length, 0);
    assert.deepEqual(h.queue.list('thread-1', 'user-1')[0]?.targets, ['opus']);
    assert.notEqual(h.messageStore.getById(admitted.message.id).deliveryStatus, 'canceled');
  });
  for (const late of [false, true]) {
    it(`rejects authority that becomes stale ${late ? 'after invocation reservation' : 'before invocation reservation'}`, async () => {
      let checks = 0;
      const h = createHarness({
        deploymentWaitStartGuard: {
          check: async () => (++checks === 1 && late ? { ok: true } : { ok: false, reason: 'authority_stale' }),
        },
      });
      const admitted = await admitMessage(h, waiting);
      await h.processor.processNext('thread-1', 'user-1');
      await waitFor(
        () =>
          h.messageStore.getById(admitted.message.id).deliveryStatus === 'canceled' &&
          h.queue.list('thread-1', 'user-1').length === 0,
      );
      assert.equal(h.router.routeExecution.mock.calls.length, 0);
      assert.equal(
        h.invocationRecordStore.create.mock.calls.length,
        late ? 1 : 0,
        JSON.stringify({
          checks,
          calls: h.invocationRecordStore.create.mock.calls,
          errors: errorLog(h),
          records: [...h.invocationRecordStore.records.values()],
        }),
      );
      assert.equal(h.queue.list('thread-1', 'user-1').length, 0);
    });
  }
  it('late readiness uncertainty preserves the source and does not enter the provider', async () => {
    let checks = 0;
    const h = createHarness({
      deploymentWaitStartGuard: {
        check: async () => (++checks === 1 ? { ok: true } : { ok: false, reason: 'evidence_stale' }),
      },
    });
    const admitted = await admitMessage(h, waiting);
    await h.processor.processNext('thread-1', 'user-1');
    await waitFor(() => checks >= 2 && !h.invocationTracker.has('thread-1', 'opus'));
    assert.equal(h.router.routeExecution.mock.calls.length, 0);
    assert.notEqual(h.messageStore.getById(admitted.message.id).deliveryStatus, 'canceled');
    assert.deepEqual(
      h.queue.list('thread-1', 'user-1')[0]?.targets,
      ['opus'],
      JSON.stringify({
        checks,
        errors: errorLog(h),
        records: [...h.invocationRecordStore.records.values()],
        message: h.messageStore.getById(admitted.message.id),
      }),
    );
  });
  it('ordinary input preserves its declared producer on replay without borrowing a wait guard', async () => {
    for (const from of [
      { kind: 'user', userId: 'user-1' },
      { kind: 'external', connectorId: 'github' },
      { kind: 'agent', catId: 'codex' },
    ]) {
      const h = createHarness();
      await admitMessage(h, { from });
      await h.processor.processNext('thread-1', 'user-1');
      await waitFor(() => h.router.routeExecution.mock.calls.length === 1);
      const options = h.router.routeExecution.mock.calls[0].arguments[6];
      assert.equal(options.humanDispositionInvocationOrigin, 'queue_replay');
      assert.equal(options.routingQueueSource, { user: 'user', external: 'connector', agent: 'agent' }[from.kind]);
    }
  });
});
