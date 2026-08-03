// @ts-check

import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRecordStore } from '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js';
import { ConnectorInvokeTrigger } from '../dist/infrastructure/email/ConnectorInvokeTrigger.js';

// ─── Mocks ───────────────────────────────────────────────────────

function noopLog() {
  const noop = () => {};
  return /** @type {any} */ ({
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
    trace: noop,
    fatal: noop,
    child: () => noopLog(),
  });
}

/**
 * Mock AgentRouter that yields a single done message.
 * @param {object} [opts]
 * @param {Error} [opts.throwError] - If set, routeExecution throws this error
 * @param {boolean} [opts.persistenceFail] - If set, simulates persistence failure
 * @param {any[]} [opts.messages] - Optional exact routeExecution messages to yield
 */
function mockRouter(opts = {}) {
  const calls =
    /** @type {Array<{userId: string, message: string, threadId: string, userMessageId: string, targetCats: string[], intent: object, options?: object}>} */ ([]);
  const ackCalls = /** @type {Array<{userId: string, threadId: string}>} */ ([]);

  return {
    calls,
    ackCalls,
    /** @type {any} */
    router: {
      async *routeExecution(userId, message, threadId, userMessageId, targetCats, intent, options) {
        calls.push({ userId, message, threadId, userMessageId, targetCats, intent, options });

        if (opts.throwError) throw opts.throwError;

        if (opts.messages) {
          for (const msg of opts.messages) {
            yield msg;
          }
          return;
        }

        if (opts.persistenceFail && options?.persistenceContext) {
          options.persistenceContext.failed = true;
          options.persistenceContext.errors.push({ catId: targetCats[0], error: 'disk full' });
        }

        yield {
          type: 'text',
          catId: targetCats[0],
          content: 'Review noted. Working on it.',
          timestamp: Date.now(),
        };
        yield {
          type: 'done',
          catId: targetCats[0],
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 100, outputTokens: 50 } },
        };
      },
      async ackCollectedCursors(userId, threadId, _boundaries) {
        ackCalls.push({ userId, threadId });
      },
    },
  };
}

/**
 * Most unit routers below model provider-visible output only. Production emits
 * a durable child `invocation_created` event immediately before that output.
 * Keep that lifecycle boundary explicit in the shared harness; tests for
 * pre-invocation router events opt out and yield the full sequence themselves.
 * @param {any} router
 */
function withDurableChildStart(router) {
  return {
    ...router,
    async *routeExecution(...args) {
      const targetCats = args[4];
      const options = args[6];
      let childStartEmitted = false;
      for await (const message of router.routeExecution(...args)) {
        if (!childStartEmitted) {
          childStartEmitted = true;
          const startedAt = Date.now();
          yield {
            type: 'system_info',
            catId: targetCats[0],
            content: JSON.stringify({
              type: 'invocation_created',
              invocationId: `${options.parentInvocationId}-child`,
              parentInvocationId: options.parentInvocationId,
              executionKind: 'foreground',
              startedAt,
            }),
            timestamp: startedAt,
          };
        }
        yield message;
      }
    },
  };
}

function mockSocketManager() {
  const broadcasts = /** @type {Array<{msg: any, threadId: string}>} */ ([]);
  const roomBroadcasts = /** @type {Array<{room: string, event: string, data: any}>} */ ([]);
  const userEmits = /** @type {Array<{userId: string, event: string, data: any}>} */ ([]);
  return {
    broadcasts,
    roomBroadcasts,
    userEmits,
    /** @type {any} */
    manager: {
      broadcastAgentMessage(msg, threadId) {
        broadcasts.push({ msg, threadId });
      },
      broadcastToRoom(room, event, data) {
        roomBroadcasts.push({ room, event, data });
      },
      emitToUser(userId, event, data) {
        userEmits.push({ userId, event, data });
      },
    },
  };
}

function mockInvocationRecordStore() {
  const creates = /** @type {any[]} */ ([]);
  const updates = /** @type {Array<{id: string, data: any}>} */ ([]);
  let createCounter = 0;
  /** @type {(() => void) | null} */
  let beforeCreate = null;
  /** @type {(() => void) | null} */
  let beforeUpdate = null;
  let duplicateOnCreate = false;
  const records = new Map();

  return {
    creates,
    updates,
    /** @type {any} */
    store: {
      async create(input) {
        beforeCreate?.();
        creates.push(input);
        if (duplicateOnCreate) {
          return { outcome: 'duplicate', invocationId: 'inv-existing' };
        }
        createCounter++;
        const invocationId = `inv-${createCounter}`;
        records.set(invocationId, {
          id: invocationId,
          ...input,
          userMessageId: null,
          status: 'queued',
        });
        return { outcome: 'created', invocationId };
      },
      async update(id, data) {
        beforeUpdate?.();
        updates.push({ id, data });
        const record = records.get(id);
        if (!record) return null;
        if (data.expectedStatus !== undefined && record.status !== data.expectedStatus) return null;
        const { expectedStatus: _expectedStatus, ...patch } = data;
        Object.assign(record, patch);
        return record;
      },
      async get(id) {
        return records.get(id) ?? null;
      },
      async getByIdempotencyKey(_threadId, _userId, _key) {
        return records.get('inv-existing') ?? null;
      },
    },
    /** Force next create to return a duplicate record in the requested lifecycle state. */
    setDuplicate(statusOrOverrides = 'succeeded') {
      duplicateOnCreate = true;
      const overrides = typeof statusOrOverrides === 'string' ? { status: statusOrOverrides } : statusOrOverrides;
      records.set('inv-existing', {
        id: 'inv-existing',
        threadId: 'thread-1',
        userId: 'user-1',
        userMessageId: 'msg-1',
        targetCats: ['opus'],
        intent: 'execute',
        idempotencyKey: 'connector-msg-1',
        actionLeaseCarrier: { kind: 'none' },
        status: overrides.status ?? 'succeeded',
        ...(overrides.status === 'running' ? { executionStartedAt: Date.now() - 500 } : {}),
        createdAt: Date.now() - 1_000,
        updatedAt: Date.now() - 1_000,
        ...overrides,
      });
    },
    setMissingDuplicate() {
      duplicateOnCreate = true;
      records.delete('inv-existing');
    },
    setBeforeCreate(cb) {
      beforeCreate = cb;
    },
    setBeforeUpdate(cb) {
      beforeUpdate = cb;
    },
    setRecordStatus(id, status) {
      const record = records.get(id);
      if (record) record.status = status;
    },
  };
}

function sharedQueuedRaceRecordStore() {
  let record = {
    id: 'inv-existing',
    threadId: 'thread-1',
    userId: 'user-1',
    userMessageId: 'msg-1',
    targetCats: ['opus'],
    intent: 'execute',
    status: 'queued',
    idempotencyKey: 'connector-msg-1',
    actionLeaseCarrier: { kind: 'none' },
    createdAt: Date.now() - 1_000,
    updatedAt: Date.now() - 1_000,
  };
  let queuedReads = 0;
  /** @type {() => void} */
  let releaseQueuedReads;
  const bothReadQueued = new Promise((resolve) => {
    releaseQueuedReads = resolve;
  });

  return {
    /** @type {any} */
    store: {
      async create() {
        return { outcome: 'duplicate', invocationId: record.id };
      },
      async get(id) {
        if (id !== record.id) return null;
        const snapshot = { ...record };
        if (snapshot.status === 'queued') {
          queuedReads++;
          if (queuedReads === 2) releaseQueuedReads();
          await bothReadQueued;
        }
        return snapshot;
      },
      async update(id, data) {
        if (id !== record.id) return null;
        if (data.expectedStatus !== undefined && record.status !== data.expectedStatus) return null;
        const { expectedStatus: _expectedStatus, ...patch } = data;
        record = { ...record, ...patch, updatedAt: Date.now() };
        return { ...record };
      },
      async getByIdempotencyKey() {
        return { ...record };
      },
    },
    getRecord() {
      return { ...record };
    },
  };
}

