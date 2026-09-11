import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { canonicalTestMessageInput, canonicalTestQueueInput } from './helpers/message-from-fixtures.js';

const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

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

function createHarness({ routeExecution, tracker = new InvocationTracker() } = {}) {
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
    log: { info: mock.fn(), warn: mock.fn(), error: mock.fn() },
  };
  return { ...deps, processor: new QueueProcessor(deps), routeCalls };
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

  it('keeps a FIFO prefix as separate prompt messages instead of concatenating bodies', async () => {
    const calls = [];
    const harness = createHarness({
      routeExecution: async function* (...args) {
        calls.push(args);
        yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
      },
    });
    const first = await admitMessage(harness, { content: 'first author body' });
    const second = await admitMessage(harness, { content: 'second author body' });

    assert.equal((await harness.processor.processNext('thread-1', 'user-1')).started, true);
    await waitFor(() => harness.queue.list('thread-1', 'user-1').length === 0);

    assert.equal(calls.length, 1, JSON.stringify(errorLog(harness)));
    const [userId, content, threadId, messageId, targetCats, , options] = calls[0];
    assert.equal(userId, 'user-1');
    assert.equal(threadId, 'thread-1');
    assert.equal(content, 'first author body');
    assert.equal(messageId, first.message.id);
    assert.deepEqual(targetCats, ['opus']);
    assert.deepEqual(
      options.persistedPromptMessages.map((message) => ({ messageId: message.messageId, content: message.content })),
      [
        { messageId: first.message.id, content: 'first author body' },
        { messageId: second.message.id, content: 'second author body' },
      ],
    );
    assert.equal(content.includes('second author body'), false);
  });

  it('keeps provider failure out of Queue after admission', async () => {
    const harness = createHarness({
      routeExecution: async function* () {
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
      routeExecution: async function* () {
        routeInvocations++;
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
      routeExecution: async function* () {
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
      routeExecution: async function* () {
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
});
