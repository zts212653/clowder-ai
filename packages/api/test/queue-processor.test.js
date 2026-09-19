import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { CallerDispatchObservationRegistry } = await import(
  '../dist/domains/cats/services/agents/invocation/CallerDispatchObservationRegistry.js'
);
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { MessageStore, settleLifecycleResponseInputs } = await import(
  '../dist/domains/cats/services/stores/ports/MessageStore.js'
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
  processorOptions,
} = {}) {
  const queue = new InvocationQueue();
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
  };
  return { ...deps, processor: new QueueProcessor(deps, processorOptions), routeCalls };
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
    content: queueInput.content,
    mentions: queueInput.targetCats,
    timestamp: Date.now(),
    deliveryStatus: 'queued',
  });
  const result = await harness.queue.appendAndEnqueueDurable(harness.messageStore, messageInput, queueInput);
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
    assert.equal(response.lifecycle.status, 'interrupted');
    assert.equal(response.lifecycle.reason, 'queue_target_retirement_pending');
    assert.equal(await harness.queue.getDurableEntry('thread-1', admitted.entry.id), null);
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