function mockInvocationTracker() {
  const starts = /** @type {Array<{threadId: string, catId: string}>} */ ([]);
  const tryStartThreadCalls = /** @type {Array<{threadId: string, catId: string}>} */ ([]);
  const completes = /** @type {Array<{threadId: string, catId: string}>} */ ([]);
  const slotCompletes = /** @type {Array<{threadId: string, catId: string, controller: AbortController}>} */ ([]);
  const cancelCalls = /** @type {Array<{threadId: string, catId: string, userId: (string|undefined)}>} */ ([]);
  let aborted = false;
  let cancelDenied = false;
  /** @type {Map<string, string>} key = "threadId:catId" or "threadId" for legacy */
  const activeSlots = new Map();

  return {
    starts,
    tryStartThreadCalls,
    completes,
    slotCompletes,
    cancelCalls,
    setAborted(val) {
      aborted = val;
    },
    setCancelDenied(val) {
      cancelDenied = val;
    },
    /** Mark a slot as having an active invocation (for queue tests) */
    setActive(threadId, userId = 'user-1') {
      activeSlots.set(threadId, userId);
    },
    clearActive(threadId) {
      activeSlots.delete(threadId);
    },
    /** @type {any} */
    tracker: {
      start(threadId, catId, _userId, _targetCats) {
        starts.push({ threadId, catId });
        const controller = { signal: { aborted } };
        return controller;
      },
      tryStartThread(threadId, catId, _userId, _catIds) {
        tryStartThreadCalls.push({ threadId, catId });
        if (activeSlots.has(threadId)) return null;
        return { signal: { aborted } };
      },
      complete(threadId, catId, _controller) {
        completes.push({ threadId, catId });
      },
      completeSlot(threadId, catId, controller) {
        slotCompletes.push({ threadId, catId, controller });
      },
      trackExternalSlot() {
        return true;
      },
      has(threadId, _catId) {
        return activeSlots.has(threadId);
      },
      getUserId(threadId, _catId) {
        return activeSlots.get(threadId);
      },
      cancel(threadId, catId, userId) {
        cancelCalls.push({ threadId, catId, userId });
        if (cancelDenied) return { cancelled: false, catIds: [] };
        const owner = activeSlots.get(threadId);
        if (!owner) return { cancelled: false, catIds: [] };
        if (userId && owner !== userId) return { cancelled: false, catIds: [] };
        activeSlots.delete(threadId);
        return { cancelled: true, catIds: ['opus'] };
      },
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('ConnectorInvokeTrigger', () => {
  /** @type {ReturnType<typeof mockRouter>} */
  let routerMock;
  /** @type {ReturnType<typeof mockSocketManager>} */
  let socketMock;
  /** @type {ReturnType<typeof mockInvocationRecordStore>} */
  let recordMock;
  /** @type {ReturnType<typeof mockInvocationTracker>} */
  let trackerMock;

  /** @type {InvocationQueue} */
  let queue;

  beforeEach(() => {
    routerMock = mockRouter();
    socketMock = mockSocketManager();
    recordMock = mockInvocationRecordStore();
    trackerMock = mockInvocationTracker();
    queue = new InvocationQueue();
  });

  function createTrigger(overrides = {}) {
    const {
      router: overrideRouter = routerMock.router,
      routerIncludesInvocationLifecycle = false,
      ...triggerOverrides
    } = overrides;
    return new ConnectorInvokeTrigger({
      router: routerIncludesInvocationLifecycle ? overrideRouter : withDurableChildStart(overrideRouter),
      socketManager: socketMock.manager,
      invocationRecordStore: recordMock.store,
      invocationTracker: trackerMock.tracker,
      invocationQueue: queue,
      log: noopLog(),
      ...triggerOverrides,
    });
  }

  /** Wait for background execution to complete */
  async function waitForTrigger() {
    // trigger() is fire-and-forget; give microtasks time to settle
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  it('creates InvocationRecord and calls routeExecution', async () => {
    const trigger = createTrigger();
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Review msg', 'msg-1');
    await waitForTrigger();

    // InvocationRecord created
    assert.strictEqual(recordMock.creates.length, 1);
    assert.strictEqual(recordMock.creates[0].threadId, 'thread-1');
    assert.deepStrictEqual(recordMock.creates[0].targetCats, ['opus']);
    assert.strictEqual(recordMock.creates[0].idempotencyKey, 'connector-msg-1');

    // routeExecution called
    assert.strictEqual(routerMock.calls.length, 1);
    assert.strictEqual(routerMock.calls[0].userId, 'user-1');
    assert.strictEqual(routerMock.calls[0].message, 'Review msg');
    assert.strictEqual(routerMock.calls[0].threadId, 'thread-1');
    assert.strictEqual(routerMock.calls[0].userMessageId, 'msg-1');
    assert.deepStrictEqual(routerMock.calls[0].targetCats, ['opus']);
  });

  it('passes a trusted GitHub delivery-decision carrier through the direct execution path', async () => {
    const headSha = 'a'.repeat(40);
    const storedMessage = {
      id: 'msg-billing',
      threadId: 'thread-billing',
      userId: 'user-1',
      catId: null,
      content: 'GitHub CI failed before any source step ran.',
      source: { connector: 'github-ci', label: 'GitHub CI/CD' },
      mentions: ['opus'],
      timestamp: 1_785_600_000_000,
      extra: {
        memoryCue: {
          deliveryDecision: {
            v: 1,
            producer: 'github_ci',
            producerProvenance: 'server_github_ci',
            repoFullName: 'zts212653/cat-cafe',
            prNumber: 3276,
            headSha,
            phase: 'merge_gate',
            gateOutcome: 'source_evidence_complete',
            externalCondition: 'billing_spending_limit_zero_step',
            candidateAction: 'merge',
            occurredAt: 1_785_600_000_000,
          },
        },
      },
    };
    const trigger = createTrigger({
      messageStore: {
        getById: async (id) => (id === storedMessage.id ? storedMessage : undefined),
      },
    });

    await trigger.trigger(
      storedMessage.threadId,
      /** @type {any} */ ('opus'),
      storedMessage.userId,
      storedMessage.content,
      storedMessage.id,
      undefined,
      { sourceCategory: 'ci' },
    );
    await waitForTrigger();

    assert.deepStrictEqual(routerMock.calls[0].options.memoryCueOpportunitySeeds, [
      {
        kind: 'delivery_decision',
        producer: 'github_ci',
        occurredAt: 1_785_600_000_000,
        payload: {
          repoFullName: 'zts212653/cat-cafe',
          prNumber: 3276,
          headSha,
          phase: 'merge_gate',
          gateOutcome: 'source_evidence_complete',
          externalCondition: 'billing_spending_limit_zero_step',
          candidateAction: 'merge',
          sourceMessageId: storedMessage.id,
        },
      },
    ]);
  });

  it('passes an authoritative A2A slot claim and durable deferral into connector execution', async () => {
    trackerMock.tracker.trackExternalSlot = () => false;
    trackerMock.tracker.completeSlot = () => {};
    const trigger = createTrigger();

    trigger.trigger('thread-a2a-admission', /** @type {any} */ ('opus'), 'user-1', 'Review msg', 'msg-review');
    await waitForTrigger();

    const options = /** @type {any} */ (routerMock.calls[0].options);
    assert.ok(options.invocationController, 'connector route must expose its tracker controller to A2A admission');
    assert.equal(typeof options.trackA2ASlot, 'function');
    assert.equal(typeof options.completeA2ASlots, 'function');
    assert.equal(
      options.trackA2ASlot('thread-a2a-admission', 'codex', 'user-1', options.invocationController),
      false,
      'another live owner must reject inline A2A execution',
    );

    const enqueue = options.deferA2AEnqueue({
      threadId: 'thread-a2a-admission',
      userId: 'user-1',
      content: '@codex review complete',
      source: 'agent',
      ownerAuthProvenance: 'unknown',
      sourceCategory: 'a2a',
      targetCats: ['codex'],
      callerCatId: 'opus',
      messageId: 'msg-review',
      a2aTriggerMessageId: 'msg-review',
      autoExecute: true,
      priority: 'normal',
      intent: 'execute',
    });
    assert.equal(enqueue.outcome, 'enqueued');
    assert.equal(queue.list('thread-a2a-admission', 'user-1')[0].messageId, 'msg-review');
  });

  it('releases a terminal dynamic A2A child with the connector route controller', async () => {
    let routeController;
    const dynamicRouter = {
      async *routeExecution(_userId, _message, threadId, _messageId, _targetCats, _intent, options) {
        routeController = options.invocationController;
        assert.equal(options.trackA2ASlot(threadId, 'codex', 'user-1', routeController), true);
        yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
      },
      async ackCollectedCursors() {},
    };
    const trigger = createTrigger({ router: dynamicRouter });

    trigger.trigger('thread-connector-child', /** @type {any} */ ('opus'), 'user-1', 'Review msg', 'msg-child');
    await waitForTrigger();

    const dynamicCompletions = trackerMock.slotCompletes.filter((call) => call.catId === 'codex');
    assert.equal(dynamicCompletions.length, 1);
    assert.equal(dynamicCompletions[0].threadId, 'thread-connector-child');
    assert.equal(dynamicCompletions[0].controller, routeController);
  });

  it('projects a direct managed-command wake from its persisted hold carrier', async () => {
    const trigger = createTrigger({
      messageStore: {
        getById: async (messageId) =>
          messageId === 'msg-hold-complete' ? { source: { connector: 'hold-ball' } } : null,
      },
    });

    await trigger.trigger(
      'thread-1',
      /** @type {any} */ ('opus'),
      'user-1',
      'Managed command completed.',
      'msg-hold-complete',
      undefined,
      { sourceCategory: 'scheduled' },
    );
    await waitForTrigger();

    assert.deepStrictEqual(routerMock.calls[0].options?.turnCustodyWake, {
      kind: 'structured',
      protocol: 'hold',
      subjectKey: 'ball:thread:thread-1',
      holderCatId: 'opus',
    });
  });

  it('projects a direct A2A wake from the exact trigger handoff', async () => {
    const trigger = createTrigger({
      messageStore: {
        getById: async (messageId) => (messageId === 'msg-a2a' ? { catId: 'codex-sol' } : null),
      },
    });

    await trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'A2A handoff.', 'msg-a2a', undefined, {
      sourceCategory: 'a2a',
    });
    await waitForTrigger();

    const expected = {
      kind: 'structured',
      protocol: 'dispatch',
      subjectKey: 'ball:thread:thread-1',
      holderCatId: 'opus',
      handoff: {
        sourceEventId: 'route:msg-a2a:opus',
        messageId: 'msg-a2a',
        fromCatId: 'codex-sol',
      },
    };
    assert.deepStrictEqual(routerMock.calls[0].options?.turnCustodyWake, expected);
    assert.deepStrictEqual(routerMock.calls[0].options?.turnCustodyWakeForCat('opus'), expected);
  });

  it('binds exact incremental prompt exposure through QueueProcessor', async () => {
    const seenCalls = [];
    const exposingRouter = /** @type {any} */ ({
      async *routeExecution(userId, _message, threadId, _userMessageId, targetCats, _intent, options) {
        await options.onPromptMessagesExposed({
          threadId,
          userId,
          catId: targetCats[0],
          invocationId: options.parentInvocationId,
          messageIds: ['queued-work-period-message'],
        });
        yield { type: 'done', catId: targetCats[0], content: '', timestamp: Date.now() };
      },
      async ackCollectedCursors() {},
    });
    const trigger = createTrigger({
      router: exposingRouter,
      queueProcessor: {
        isThreadBusy: () => false,
        async markPromptMessagesSeen(input) {
          seenCalls.push(input);
        },
        async onInvocationComplete() {},
      },
    });

    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Review msg', 'msg-1');
    await waitForTrigger();

    assert.deepStrictEqual(seenCalls, [
      {
        threadId: 'thread-1',
        userId: 'user-1',
        catId: 'opus',
        invocationId: 'inv-1',
        messageIds: ['queued-work-period-message'],
      },
    ]);
  });

  it('F254 Phase E: does not deliver a superseded draft from the direct connector path', async () => {
    const staleRouter = /** @type {any} */ ({
      async *routeExecution(_userId, _message, _threadId, _userMessageId, _targetCats, _intent, options) {
        yield { type: 'text', catId: 'opus', content: 'stale draft', timestamp: Date.now() };
        if (options?.persistenceContext) {
          options.persistenceContext.outputCommitDecisions = {
            opus: {
              kind: 'superseded_positive_stale',
              closureId: 'closure-1',
              requiredFrontierMessageId: 'msg-newer',
            },
          };
        }
        yield { type: 'done', catId: 'opus', content: '', timestamp: Date.now() };
      },
      async ackCollectedCursors() {},
    });
    const deliverCalls = /** @type {Array<{content: string, catId: string}>} */ ([]);
    const streamEndCalls = /** @type {string[]} */ ([]);
    const trigger = createTrigger({
      router: staleRouter,
      outboundHook: {
        async deliver(_threadId, content, catId) {
          deliverCalls.push({ content, catId });
        },
      },
      streamingHook: {
        async onStreamStart() {},
        async onStreamChunk() {},
        async onStreamEnd(_threadId, content) {
          streamEndCalls.push(content);
        },
        async cleanupPlaceholders() {},
      },
    });

    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-f254-stale');
    await waitForTrigger();

    assert.deepStrictEqual(deliverCalls, [], 'known-stale draft must not leave through connector delivery');
    assert.deepStrictEqual(streamEndCalls, [''], 'streaming final must not expose known-stale content');
  });

  it('ADR-042 delivers a published-with-unseen answer through the direct connector path', async () => {
    const publishedRouter = /** @type {any} */ ({
      async *routeExecution(_userId, _message, _threadId, _userMessageId, _targetCats, _intent, options) {
        yield { type: 'text', catId: 'opus', content: 'published answer', timestamp: Date.now() };
        if (options?.persistenceContext) {
          options.persistenceContext.outputCommitDecisions = {
            opus: {
              kind: 'published_with_unseen',
              messageId: 'msg-published',
              lineageId: 'msg-published',
              offeredSupplementId: 'f254-supplement:msg-published:1',
              requiredFrontierMessageId: 'msg-newer',
            },
          };
        }
        yield { type: 'done', catId: 'opus', content: '', timestamp: Date.now() };
      },
      async ackCollectedCursors() {},
    });
    const deliverCalls = [];
    const streamEndCalls = [];
    const trigger = createTrigger({
      router: publishedRouter,
      outboundHook: {
        async deliver(_threadId, content, catId) {
          deliverCalls.push({ content, catId });
        },
      },
      streamingHook: {
        async onStreamStart() {},
        async onStreamChunk() {},
        async onStreamEnd(_threadId, content) {
          streamEndCalls.push(content);
        },
        async cleanupPlaceholders() {},
      },
    });

    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-f254-published');
    await waitForTrigger();

    assert.deepStrictEqual(deliverCalls, [{ content: 'published answer', catId: 'opus' }]);
    assert.deepStrictEqual(streamEndCalls, ['published answer']);
  });

  for (const scenario of [
    {
      name: 'catching-up',
      decision: {
        kind: 'superseded_positive_stale',
        closureId: 'closure-codex',
        requiredFrontierMessageId: 'msg-newer',
      },
    },
    {
      name: 'blocked',
      decision: {
        kind: 'blocked_known_closure',
        closureId: 'closure-codex',
        reason: 'attempt_budget_exhausted',
      },
    },
  ]) {
    it(`F254 Phase E: direct connector projects a non-primary ${scenario.name} output under its owner cat`, async () => {
      const projectionCalls = [];
      const multiCatRouter = /** @type {any} */ ({
        async *routeExecution(_userId, _message, _threadId, _userMessageId, _targetCats, _intent, options) {
          yield { type: 'text', catId: 'codex', content: 'withheld codex draft', timestamp: Date.now() };
          if (options?.persistenceContext) {
            options.persistenceContext.outputCommitDecisions = { codex: scenario.decision };
          }
          yield { type: 'done', catId: 'codex', content: '', timestamp: Date.now() };
        },
        async ackCollectedCursors() {},
      });
      const trigger = createTrigger({
        router: multiCatRouter,
        streamingHook: {
          async onStreamStart() {},
          async onStreamChunk() {},
          async onStreamEnd() {},
          async cleanupPlaceholders() {},
          async onClosureCatchingUp(_threadId, ownerCatId) {
            projectionCalls.push({ kind: 'catching_up', ownerCatId });
          },
          async onClosureBlocked(_threadId, ownerCatId) {
            projectionCalls.push({ kind: 'blocked', ownerCatId });
          },
        },
      });

      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', `msg-${scenario.name}`);
      await waitForTrigger();

      assert.deepStrictEqual(projectionCalls, [
        {
          kind: scenario.decision.kind === 'blocked_known_closure' ? 'blocked' : 'catching_up',
          ownerCatId: 'codex',
        },
      ]);
    });
  }

  it('F254 Phase E: direct connector catches enqueue a runnable closure successor', async () => {
    const successorRouter = /** @type {any} */ ({
      async *routeExecution(_userId, _message, threadId, _userMessageId, targetCats, _intent, options) {
        options?.freshnessReinvokeEnqueue?.({
          threadId,
          userId: 'user-1',
          content: '[Freshness Catch Closure closure-connector] replacement prompt',
          source: 'agent',
          ownerAuthProvenance: 'unknown',
          sourceCategory: 'freshness',
          targetCats,
          callerCatId: targetCats[0],
          autoExecute: true,
          priority: 'normal',
          intent: 'execute',
          idempotencyKey: 'freshness-closure:closure-connector',
          freshnessClosureId: 'closure-connector',
          freshnessRequiredFrontierMessageId: 'msg-newer',
          freshnessContext: {
            sourceNoticeIds: [],
            senders: ['user'],
            reason: 'stream_output_stale',
          },
        });
        yield { type: 'done', catId: targetCats[0], content: '', timestamp: Date.now() };
      },
      async ackCollectedCursors() {},
    });
    const trigger = createTrigger({ router: successorRouter });

    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-f254-connector-catch');
    await waitForTrigger();

    const queued = queue.list('thread-1', 'user-1');
    assert.strictEqual(queued.length, 1, 'positive-stale connector output must schedule its replacement');
    assert.strictEqual(queued[0].freshnessClosureId, 'closure-connector');
    assert.strictEqual(queued[0].freshnessRequiredFrontierMessageId, 'msg-newer');
    assert.strictEqual(queued[0].autoExecute, true);
    assert.strictEqual('freshnessContext' in queued[0], false, 'ephemeral context must not enter queue truth');
  });

  it('F222 P1: connector direct routeExecution passes frustrationAutoIssueEligible=false', async () => {
    const trigger = createTrigger();
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Review msg', 'msg-f222');
    await waitForTrigger();

    assert.strictEqual(routerMock.calls.length, 1);
    assert.strictEqual(
      routerMock.calls[0].options?.frustrationAutoIssueEligible,
      false,
      'connector direct execution must suppress frustration detection',
    );
    assert.strictEqual(routerMock.calls[0].options?.humanDispositionInvocationOrigin, 'connector');
  });

  it('broadcasts agent messages to WebSocket room', async () => {
    const trigger = createTrigger();
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Review msg', 'msg-1');
    await waitForTrigger();

    // Should expose the durable child lifecycle boundary before text + done.
    const agentBroadcasts = socketMock.broadcasts.filter((b) => b.threadId === 'thread-1');
    assert.ok(agentBroadcasts.length >= 3, `Expected at least 3 broadcasts, got ${agentBroadcasts.length}`);
    assert.strictEqual(agentBroadcasts[0].msg.type, 'system_info');
    assert.strictEqual(JSON.parse(agentBroadcasts[0].msg.content).type, 'invocation_created');
    assert.strictEqual(agentBroadcasts[1].msg.type, 'text');
    assert.strictEqual(agentBroadcasts[2].msg.type, 'done');

    // Should have broadcast intent_mode
    const intentBroadcast = socketMock.roomBroadcasts.find((b) => b.event === 'intent_mode');
    assert.ok(intentBroadcast, 'Should broadcast intent_mode');
    assert.strictEqual(intentBroadcast.data.mode, 'execute');
  });

  it('updates InvocationRecord through lifecycle: queued → running → succeeded', async () => {
    const trigger = createTrigger();
    await trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
    await waitForTrigger();

    // Check update sequence
    const updates = recordMock.updates;
    assert.ok(updates.length >= 2, `Expected at least 2 updates, got ${updates.length}`);

    // First update: atomically claim queued and bind the triggering message.
    assert.strictEqual(updates[0].data.userMessageId, 'msg-1');
    assert.strictEqual(updates[0].data.status, 'running');
    assert.strictEqual(updates[0].data.expectedStatus, 'queued');

    // Last update: status succeeded
    const lastUpdate = updates[updates.length - 1];
    assert.strictEqual(lastUpdate.data.status, 'succeeded');
    assert.deepStrictEqual(lastUpdate.data.successfulCatIds, ['opus']);
  });

  it('acks cursor boundaries on success', async () => {
    const trigger = createTrigger();
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
    await waitForTrigger();

    assert.strictEqual(routerMock.ackCalls.length, 1);
    assert.strictEqual(routerMock.ackCalls[0].userId, 'user-1');
    assert.strictEqual(routerMock.ackCalls[0].threadId, 'thread-1');
  });

  it('starts and completes InvocationTracker', async () => {
    const trigger = createTrigger();
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
    await waitForTrigger();

    assert.strictEqual(trackerMock.tryStartThreadCalls.length, 1);
    assert.strictEqual(trackerMock.completes.length, 1);
    assert.strictEqual(trackerMock.completes[0].threadId, 'thread-1');
  });

  it('does not rerun duplicate invocations already known to have succeeded', async () => {
    recordMock.setDuplicate();
    const trigger = createTrigger();
    const outcome = await trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
    await waitForTrigger();

    assert.strictEqual(outcome, 'dispatched');
    // Should not call routeExecution
    assert.strictEqual(routerMock.calls.length, 0);
    // Should not start tracker
    assert.strictEqual(trackerMock.starts.length, 0);
  });

  for (const status of ['queued', 'failed']) {
    it(`replays the same durable InvocationRecord when a duplicate is ${status}`, async () => {
      recordMock.setDuplicate({ status, ...(status === 'failed' ? { error: 'process_restart' } : {}) });
      const trigger = createTrigger();

      assert.equal(
        await trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1'),
        'dispatched',
      );
      await waitForTrigger();

      assert.equal(routerMock.calls.length, 1, `${status} carrier must be redriven`);
      const claim = recordMock.updates.find(
        (update) => update.id === 'inv-existing' && update.data.status === 'running',
      );
      assert.deepEqual(claim?.data, {
        userMessageId: 'msg-1',
        status: 'running',
        expectedStatus: status,
        ...(status === 'failed' ? { error: '' } : {}),
      });
    });
  }

  it('allows only one worker to recover the same queued duplicate', async () => {
    const sharedRecordMock = sharedQueuedRaceRecordStore();
    const trackerA = mockInvocationTracker();
    const trackerB = mockInvocationTracker();
    const triggerA = createTrigger({
      invocationRecordStore: sharedRecordMock.store,
      invocationTracker: trackerA.tracker,
    });
    const triggerB = createTrigger({
      invocationRecordStore: sharedRecordMock.store,
      invocationTracker: trackerB.tracker,
    });

    const outcomes = await Promise.allSettled([
      triggerA.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1'),
      triggerB.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1'),
    ]);
    await waitForTrigger();

    assert.ok(
      outcomes.every(
        (outcome) =>
          (outcome.status === 'fulfilled' && outcome.value === 'dispatched') ||
          (outcome.status === 'rejected' && /running without execution-start receipt/.test(String(outcome.reason))),
      ),
      'the CAS loser may acknowledge only after observing the winner start; otherwise it must fail closed',
    );
    assert.ok(outcomes.some((outcome) => outcome.status === 'fulfilled' && outcome.value === 'dispatched'));
    assert.strictEqual(routerMock.calls.length, 1, 'only the worker that atomically claims queued may execute');
    assert.strictEqual(sharedRecordMock.getRecord().status, 'succeeded');
    assert.strictEqual(trackerA.completes.length, 1);
    assert.strictEqual(trackerB.completes.length, 1);
  });

  it('rejects a running duplicate until the claimed executor has a durable start receipt', async () => {
    const sharedStore = new InvocationRecordStore();
    const trackerA = mockInvocationTracker();
    const trackerB = mockInvocationTracker();
    let routeCalls = 0;
    /** @type {() => void} */
    let signalEntered;
    const entered = new Promise((resolve) => {
      signalEntered = resolve;
    });
    /** @type {() => void} */
    let releaseRoute;
    const routeReleased = new Promise((resolve) => {
      releaseRoute = resolve;
    });
    const blockingRouter = /** @type {any} */ ({
      async *routeExecution(_userId, _message, _threadId, _messageId, targetCats) {
        routeCalls++;
        signalEntered();
        await routeReleased;
        yield { type: 'text', catId: targetCats[0], content: 'started', timestamp: Date.now() };
        yield { type: 'done', catId: targetCats[0], content: '', timestamp: Date.now() };
      },
      async ackCollectedCursors() {},
    });
    const triggerA = createTrigger({
      router: blockingRouter,
      invocationRecordStore: sharedStore,
      invocationTracker: trackerA.tracker,
    });
    const triggerB = createTrigger({
      router: blockingRouter,
      invocationRecordStore: sharedStore,
      invocationTracker: trackerB.tracker,
    });

    const firstOutcome = triggerA.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
    await entered;

    const claimed = sharedStore.getByIdempotencyKey('thread-1', 'user-1', 'connector-msg-1');
    assert.strictEqual(claimed?.status, 'running');
    assert.strictEqual(claimed?.executionStartedAt, undefined);

    try {
      await assert.rejects(
        triggerB.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1'),
        /running without execution-start receipt/,
      );
      assert.strictEqual(routeCalls, 1, 'duplicate worker must not execute before start receipt exists');
    } finally {
      releaseRoute();
    }

    assert.strictEqual(await firstOutcome, 'dispatched');
    await waitForTrigger();
    const completed = sharedStore.getByIdempotencyKey('thread-1', 'user-1', 'connector-msg-1');
    assert.strictEqual(completed?.status, 'succeeded');
    assert.strictEqual(typeof completed?.executionStartedAt, 'number');
    assert.strictEqual(routeCalls, 1);
  });

  it('does not acknowledge a failed replay from the previous attempt receipt', async () => {
    const sharedStore = new InvocationRecordStore();
    const { invocationId } = await sharedStore.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: 'connector-msg-1',
      actionLeaseCarrier: { kind: 'none' },
    });
    sharedStore.update(invocationId, { status: 'running', expectedStatus: 'queued' });
    sharedStore.update(invocationId, {
      executionStartedAt: Date.now() - 1_000,
      expectedStatus: 'running',
    });
    sharedStore.update(invocationId, {
      status: 'failed',
      error: 'process_restart',
      expectedStatus: 'running',
    });

    const trackerA = mockInvocationTracker();
    const trackerB = mockInvocationTracker();
    let routeCalls = 0;
    /** @type {() => void} */
    let signalEntered;
    const entered = new Promise((resolve) => {
      signalEntered = resolve;
    });
    /** @type {() => void} */
    let releaseChildCreation;
    const childCreationReleased = new Promise((resolve) => {
      releaseChildCreation = resolve;
    });
    const blockingRouter = /** @type {any} */ ({
      async *routeExecution(_userId, _message, _threadId, _messageId, targetCats, _intent, options) {
        routeCalls++;
        signalEntered();
        await childCreationReleased;
        yield {
          type: 'system_info',
          catId: targetCats[0],
          content: JSON.stringify({
            type: 'invocation_created',
            invocationId: 'child-retry-1',
            parentInvocationId: options.parentInvocationId,
            executionKind: 'foreground',
            startedAt: Date.now(),
          }),
          timestamp: Date.now(),
        };
        yield { type: 'done', catId: targetCats[0], content: '', timestamp: Date.now() };
      },
      async ackCollectedCursors() {},
    });
    const triggerA = createTrigger({
      router: blockingRouter,
      routerIncludesInvocationLifecycle: true,
      invocationRecordStore: sharedStore,
      invocationTracker: trackerA.tracker,
    });
    const triggerB = createTrigger({
      router: blockingRouter,
      routerIncludesInvocationLifecycle: true,
      invocationRecordStore: sharedStore,
      invocationTracker: trackerB.tracker,
    });

    const firstOutcome = triggerA.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
    await entered;

    try {
      const claimed = sharedStore.get(invocationId);
      assert.strictEqual(claimed?.status, 'running');
      assert.strictEqual(
        claimed?.executionStartedAt,
        undefined,
        'a new failed-record attempt must not inherit the previous attempt receipt',
      );
      await assert.rejects(
        triggerB.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1'),
        /running without execution-start receipt/,
      );
      assert.strictEqual(routeCalls, 1, 'the duplicate must not execute or acknowledge before the new receipt');
    } finally {
      releaseChildCreation();
      await firstOutcome;
      await waitForTrigger();
    }

    const completed = sharedStore.get(invocationId);
    assert.strictEqual(completed?.status, 'succeeded');
    assert.strictEqual(typeof completed?.executionStartedAt, 'number');
    assert.strictEqual(routeCalls, 1);
  });

  for (const [label, buildPreInvocationMessages] of [
    [
      'incremental degradation',
      (_parentInvocationId, catId) => [
        { type: 'system_info', catId, content: 'incremental context was truncated', timestamp: Date.now() },
      ],
    ],
    [
      'context briefing',
      (_parentInvocationId, catId) => [
        {
          type: 'system_info',
          catId,
          content: JSON.stringify({ type: 'context_briefing', messageId: 'briefing-1' }),
          timestamp: Date.now(),
        },
      ],
    ],
    [
      'malformed or foreign invocation_created',
      (parentInvocationId, catId) => [
        {
          type: 'system_info',
          catId,
          content: JSON.stringify({ type: 'invocation_created', invocationId: '', parentInvocationId }),
          timestamp: Date.now(),
        },
        {
          type: 'system_info',
          catId,
          content: JSON.stringify({
            type: 'invocation_created',
            invocationId: 'child-from-another-parent',
            parentInvocationId: 'another-parent',
            startedAt: Date.now(),
          }),
          timestamp: Date.now(),
        },
      ],
    ],
  ]) {
    it(`does not acknowledge ${label} as durable child execution`, async () => {
      const sharedStore = new InvocationRecordStore();
      const trackerA = mockInvocationTracker();
      const trackerB = mockInvocationTracker();
      let routeCalls = 0;
      /** @type {() => void} */
      let signalPreInvocationConsumed;
      const preInvocationConsumed = new Promise((resolve) => {
        signalPreInvocationConsumed = resolve;
      });
      /** @type {() => void} */
      let releaseChildCreation;
      const childCreationReleased = new Promise((resolve) => {
        releaseChildCreation = resolve;
      });
      const blockingRouter = /** @type {any} */ ({
        async *routeExecution(_userId, _message, _threadId, _messageId, targetCats, _intent, options) {
          routeCalls++;
          for (const preInvocationMessage of buildPreInvocationMessages(options.parentInvocationId, targetCats[0])) {
            yield preInvocationMessage;
          }
          signalPreInvocationConsumed();
          await childCreationReleased;
          yield {
            type: 'system_info',
            catId: targetCats[0],
            content: JSON.stringify({
              type: 'invocation_created',
              invocationId: 'child-invocation-1',
              parentInvocationId: options.parentInvocationId,
              executionKind: 'foreground',
              startedAt: Date.now(),
            }),
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: targetCats[0], content: '', timestamp: Date.now() };
        },
        async ackCollectedCursors() {},
      });
      const triggerA = createTrigger({
        router: blockingRouter,
        routerIncludesInvocationLifecycle: true,
        invocationRecordStore: sharedStore,
        invocationTracker: trackerA.tracker,
      });
      const triggerB = createTrigger({
        router: blockingRouter,
        routerIncludesInvocationLifecycle: true,
        invocationRecordStore: sharedStore,
        invocationTracker: trackerB.tracker,
      });

      const firstOutcome = triggerA.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
      await preInvocationConsumed;

      try {
        const claimed = sharedStore.getByIdempotencyKey('thread-1', 'user-1', 'connector-msg-1');
        assert.strictEqual(
          claimed?.executionStartedAt,
          undefined,
          `${label} must not create an execution-start receipt`,
        );
        await assert.rejects(
          triggerB.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1'),
          /running without execution-start receipt/,
        );
        assert.strictEqual(routeCalls, 1, 'duplicate worker must not execute before invocation_created');
      } finally {
        releaseChildCreation();
      }

      assert.strictEqual(await firstOutcome, 'dispatched');
      await waitForTrigger();
      const completed = sharedStore.getByIdempotencyKey('thread-1', 'user-1', 'connector-msg-1');
      assert.strictEqual(completed?.status, 'succeeded');
      assert.strictEqual(typeof completed?.executionStartedAt, 'number');
      assert.strictEqual(routeCalls, 1);
    });
  }

  for (const statusAfterConflict of ['failed', 'canceled', 'missing']) {
    it(`fails closed when a queued claim loser re-reads ${statusAfterConflict}`, async () => {
      let reads = 0;
      const queuedRecord = {
        id: 'inv-existing',
        threadId: 'thread-1',
        userId: 'user-1',
        userMessageId: 'msg-1',
        targetCats: ['opus'],
        intent: 'execute',
        status: 'queued',
        idempotencyKey: 'connector-msg-1',
        actionLeaseCarrier: { kind: 'none' },
        createdAt: Date.now() - 1_000,
        updatedAt: Date.now() - 1_000,
      };
      const conflictingStore = /** @type {any} */ ({
        async create() {
          return { outcome: 'duplicate', invocationId: queuedRecord.id };
        },
        async get() {
          reads++;
          if (reads === 1) return { ...queuedRecord };
          return statusAfterConflict === 'missing' ? null : { ...queuedRecord, status: statusAfterConflict };
        },
        async update() {
          return null;
        },
      });
      const trigger = createTrigger({ invocationRecordStore: conflictingStore });

      await assert.rejects(
        trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1'),
        new RegExp(`status: ${statusAfterConflict}`),
      );

      assert.strictEqual(routerMock.calls.length, 0);
      assert.strictEqual(trackerMock.completes.length, 1);
    });
  }

  it('acknowledges a running duplicate without starting a second execution', async () => {
    recordMock.setDuplicate('running');
    const trigger = createTrigger();

    const outcome = await trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
    await waitForTrigger();

    assert.strictEqual(outcome, 'dispatched');
    assert.strictEqual(routerMock.calls.length, 0);
    assert.strictEqual(trackerMock.completes.length, 1);
  });

  it('rejects a canceled duplicate instead of claiming a fresh dispatch', async () => {
    recordMock.setDuplicate('canceled');
    const trigger = createTrigger();

    await assert.rejects(
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1'),
      /existing invocation inv-existing is canceled/,
    );

    assert.strictEqual(routerMock.calls.length, 0);
    assert.strictEqual(trackerMock.completes.length, 1);
  });

  it('rejects a duplicate whose durable record cannot be loaded', async () => {
    recordMock.setMissingDuplicate();
    const trigger = createTrigger();

    await assert.rejects(
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1'),
      /existing invocation inv-existing is missing/,
    );

    assert.strictEqual(routerMock.calls.length, 0);
    assert.strictEqual(trackerMock.completes.length, 1);
  });

  it('cancels when thread is being deleted (aborted signal)', async () => {
    trackerMock.setAborted(true);
    const trigger = createTrigger();
    await assert.rejects(
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1'),
      /canceled before execution started/,
    );
    await waitForTrigger();

    // Should not call routeExecution
    assert.strictEqual(routerMock.calls.length, 0);

    // Should update status to canceled
    const cancelUpdate = recordMock.updates.find((u) => u.data.status === 'canceled');
    assert.ok(cancelUpdate, 'Should set status to canceled');
  });

  it('late-binds cancel-all suppression when direct admission is aborted before invocation ID binding', async () => {
    const controller = new AbortController();
    trackerMock.tracker.tryStartThread = () => controller;
    const suppressCalls = /** @type {Array<{threadId: string, catId: string, executionIds: readonly string[]}>} */ ([]);
    const bindCalls = /** @type {Array<{threadId: string, catId: string, executionId: string}>} */ ([]);
    const completionCalls = /** @type {Array<{status: string, invocationId: string | undefined}>} */ ([]);
    const mockQueueProcessor = /** @type {any} */ ({
      isAutoResumeSuppressed: () => false,
      isThreadBusy: () => false,
      suppressAutoResume(threadId, catId, executionIds = []) {
        suppressCalls.push({ threadId, catId, executionIds });
      },
      bindAutoResumeSuppressionExecution(threadId, catId, executionId) {
        bindCalls.push({ threadId, catId, executionId });
      },
      async onInvocationComplete(_threadId, _catId, status, invocationId) {
        completionCalls.push({ status, invocationId });
      },
    });
    recordMock.setBeforeCreate(() => {
      controller.abort('cancel_all');
      // cancelAll/force-reset can only arm a slot fence here because the
      // durable InvocationRecord identity does not exist until create returns.
      mockQueueProcessor.suppressAutoResume('thread-1', 'opus');
    });

    const trigger = createTrigger({ queueProcessor: mockQueueProcessor });
    await assert.rejects(
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-pre-bind-cancel'),
      /canceled before execution started/,
    );
    await waitForTrigger();

    assert.deepStrictEqual(
      suppressCalls,
      [{ threadId: 'thread-1', catId: 'opus', executionIds: [] }],
      'the reset action must arm one anonymous pre-bind fence',
    );
    assert.deepStrictEqual(
      bindCalls,
      [{ threadId: 'thread-1', catId: 'opus', executionId: 'inv-1' }],
      'durable admission must bind the canceled direct invocation without renewing the fence',
    );
    assert.deepStrictEqual(completionCalls, [{ status: 'canceled', invocationId: 'inv-1' }]);
    assert.strictEqual(routerMock.calls.length, 0, 'pre-bind cancel-all must never reach routeExecution');
  });

  it('rejects when routeExecution fails before durable execution starts', async () => {
    routerMock = mockRouter({ throwError: new Error('CLI crashed') });
    const trigger = createTrigger({ router: routerMock.router });
    await assert.rejects(
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1'),
      /CLI crashed/,
    );
    await waitForTrigger();

    // Should update status to failed
    const failUpdate = recordMock.updates.find((u) => u.data.status === 'failed');
    assert.ok(failUpdate, 'Should set status to failed');
    assert.ok(failUpdate.data.error.includes('CLI crashed'));

    // Should broadcast error to WebSocket
    const errorBroadcast = socketMock.broadcasts.find((b) => b.msg.type === 'error');
    assert.ok(errorBroadcast, 'Should broadcast error');

    // Should still complete tracker (finally block)
    assert.strictEqual(trackerMock.completes.length, 1);
  });

  it('marks failed on persistence failure', async () => {
    routerMock = mockRouter({ persistenceFail: true });
    const trigger = createTrigger({ router: routerMock.router });
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
    await waitForTrigger();

    const failUpdate = recordMock.updates.find((u) => u.data.status === 'failed');
    assert.ok(failUpdate, 'Should set status to failed on persistence failure');
    assert.ok(failUpdate.data.error.includes('persistence failed'));

    // Should NOT ack cursors
    assert.strictEqual(routerMock.ackCalls.length, 0);
  });

  // ── 砚砚 R1 P1: pre-try errors must not leak unhandledRejection ──

  it('R1-P1 regression: create() throws → no unhandledRejection, no tracker leak', async () => {
    // Override create to throw
    recordMock.store.create = async () => {
      throw new Error('create boom');
    };

    const trigger = createTrigger();
    await assert.rejects(
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1'),
      /create boom/,
    );
    await waitForTrigger();

    // start() not called (F185: tryStartThread used instead)
    assert.strictEqual(trackerMock.starts.length, 0);
    // F185: tryStartThread WAS called (controller pre-acquired in trigger)
    assert.strictEqual(trackerMock.tryStartThreadCalls.length, 1, 'controller was pre-acquired');
    // R1-P1 FIX: controller must be released even when create() throws
    assert.strictEqual(trackerMock.completes.length, 1, 'pre-acquired controller must be released on create failure');
    // Should NOT call routeExecution
    assert.strictEqual(routerMock.calls.length, 0);
    // No unhandledRejection = test process survives
  });

  it('PR #1181 P1: dispatched is returned only after the invocation record is durable', async () => {
    recordMock.store.create = async () => {
      throw new Error('record store unavailable');
    };

    const trigger = createTrigger();
    await assert.rejects(
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-durable-admission'),
      /record store unavailable/,
    );

    assert.strictEqual(routerMock.calls.length, 0, 'execution must not start without a durable invocation record');
    assert.strictEqual(trackerMock.completes.length, 1, 'failed admission must release the pre-acquired controller');
  });

  it('R1-P1 regression: durable claim throws → tracker completes without execution', async () => {
    let updateCallCount = 0;
    recordMock.store.update = async (id, data) => {
      updateCallCount++;
      // First update is the queued -> running claim with userMessageId binding.
      if (updateCallCount === 1 && data.userMessageId) {
        throw new Error('claim boom');
      }
      recordMock.updates.push({ id, data });
    };

    const trigger = createTrigger();
    await assert.rejects(
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1'),
      /claim boom/,
    );
    await waitForTrigger();

    // Tracker must have been started AND completed (no leak)
    assert.strictEqual(trackerMock.tryStartThreadCalls.length, 1, 'tracker should start via tryStartThread');
    assert.strictEqual(trackerMock.completes.length, 1, 'tracker must complete even on backfill error');

    // Should NOT call routeExecution (error happened before)
    assert.strictEqual(routerMock.calls.length, 0);
  });

  // ── F39 Phase C: Queue mode tests ──

  // ── ISSUE-9: Multi-cat A2A outbound delivery ──

  it('delivers outbound messages per-cat for multi-cat A2A responses (ISSUE-9)', async () => {
    // Mock router that yields messages from TWO cats (A2A chain: opus → codex)
    const multiCatRouter = /** @type {any} */ ({
      async *routeExecution(userId, message, threadId, userMessageId, targetCats, intent, options) {
        yield { type: 'text', catId: 'opus', content: 'Hello from opus!', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'opus',
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 100, outputTokens: 50 } },
        };
        yield { type: 'text', catId: 'codex', content: 'Hello from codex!', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'codex',
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 80, outputTokens: 40 } },
        };
      },
      async ackCollectedCursors() {},
    });

    const deliverCalls = /** @type {Array<{threadId: string, content: string, catId: string}>} */ ([]);
    const outboundHook = {
      deliver: async (threadId, content, catId) => {
        deliverCalls.push({ threadId, content, catId });
      },
    };

    const trigger = createTrigger({ router: multiCatRouter, outboundHook });
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Hello', 'msg-1');
    await waitForTrigger();

    // Should deliver TWICE — one per cat, not merged into one
    assert.strictEqual(deliverCalls.length, 2, 'Should deliver once per cat in A2A chain');
    assert.strictEqual(deliverCalls[0].catId, 'opus');
    assert.strictEqual(deliverCalls[0].content, 'Hello from opus!');
    assert.strictEqual(deliverCalls[1].catId, 'codex');
    assert.strictEqual(deliverCalls[1].content, 'Hello from codex!');
  });

  it('BUG-5: multi-turn delivers per-turn for all connectors (no merge needed)', async () => {
    const multiCatRouter = /** @type {any} */ ({
      async *routeExecution(userId, message, threadId, userMessageId, targetCats, intent, options) {
        yield { type: 'text', catId: 'opus', content: 'Hello from opus!', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'opus',
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 100, outputTokens: 50 } },
        };
        yield { type: 'text', catId: 'codex', content: 'Hello from codex!', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'codex',
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 80, outputTokens: 40 } },
        };
      },
      async ackCollectedCursors() {},
    });

    const deliverCalls = /** @type {Array<{threadId: string, content: string, catId: string}>} */ ([]);
    const outboundHook = {
      deliver: async (threadId, content, catId) => {
        deliverCalls.push({ threadId, content, catId });
      },
    };

    const trigger = createTrigger({ router: multiCatRouter, outboundHook });
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Hello', 'msg-1');
    await waitForTrigger();

    assert.strictEqual(deliverCalls.length, 2, 'Multi-turn delivers per-turn');
    assert.strictEqual(deliverCalls[0].catId, 'opus');
    assert.strictEqual(deliverCalls[0].content, 'Hello from opus!');
    assert.strictEqual(deliverCalls[1].catId, 'codex');
    assert.strictEqual(deliverCalls[1].content, 'Hello from codex!');
  });

  it('single-cat outbound delivery still works with per-cat logic', async () => {
    const deliverCalls = /** @type {Array<{threadId: string, content: string, catId: string}>} */ ([]);
    const outboundHook = {
      deliver: async (threadId, content, catId) => {
        deliverCalls.push({ threadId, content, catId });
      },
    };

    const trigger = createTrigger({ outboundHook });
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Review msg', 'msg-1');
    await waitForTrigger();

    assert.strictEqual(deliverCalls.length, 1, 'Single cat should deliver once');
    assert.strictEqual(deliverCalls[0].catId, 'opus');
    assert.strictEqual(deliverCalls[0].content, 'Review noted. Working on it.');
  });

  it('R1-P1: delivers richBlocks-only reply (no text) via outbound hook', async () => {
    // Router yields only richBlocks with no text content
    const richOnlyRouter = /** @type {any} */ ({
      async *routeExecution(userId, message, threadId, userMessageId, targetCats, intent, options) {
        // Simulate richBlocks being stashed (no text message, just done with richBlocks)
        if (options?.persistenceContext) {
          options.persistenceContext.richBlocks = [{ type: 'code', language: 'js', content: 'console.log("hi")' }];
        }
        yield {
          type: 'done',
          catId: 'opus',
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 10, outputTokens: 5 } },
        };
      },
      async ackCollectedCursors() {},
    });

    const deliverCalls = /** @type {Array<{threadId: string, content: string, catId: string, richBlocks: any}>} */ ([]);
    const outboundHook = {
      deliver: async (threadId, content, catId, richBlocks) => {
        deliverCalls.push({ threadId, content, catId, richBlocks });
      },
    };

    const trigger = createTrigger({ router: richOnlyRouter, outboundHook });
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Show code', 'msg-1');
    await waitForTrigger();

    assert.strictEqual(deliverCalls.length, 1, 'Should deliver richBlocks-only reply');
    assert.ok(deliverCalls[0].richBlocks?.length > 0, 'Should include richBlocks');
  });

  it('R1-P2: multi-cat outbound delivery preserves order (sequential await)', async () => {
    const multiCatRouter = /** @type {any} */ ({
      async *routeExecution(userId, message, threadId, userMessageId, targetCats, intent, options) {
        yield { type: 'text', catId: 'opus', content: 'First', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'opus',
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 1, outputTokens: 1 } },
        };
        yield { type: 'text', catId: 'codex', content: 'Second', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'codex',
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 1, outputTokens: 1 } },
        };
      },
      async ackCollectedCursors() {},
    });

    // Simulate slow network: first deliver takes longer than second
    const deliverOrder = /** @type {string[]} */ ([]);
    const outboundHook = {
      deliver: async (threadId, content, catId) => {
        if (catId === 'opus') {
          await new Promise((r) => setTimeout(r, 20)); // slow
        }
        deliverOrder.push(catId);
      },
    };

    const trigger = createTrigger({ router: multiCatRouter, outboundHook });
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Hello', 'msg-1');
    await new Promise((r) => setTimeout(r, 200)); // wait for async

    assert.deepStrictEqual(deliverOrder, ['opus', 'codex'], 'Should deliver in cat order, not race order');
  });

  it('cloud-P1: delivers fallback message for silent invocation (#873)', async () => {
    // Router yields only 'done' — no text, no richBlocks.
    // #873 fix: silent path now delivers a fallback so IM users aren't left hanging.
    const silentRouter = /** @type {any} */ ({
      async *routeExecution(userId, message, threadId, userMessageId, targetCats, intent, options) {
        yield {
          type: 'done',
          catId: 'opus',
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 0, outputTokens: 0 } },
        };
      },
      async ackCollectedCursors() {},
    });

    const deliverCalls = /** @type {any[]} */ ([]);
    const outboundHook = {
      deliver: async (threadId, content, catId) => {
        deliverCalls.push({ threadId, content, catId });
      },
    };

    const trigger = createTrigger({ router: silentRouter, outboundHook });
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
    await waitForTrigger();

    assert.strictEqual(deliverCalls.length, 1, 'Should deliver fallback for silent invocation');
    assert.strictEqual(deliverCalls[0].catId, 'opus');
    assert.ok(deliverCalls[0].content, 'Fallback content should be non-empty');
  });

  it('cloud-P1: hanging deliver does not block tracker cleanup', async () => {
    const hangingRouter = /** @type {any} */ ({
      async *routeExecution(userId, message, threadId, userMessageId, targetCats, intent, options) {
        yield { type: 'text', catId: 'opus', content: 'Hello', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'opus',
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 1, outputTokens: 1 } },
        };
        yield { type: 'text', catId: 'codex', content: 'World', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'codex',
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 1, outputTokens: 1 } },
        };
      },
      async ackCollectedCursors() {},
    });

    const outboundHook = {
      deliver: async () => {
        // Simulate hanging forever
        await new Promise(() => {});
      },
    };

    // Use short timeout (100ms) to keep test fast
    const trigger = createTrigger({ router: hangingRouter, outboundHook, deliverTimeoutMs: 100 });
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
    // Wait longer than timeout (100ms * 2 cats + buffer)
    await new Promise((r) => setTimeout(r, 500));

    // Tracker must have completed despite hanging deliver
    assert.strictEqual(trackerMock.completes.length, 1, 'Tracker must complete even if deliver hangs');
  });

  it('cloud-R4-P2: late-success delivery triggers deferred placeholder cleanup', async () => {
    /** @type {() => void} */
    let resolveDeliver = () => {};
    const deliverPromise = new Promise((r) => {
      resolveDeliver = r;
    });
    const outboundHook = {
      deliver: async () => {
        await deliverPromise;
      },
    };
    let cleanupCalled = false;
    const streamingHook = {
      async onStreamStart() {},
      async onStreamChunk() {},
      async onStreamEnd() {},
      cleanupPlaceholders: async () => {
        cleanupCalled = true;
      },
    };

    const trigger = createTrigger({
      outboundHook,
      streamingHook,
      deliverTimeoutMs: 50,
    });
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');

    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(cleanupCalled, false, 'cleanup must NOT run immediately after timeout');

    resolveDeliver();
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(cleanupCalled, true, 'cleanup must run after late-success delivery');
  });

  it('cloud-R5-P1: late-failure delivery must NOT trigger cleanup (preserve placeholder as fallback)', async () => {
    // R5-P1 design: on delivery failure, placeholder is preserved so next retry/invocation can
    // consume it. Calling cleanupPlaceholders on failure would incorrectly finalize the card.
    /** @type {(err: Error) => void} */
    let rejectDeliver = () => {};
    const deliverPromise = new Promise((_, rej) => {
      rejectDeliver = rej;
    });
    const outboundHook = {
      deliver: async () => {
        await deliverPromise;
      },
    };
    let cleanupCalled = false;
    const streamingHook = {
      async onStreamStart() {},
      async onStreamChunk() {},
      async onStreamEnd() {},
      cleanupPlaceholders: async () => {
        cleanupCalled = true;
      },
    };

    const trigger = createTrigger({
      outboundHook,
      streamingHook,
      deliverTimeoutMs: 50,
    });
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');

    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(cleanupCalled, false, 'cleanup must NOT run before inflight promises settle');

    rejectDeliver(new Error('connector down'));
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(
      cleanupCalled,
      false,
      'cleanup must NOT run after hard delivery failure (R5-P1: preserve placeholder)',
    );
  });

  it('R7: silent fallback late-success triggers deferred placeholder cleanup', async () => {
    // Silent invocation (only done, no text) → deliver times out → deliver later succeeds
    // → cleanupPlaceholders must be called on late-success (R7 fix).
    const silentRouter = /** @type {any} */ ({
      async *routeExecution(_u, _m, _t, _mid, targetCats, _i, _o) {
        yield {
          type: 'done',
          catId: targetCats[0],
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 0, outputTokens: 0 } },
        };
      },
      async ackCollectedCursors() {},
    });

    /** @type {() => void} */
    let resolveDeliver = () => {};
    const deliverPromise = new Promise((r) => {
      resolveDeliver = r;
    });
    const outboundHook = {
      deliver: async () => {
        await deliverPromise;
      },
    };
    let cleanupCalled = false;
    const streamingHook = {
      async onStreamStart() {},
      async onStreamChunk() {},
      async onStreamEnd() {},
      cleanupPlaceholders: async () => {
        cleanupCalled = true;
      },
    };

    const trigger = createTrigger({
      router: silentRouter,
      outboundHook,
      streamingHook,
      deliverTimeoutMs: 50,
    });
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');

    // Wait for timeout to fire
    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(cleanupCalled, false, 'cleanup must NOT run immediately after silent timeout');

    // Late-success: deliver finally resolves
    resolveDeliver();
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(cleanupCalled, true, 'cleanup must run after silent late-success delivery (R7)');
  });

  it('R7: silent fallback late-failure must NOT trigger cleanup (preserve placeholder)', async () => {
    // Silent invocation → deliver times out → deliver later rejects
    // → cleanupPlaceholders must NOT be called (thinking card stays as fallback UX).
    const silentRouter = /** @type {any} */ ({
      async *routeExecution(_u, _m, _t, _mid, targetCats, _i, _o) {
        yield {
          type: 'done',
          catId: targetCats[0],
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 0, outputTokens: 0 } },
        };
      },
      async ackCollectedCursors() {},
    });

    /** @type {(err: Error) => void} */
    let rejectDeliver = () => {};
    const deliverPromise = new Promise((_, rej) => {
      rejectDeliver = rej;
    });
    const outboundHook = {
      deliver: async () => {
        await deliverPromise;
      },
    };
    let cleanupCalled = false;
    const streamingHook = {
      async onStreamStart() {},
      async onStreamChunk() {},
      async onStreamEnd() {},
      cleanupPlaceholders: async () => {
        cleanupCalled = true;
      },
    };

    const trigger = createTrigger({
      router: silentRouter,
      outboundHook,
      streamingHook,
      deliverTimeoutMs: 50,
    });
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');

    await new Promise((r) => setTimeout(r, 200));
    assert.strictEqual(cleanupCalled, false, 'cleanup must NOT run after silent timeout');

    // Late-failure: deliver rejects
    rejectDeliver(new Error('connector down'));
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(
      cleanupCalled,
      false,
      'cleanup must NOT run after silent hard failure (R7: preserve placeholder)',
    );
  });

  it('cloud-P1-4: A→B→A ping-pong delivers 3 separate turns (not merged by catId)', async () => {
    const pingPongRouter = /** @type {any} */ ({
      async *routeExecution(userId, message, threadId, userMessageId, targetCats, intent, options) {
        // Turn 1: opus responds
        yield { type: 'text', catId: 'opus', content: 'Opus turn 1', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'opus',
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 10, outputTokens: 5 } },
        };
        // Turn 2: codex responds (A2A)
        yield { type: 'text', catId: 'codex', content: 'Codex review', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'codex',
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 20, outputTokens: 10 } },
        };
        // Turn 3: opus responds again (A2A back)
        yield { type: 'text', catId: 'opus', content: 'Opus turn 3', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'opus',
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 15, outputTokens: 8 } },
        };
      },
      async ackCollectedCursors() {},
    });

    const deliverCalls = /** @type {Array<{catId: string, content: string}>} */ ([]);
    const outboundHook = {
      deliver: async (threadId, content, catId) => {
        deliverCalls.push({ catId, content });
      },
    };

    const trigger = createTrigger({ router: pingPongRouter, outboundHook });
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
    await waitForTrigger();

    // Should deliver 3 separate turns, not 2 (with opus merged)
    assert.strictEqual(deliverCalls.length, 3, 'Should deliver 3 turns for A→B→A');
    assert.strictEqual(deliverCalls[0].catId, 'opus');
    assert.strictEqual(deliverCalls[0].content, 'Opus turn 1');
    assert.strictEqual(deliverCalls[1].catId, 'codex');
    assert.strictEqual(deliverCalls[1].content, 'Codex review');
    assert.strictEqual(deliverCalls[2].catId, 'opus');
    assert.strictEqual(deliverCalls[2].content, 'Opus turn 3');
  });

  it('cloud-P1-5: richBlocks-only re-entry after silent cat gets own turn', async () => {
    // A→B(silent)→A(richBlocks-only): opus text+done, codex silent done, opus richBlocks+done
    const reentryRouter = /** @type {any} */ ({
      async *routeExecution(userId, message, threadId, userMessageId, targetCats, intent, options) {
        // Turn 1: opus responds with text
        yield { type: 'text', catId: 'opus', content: 'Opus first', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'opus',
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 10, outputTokens: 5 } },
        };
        // Turn 2: codex is silent (only done, no text/richBlocks)
        yield {
          type: 'done',
          catId: 'codex',
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 5, outputTokens: 0 } },
        };
        // Turn 3: opus re-enters with richBlocks only (no text)
        if (options?.persistenceContext) {
          options.persistenceContext.richBlocks = [{ type: 'code', language: 'js', content: 'return 42;' }];
        }
        yield {
          type: 'done',
          catId: 'opus',
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 8, outputTokens: 3 } },
        };
      },
      async ackCollectedCursors() {},
    });

    const deliverCalls = /** @type {Array<{catId: string, content: string, richBlocks: any}>} */ ([]);
    const outboundHook = {
      deliver: async (threadId, content, catId, richBlocks) => {
        deliverCalls.push({ catId, content, richBlocks });
      },
    };

    const trigger = createTrigger({ router: reentryRouter, outboundHook });
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
    await waitForTrigger();

    // Should deliver 2 turns: opus text + opus richBlocks (separate, not merged)
    assert.strictEqual(deliverCalls.length, 2, 'Should deliver 2 separate turns');
    assert.strictEqual(deliverCalls[0].catId, 'opus');
    assert.strictEqual(deliverCalls[0].content, 'Opus first');
    assert.strictEqual(deliverCalls[1].catId, 'opus');
    assert.ok(deliverCalls[1].richBlocks?.length > 0, 'Second turn should have richBlocks');
  });

  it('cloud-P1-3: silent first cat → second cat reply uses actual speaker catId', async () => {
    // opus is silent (no text, no richBlocks), codex responds
    const silentFirstRouter = /** @type {any} */ ({
      async *routeExecution(userId, message, threadId, userMessageId, targetCats, intent, options) {
        // opus: silent — only done, no text
        yield {
          type: 'done',
          catId: 'opus',
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 10, outputTokens: 0 } },
        };
        // codex: responds with text
        yield { type: 'text', catId: 'codex', content: 'I can help!', timestamp: Date.now() };
        yield {
          type: 'done',
          catId: 'codex',
          content: '',
          timestamp: Date.now(),
          metadata: { usage: { inputTokens: 50, outputTokens: 20 } },
        };
      },
      async ackCollectedCursors() {},
    });

    const deliverCalls = /** @type {Array<{catId: string, content: string}>} */ ([]);
    const outboundHook = {
      deliver: async (threadId, content, catId) => {
        deliverCalls.push({ catId, content });
      },
    };

    const trigger = createTrigger({ router: silentFirstRouter, outboundHook });
    // Trigger as opus, but opus is silent — codex is the actual speaker
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
    await waitForTrigger();

    assert.strictEqual(deliverCalls.length, 1, 'Should deliver only codex reply');
    assert.strictEqual(deliverCalls[0].catId, 'codex', 'Should use actual speaker catId, not trigger catId');
    assert.strictEqual(deliverCalls[0].content, 'I can help!');
  });

  describe('queue mode (active invocation running)', () => {
    it('enqueues connector message when another cat is running', async () => {
      trackerMock.setActive('thread-1');
      const trigger = createTrigger();
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Review msg', 'msg-1');
      await waitForTrigger();

      // Should NOT call routeExecution (queued instead)
      assert.strictEqual(routerMock.calls.length, 0);
      // Should NOT start tracker (no direct execution)
      assert.strictEqual(trackerMock.starts.length, 0);
      // Should NOT create InvocationRecord (no direct execution)
      assert.strictEqual(recordMock.creates.length, 0);

      // Queue should have the entry
      const entries = queue.list('thread-1', 'user-1');
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].content, 'Review msg');
      assert.strictEqual(entries[0].source, 'connector');
      assert.strictEqual(entries[0].messageId, 'msg-1');
      assert.deepStrictEqual(entries[0].targetCats, ['opus']);
    });

    it('urgent connector enqueues with priority instead of preempting (F175)', async () => {
      trackerMock.setActive('thread-1', 'user-1');
      const trigger = createTrigger();
      trigger.trigger(
        'thread-1',
        /** @type {any} */ ('opus'),
        'user-1',
        'Urgent review msg',
        'msg-urgent-1',
        undefined,
        {
          priority: 'urgent',
          reason: 'github_review',
        },
      );
      await waitForTrigger();

      assert.strictEqual(trackerMock.cancelCalls.length, 0, 'F175: no preemption — active signal must not be aborted');
      assert.strictEqual(routerMock.calls.length, 0, 'Should not execute directly — goes through queue');

      const entries = queue.list('thread-1', 'user-1');
      assert.strictEqual(entries.length, 1, 'Should enqueue urgent message');
      assert.strictEqual(entries[0].priority, 'urgent', 'Entry should carry urgent priority');
      assert.strictEqual(entries[0].messageId, 'msg-urgent-1');
    });

    it('urgent connector passes sourceCategory to queue entry (F175)', async () => {
      trackerMock.setActive('thread-1', 'user-1');
      const trigger = createTrigger();
      trigger.trigger(
        'thread-1',
        /** @type {any} */ ('opus'),
        'user-1',
        'Review with category',
        'msg-cat-1',
        undefined,
        {
          priority: 'urgent',
          reason: 'github_review',
          sourceCategory: 'review',
        },
      );
      await waitForTrigger();

      const entries = queue.list('thread-1', 'user-1');
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].sourceCategory, 'review', 'sourceCategory should be preserved on queue entry');
      assert.strictEqual(entries[0].priority, 'urgent');
    });

    it('urgent connector with owner mismatch still enqueues without cancel (F175)', async () => {
      trackerMock.setActive('thread-1', 'owner-user');
      const trigger = createTrigger();
      trigger.trigger(
        'thread-1',
        /** @type {any} */ ('opus'),
        'user-2',
        'Urgent review msg',
        'msg-urgent-2',
        undefined,
        {
          priority: 'urgent',
          reason: 'github_review',
        },
      );
      await waitForTrigger();

      assert.strictEqual(trackerMock.cancelCalls.length, 0, 'F175: no cancel calls for any urgent trigger');
      assert.strictEqual(routerMock.calls.length, 0, 'Should not execute directly');

      const entries = queue.list('thread-1', 'user-2');
      assert.strictEqual(entries.length, 1, 'Should enqueue urgent connector');
      assert.strictEqual(entries[0].priority, 'urgent');
    });

    it('normal priority connector enqueues with priority normal (F175)', async () => {
      trackerMock.setActive('thread-1', 'user-1');
      const trigger = createTrigger();
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Normal msg', 'msg-normal-1');
      await waitForTrigger();

      const entries = queue.list('thread-1', 'user-1');
      assert.strictEqual(entries.length, 1);
      assert.strictEqual(entries[0].priority, 'normal', 'Default priority should be normal');
    });

    it('emits queue_updated after enqueue', async () => {
      trackerMock.setActive('thread-1');
      const trigger = createTrigger();
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Review msg', 'msg-1');
      await waitForTrigger();

      const queueUpdate = socketMock.userEmits.find((e) => e.event === 'queue_updated');
      assert.ok(queueUpdate, 'Should emit queue_updated');
      assert.strictEqual(queueUpdate.userId, 'user-1');
      assert.strictEqual(queueUpdate.data.threadId, 'thread-1');
      assert.strictEqual(queueUpdate.data.action, 'enqueued');
      assert.ok(Array.isArray(queueUpdate.data.queue));
    });

    it('does NOT merge consecutive connector messages (F134: each may be from a different group sender)', async () => {
      trackerMock.setActive('thread-1');
      const trigger = createTrigger();

      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'First review', 'msg-1');
      await waitForTrigger();
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Second review', 'msg-2');
      await waitForTrigger();

      const entries = queue.list('thread-1', 'user-1');
      assert.strictEqual(entries.length, 2, 'Connector messages must not merge');
      assert.ok(entries[0].content.includes('First review'));
      assert.ok(entries[1].content.includes('Second review'));
    });

    it('coalesces queued connector messages with the same policy coalesceKey and preserves first content', async () => {
      trackerMock.setActive('thread-1');
      const trigger = createTrigger();
      const policy = {
        priority: 'normal',
        reason: 'github_review_feedback',
        sourceCategory: 'review',
        coalesceKey: 'pr:owner/repo#42:review-feedback',
      };

      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'First review', 'msg-1', undefined, policy);
      await waitForTrigger();
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Second review', 'msg-2', undefined, policy);
      await waitForTrigger();

      const entries = queue.list('thread-1', 'user-1');
      assert.strictEqual(entries.length, 1, 'same PR review feedback should keep one queued invocation');
      assert.strictEqual(entries[0].content, 'First review', 'coalescing keeps first queued content as canonical');
      assert.strictEqual(entries[0].messageId, 'msg-1');
      assert.deepStrictEqual(entries[0].mergedMessageIds, ['msg-2']);
    });

    it('upgrades coalesced review feedback when a later event is urgent', async () => {
      trackerMock.setActive('thread-1');
      const trigger = createTrigger();
      const coalesceKey = 'pr:owner/repo#42:review-feedback';

      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Commented review', 'msg-1', undefined, {
        priority: 'normal',
        reason: 'github_review_feedback',
        sourceCategory: 'review',
        coalesceKey,
      });
      await waitForTrigger();
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Changes requested', 'msg-2', undefined, {
        priority: 'urgent',
        reason: 'github_review_feedback',
        sourceCategory: 'review',
        suggestedSkill: 'receive-review',
        coalesceKey,
      });
      await waitForTrigger();

      const entries = queue.list('thread-1', 'user-1');
      assert.strictEqual(entries.length, 1, 'same PR review feedback should keep one queued invocation');
      assert.strictEqual(entries[0].content, 'Commented review', 'coalescing still keeps first content canonical');
      assert.strictEqual(entries[0].priority, 'urgent', 'later CHANGES_REQUESTED should upgrade queue priority');
      assert.strictEqual(entries[0].suggestedSkill, 'receive-review');
      assert.strictEqual(entries[0].messageId, 'msg-1');
      assert.deepStrictEqual(entries[0].mergedMessageIds, ['msg-2']);
    });

    it('queues follow-up review feedback when the previous coalesced wake-up is already processing', async () => {
      trackerMock.setActive('thread-1');
      const trigger = createTrigger();
      const coalesceKey = 'pr:owner/repo#42:review-feedback';
      const policy = {
        priority: 'normal',
        reason: 'github_review_feedback',
        sourceCategory: 'review',
        suggestedSkill: 'receive-review',
        coalesceKey,
      };

      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'First review', 'msg-1', undefined, policy);
      await waitForTrigger();
      const first = queue.markProcessing('thread-1', 'user-1');
      assert.ok(first, 'first coalesced wake-up should be processing');

      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Second review', 'msg-2', undefined, policy);
      await waitForTrigger();
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Third review', 'msg-3', undefined, policy);
      await waitForTrigger();

      const entries = queue.list('thread-1', 'user-1');
      const processingEntries = entries.filter((entry) => entry.status === 'processing');
      const queuedEntries = entries.filter((entry) => entry.status === 'queued');

      assert.strictEqual(processingEntries.length, 1, 'the in-flight wake-up remains processing');
      assert.strictEqual(queuedEntries.length, 1, 'follow-up feedback gets a fresh queued wake-up');
      assert.strictEqual(queuedEntries[0].content, 'Second review');
      assert.strictEqual(queuedEntries[0].messageId, 'msg-2');
      assert.deepStrictEqual(queuedEntries[0].mergedMessageIds, ['msg-3']);
    });

    it('connector messages bypass MAX_QUEUE_DEPTH (F175)', async () => {
      trackerMock.setActive('thread-1');
      const trigger = createTrigger();

      // Enqueue 7 connector messages — all should succeed (no depth limit for connector)
      for (let i = 0; i < 7; i++) {
        trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', `msg ${i}`, `msg-${i}`);
        await waitForTrigger();
      }

      const fullWarning = socketMock.userEmits.find((e) => e.event === 'queue_full_warning');
      assert.strictEqual(fullWarning, undefined, 'No queue_full_warning for connector source');

      const entries = queue.list('thread-1', 'user-1');
      assert.strictEqual(entries.length, 7, 'All 7 connector messages should be enqueued');
    });

    it('P1 fix: direct execution calls queueProcessor.onInvocationComplete on success', async () => {
      // Codex cloud review P1: connector direct execution doesn't notify QueueProcessor,
      // so queued follow-ups stall forever. This test verifies the fix.
      const qpCalls = /** @type {Array<{threadId: string, catId: string, status: string}>} */ ([]);
      const mockQueueProcessor = /** @type {any} */ ({
        isThreadBusy: () => false,
        isCatBusy: () => false,
        async onInvocationComplete(threadId, catId, status) {
          qpCalls.push({ threadId, catId, status });
        },
      });

      const trigger = createTrigger({ queueProcessor: mockQueueProcessor });
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
      await waitForTrigger();

      // Must have notified QueueProcessor with 'succeeded'
      assert.strictEqual(qpCalls.length, 1, 'Should call onInvocationComplete once');
      assert.strictEqual(qpCalls[0].threadId, 'thread-1');
      assert.strictEqual(qpCalls[0].status, 'succeeded');
    });

    it('F254 D1.2b: connector success reports only cats with done evidence to queueProcessor', async () => {
      const qpCalls =
        /** @type {Array<{threadId: string, catId: string, status: string, completedCatIds?: string[]}>} */ ([]);
      const mockQueueProcessor = /** @type {any} */ ({
        isThreadBusy: () => false,
        isCatBusy: () => false,
        async onInvocationComplete(threadId, catId, status, _invocationId, completedCatIds) {
          qpCalls.push({ threadId, catId, status, completedCatIds });
        },
      });

      routerMock = mockRouter({
        messages: [
          {
            type: 'text',
            catId: 'opus',
            content: 'started but no terminal done event',
            timestamp: Date.now(),
          },
        ],
      });
      const trigger = createTrigger({ router: routerMock.router, queueProcessor: mockQueueProcessor });
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-no-done');
      await waitForTrigger();

      assert.strictEqual(qpCalls.length, 1, 'Should call onInvocationComplete once');
      assert.strictEqual(qpCalls[0].status, 'succeeded');
      assert.deepStrictEqual(
        qpCalls[0].completedCatIds,
        [],
        'connector path must not close queued_handled without a successful done event',
      );
      const succeededUpdate = recordMock.updates.find((update) => update.data.status === 'succeeded');
      assert.ok(succeededUpdate, 'expected durable succeeded update');
      assert.deepStrictEqual(
        succeededUpdate.data.successfulCatIds,
        [],
        'the persistent witness must match the exact empty done-evidence set',
      );
    });

    it('F254 D1.2b: connector error-coded done is not successful handled evidence', async () => {
      const qpCalls =
        /** @type {Array<{threadId: string, catId: string, status: string, completedCatIds?: string[]}>} */ ([]);
      const mockQueueProcessor = /** @type {any} */ ({
        isThreadBusy: () => false,
        isCatBusy: () => false,
        async onInvocationComplete(threadId, catId, status, _invocationId, completedCatIds) {
          qpCalls.push({ threadId, catId, status, completedCatIds });
        },
      });

      routerMock = mockRouter({
        messages: [
          {
            type: 'done',
            catId: 'opus',
            timestamp: Date.now(),
            errorCode: 'connector_failed',
          },
        ],
      });
      const trigger = createTrigger({ router: routerMock.router, queueProcessor: mockQueueProcessor });
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-error-done');
      await waitForTrigger();

      assert.strictEqual(qpCalls.length, 1, 'Should call onInvocationComplete once');
      assert.strictEqual(qpCalls[0].status, 'succeeded');
      assert.deepStrictEqual(
        qpCalls[0].completedCatIds,
        [],
        'connector path must not close queued_handled on error-coded done events',
      );
    });

    it('P1 fix: direct execution calls queueProcessor.onInvocationComplete on failure', async () => {
      const qpCalls = /** @type {Array<{threadId: string, catId: string, status: string}>} */ ([]);
      const mockQueueProcessor = /** @type {any} */ ({
        isThreadBusy: () => false,
        isCatBusy: () => false,
        async onInvocationComplete(threadId, catId, status) {
          qpCalls.push({ threadId, catId, status });
        },
      });

      routerMock = mockRouter({ throwError: new Error('boom') });
      const trigger = createTrigger({ router: routerMock.router, queueProcessor: mockQueueProcessor });
      await assert.rejects(trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1'), /boom/);
      await waitForTrigger();

      assert.strictEqual(qpCalls.length, 1, 'Should call onInvocationComplete once');
      assert.strictEqual(qpCalls[0].threadId, 'thread-1');
      assert.strictEqual(qpCalls[0].status, 'failed');
    });

    it('executes directly when no active invocation', async () => {
      // trackerMock.setActive NOT called → has() returns false
      const trigger = createTrigger();
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Review msg', 'msg-1');
      await waitForTrigger();

      // Should call routeExecution (direct execution)
      assert.strictEqual(routerMock.calls.length, 1);
      // Queue should be empty
      assert.strictEqual(queue.list('thread-1', 'user-1').length, 0);
    });
  });

  describe('F140 Phase C: suggestedSkill through queue path (F175)', () => {
    it('suggestedSkill is preserved on queue entry when urgent enqueues (F175)', async () => {
      trackerMock.setActive('thread-1', 'user-1');
      const trigger = createTrigger();
      const policy = { priority: 'urgent', reason: 'github_ci_failure', suggestedSkill: 'merge-gate' };
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'CI failed', 'msg-skill', undefined, policy);
      await waitForTrigger();

      assert.strictEqual(routerMock.calls.length, 0, 'F175: urgent does not execute directly');
      const entries = queue.list('thread-1', 'user-1');
      assert.strictEqual(entries.length, 1, 'Should enqueue urgent message');
      assert.strictEqual(entries[0].priority, 'urgent');
    });

    it('connector retry with same messageId does not create duplicate queue entry', async () => {
      trackerMock.setActive('thread-1', 'user-1');
      const trigger = createTrigger();
      const policy = { priority: 'urgent', reason: 'webhook_retry' };

      // First trigger — should enqueue
      const r1 = await trigger.trigger(
        'thread-1',
        /** @type {any} */ ('opus'),
        'user-1',
        'CI failed',
        'msg-retry-1',
        undefined,
        policy,
      );
      assert.strictEqual(r1, 'enqueued');
      assert.strictEqual(queue.list('thread-1', 'user-1').length, 1);

      // Second trigger with same messageId — should be deduped
      const r2 = await trigger.trigger(
        'thread-1',
        /** @type {any} */ ('opus'),
        'user-1',
        'CI failed',
        'msg-retry-1',
        undefined,
        policy,
      );
      assert.strictEqual(r2, 'enqueued', 'Duplicate should return enqueued (idempotent)');
      assert.strictEqual(queue.list('thread-1', 'user-1').length, 1, 'Queue should still have exactly 1 entry');

      // Different messageId — should enqueue normally
      const r3 = await trigger.trigger(
        'thread-1',
        /** @type {any} */ ('opus'),
        'user-1',
        'New event',
        'msg-different',
        undefined,
        policy,
      );
      assert.strictEqual(r3, 'enqueued');
      assert.strictEqual(queue.list('thread-1', 'user-1').length, 2, 'Different messageId should enqueue');
    });

    it('suggestedSkill passes through to direct execution when no active invocation', async () => {
      const trigger = createTrigger();
      const policy = { priority: 'urgent', reason: 'github_ci_failure', suggestedSkill: 'merge-gate' };
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'CI failed', 'msg-urgent', undefined, policy);
      await waitForTrigger();

      assert.strictEqual(routerMock.calls.length, 1, 'Should execute directly when idle');
      const intent = routerMock.calls[0].intent;
      assert.ok(intent, 'intent should exist');
      assert.ok(Array.isArray(intent.promptTags), 'promptTags should be an array');
      assert.ok(
        intent.promptTags.includes('skill:merge-gate'),
        `promptTags should include 'skill:merge-gate' but got: ${JSON.stringify(intent.promptTags)}`,
      );
    });

    it('queued path preserves suggestedSkill in QueueEntry (#564 regression)', async () => {
      trackerMock.setActive('thread-1', 'user-1');
      const trigger = createTrigger();
      const policy = { priority: 'urgent', reason: 'github_ci_failure', suggestedSkill: 'receive-review' };
      trigger.trigger(
        'thread-1',
        /** @type {any} */ ('opus'),
        'user-1',
        'Review changes requested',
        'msg-queue-skill',
        undefined,
        policy,
      );
      await waitForTrigger();

      const entries = queue.list('thread-1', 'user-1');
      assert.strictEqual(entries.length, 1, 'Should enqueue');
      assert.strictEqual(
        entries[0].suggestedSkill,
        'receive-review',
        'suggestedSkill must be preserved in queue entry',
      );
    });
  });

  // ── F185: thread-level busy gate (AC-1/AC-2) ──

  describe('F185: thread-level busy gate', () => {
    it('force-reset suppression queues a late connector wake before direct admission', async () => {
      let tryStartCalls = 0;
      trackerMock.tracker.tryStartThread = () => {
        tryStartCalls++;
        return new AbortController();
      };
      const mockQueueProcessor = /** @type {any} */ ({
        isAutoResumeSuppressed: () => true,
        isThreadBusy: () => false,
        isCatBusy: () => false,
        async onInvocationComplete() {},
      });
      const trigger = createTrigger({ queueProcessor: mockQueueProcessor });

      const outcome = await trigger.trigger(
        'thread-1',
        /** @type {any} */ ('opus'),
        'user-1',
        'Managed command completed after reset.',
        'msg-late-managed-command',
        undefined,
        { sourceCategory: 'scheduled' },
      );

      assert.strictEqual(outcome, 'enqueued');
      assert.strictEqual(tryStartCalls, 0, 'suppressed wake must not reach direct tracker admission');
      assert.strictEqual(routerMock.calls.length, 0, 'suppressed wake must not dispatch');
      assert.strictEqual(queue.list('thread-1', 'user-1').length, 1, 'late wake remains recoverable in Queue');
    });

    it('AC-1: enqueues when queueProcessor.isThreadBusy returns true', async () => {
      const mockQueueProcessor = /** @type {any} */ ({
        isThreadBusy: () => true,
        isCatBusy: () => false,
        async onInvocationComplete() {},
      });
      const trigger = createTrigger({ queueProcessor: mockQueueProcessor });
      const outcome = await trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Review msg', 'msg-1');
      await waitForTrigger();

      assert.strictEqual(outcome, 'enqueued', 'should enqueue when thread is busy');
      assert.strictEqual(routerMock.calls.length, 0, 'should NOT dispatch');
      assert.strictEqual(queue.list('thread-1', 'user-1').length, 1);
    });

    it('AC-2: enqueues when tryStartThread returns null (thread busy in tracker)', async () => {
      const mockQueueProcessor = /** @type {any} */ ({
        isThreadBusy: () => false,
        isCatBusy: () => false,
        async onInvocationComplete() {},
      });
      // Mock tryStartThread returning null (thread already has active invocation)
      trackerMock.tracker.tryStartThread = (_threadId, _catId) => null;
      const trigger = createTrigger({ queueProcessor: mockQueueProcessor });
      const outcome = await trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Review msg', 'msg-1');
      await waitForTrigger();

      assert.strictEqual(outcome, 'enqueued', 'should enqueue when tryStartThread fails');
      assert.strictEqual(routerMock.calls.length, 0, 'should NOT dispatch');
    });

    it('AC-2: dispatches when tryStartThread returns controller', async () => {
      const mockQueueProcessor = /** @type {any} */ ({
        isThreadBusy: () => false,
        isCatBusy: () => false,
        async onInvocationComplete() {},
      });
      const acquiredController = new AbortController();
      trackerMock.tracker.tryStartThread = (_threadId, _catId) => acquiredController;
      const trigger = createTrigger({ queueProcessor: mockQueueProcessor });
      const outcome = await trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Review msg', 'msg-1');
      await waitForTrigger();

      assert.strictEqual(outcome, 'dispatched', 'should dispatch when tryStartThread succeeds');
      assert.strictEqual(routerMock.calls.length, 1, 'should call routeExecution');
    });

    it('AC-10: connector + different cat busy in thread → enqueues (thread-level gate)', async () => {
      // Scenario: opus is running, connector targets codex — should still queue (thread-level)
      trackerMock.setActive('thread-1', 'user-1');
      const trigger = createTrigger();
      const outcome = await trigger.trigger(
        'thread-1',
        /** @type {any} */ ('codex'),
        'user-1',
        'CI notification',
        'msg-ci',
      );

      assert.strictEqual(outcome, 'enqueued', 'connector must queue when ANY cat is busy in thread');
      assert.strictEqual(routerMock.calls.length, 0, 'should NOT dispatch concurrently');
    });

    it('AC-3: reuses tryStartThread controller (no separate start() call)', async () => {
      const mockQueueProcessor = /** @type {any} */ ({
        isThreadBusy: () => false,
        isCatBusy: () => false,
        async onInvocationComplete() {},
      });
      const acquiredController = new AbortController();
      trackerMock.tracker.tryStartThread = (_threadId, _catId) => acquiredController;
      const trigger = createTrigger({ queueProcessor: mockQueueProcessor });
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
      await waitForTrigger();

      // start() should NOT have been called (tryStartThread already registered the slot)
      assert.strictEqual(trackerMock.starts.length, 0, 'should NOT call start() when tryStartThread was used');
      // complete() should still be called for cleanup
      assert.strictEqual(trackerMock.completes.length, 1, 'should call complete()');
    });

    it('R2-P1-B: duplicate invocation does not notify queueProcessor with failed status', async () => {
      const onCompleteCalls = /** @type {Array<{threadId: string, catId: string, status: string}>} */ ([]);
      const mockQueueProcessor = /** @type {any} */ ({
        isThreadBusy: () => false,
        isCatBusy: () => false,
        async onInvocationComplete(threadId, catId, status) {
          onCompleteCalls.push({ threadId, catId, status });
        },
      });
      recordMock.setDuplicate();
      const trigger = createTrigger({ queueProcessor: mockQueueProcessor });
      await trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
      await waitForTrigger();

      // Duplicate should NOT cause onInvocationComplete('failed')
      const failedCalls = onCompleteCalls.filter((c) => c.status === 'failed');
      assert.strictEqual(failedCalls.length, 0, 'duplicate must not trigger failed onInvocationComplete');
    });

    it('R2-P1-A: queue full emits system_info via broadcastAgentMessage', async () => {
      const mockFullQueue = /** @type {any} */ ({
        hasEntryWithMessageId: () => false,
        enqueue: () => ({ outcome: 'full' }),
        size: () => 5,
        list: () => [],
        hasQueuedUserMessagesForThread: () => false,
        hasActiveOrQueuedAgentForCat: () => false,
      });
      trackerMock.setActive('thread-1', 'user-1');
      const trigger = createTrigger({ invocationQueue: mockFullQueue });
      const outcome = await trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'overflow', 'mid-full');

      assert.strictEqual(outcome, 'full');
      const systemInfoMsgs = socketMock.broadcasts.filter(
        (b) => b.msg.type === 'system_info' && b.threadId === 'thread-1',
      );
      assert.ok(systemInfoMsgs.length > 0, 'queue full must emit system_info to thread');
      const parsed = JSON.parse(systemInfoMsgs[0].msg.content);
      assert.strictEqual(parsed.reason, 'queue_full', 'system_info reason must be queue_full');
    });
  });
});
