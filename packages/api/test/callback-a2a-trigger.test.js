/**
 * Unit tests for callback-a2a-trigger.ts (F27 rewrite)
 *
 * F27: callback A2A now pushes to parent worklist instead of spawning
 * independent invocations. triggerA2AInvocation is kept as fallback only.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('triggerA2AInvocation (fallback path)', () => {
  test('releases a terminal dynamic A2A child with the callback route controller', async () => {
    const { triggerA2AInvocation } = await import('../dist/routes/callback-a2a-trigger.js');
    const slotCompletions = [];
    let routeController;
    const controller = new AbortController();
    const mockInvocationTracker = {
      has() {
        return false;
      },
      start() {
        return controller;
      },
      startAll() {
        return controller;
      },
      tryStartThreadAll() {
        return controller;
      },
      trackExternalSlot() {
        return true;
      },
      completeSlot(threadId, catId, completedController) {
        slotCompletions.push({ threadId, catId, controller: completedController });
      },
      complete() {},
      completeAll() {},
    };
    const mockRouter = {
      async *routeExecution(_userId, _content, threadId, _messageId, _targetCats, _intent, options) {
        routeController = options.invocationController;
        assert.equal(options.trackA2ASlot(threadId, 'opus', 'user-1', routeController), true);
        yield { type: 'done', catId: 'opus', isFinal: true, timestamp: Date.now() };
      },
    };

    await triggerA2AInvocation(
      {
        router: mockRouter,
        invocationRecordStore: {
          create() {
            return { outcome: 'created', invocationId: 'inv-dynamic-child' };
          },
          update(id, data) {
            return { id, ...data };
          },
        },
        socketManager: {
          broadcastAgentMessage() {},
          broadcastToRoom() {},
        },
        invocationTracker: mockInvocationTracker,
        log: { error() {}, warn() {}, info() {} },
      },
      {
        targetCats: ['codex'],
        content: '@codex route to opus',
        userId: 'user-1',
        threadId: 'thread-callback-child',
        triggerMessage: {
          id: 'msg-callback-child',
          threadId: 'thread-callback-child',
          userId: 'user-1',
          catId: 'codex',
          content: 'test',
          mentions: [],
          timestamp: Date.now(),
        },
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(slotCompletions, [
      { threadId: 'thread-callback-child', catId: 'opus', controller: routeController },
    ]);
  });

  test('marks InvocationRecord as canceled when thread is deleting (P2-1)', async () => {
    const { triggerA2AInvocation } = await import('../dist/routes/callback-a2a-trigger.js');

    const updates = [];
    const mockInvocationRecordStore = {
      create() {
        return { outcome: 'created', invocationId: 'inv-1' };
      },
      update(id, data) {
        updates.push({ id, ...data });
        return { id, ...data };
      },
    };

    // Simulate aborted signal (thread is deleting)
    const abortController = new AbortController();
    abortController.abort();

    const mockInvocationTracker = {
      has() {
        return false;
      },
      start() {
        return abortController;
      },
      startAll() {
        return new AbortController();
      },
      tryStartThreadAll() {
        return new AbortController();
      },
      complete() {},
      completeAll() {},
    };

    const mockRouter = {
      async *routeExecution() {
        throw new Error('should not be called');
      },
    };

    const mockSocketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
    };

    const mockLog = {
      error() {},
      warn() {},
      info() {},
    };

    await triggerA2AInvocation(
      {
        router: mockRouter,
        invocationRecordStore: mockInvocationRecordStore,
        socketManager: mockSocketManager,
        invocationTracker: mockInvocationTracker,
        log: mockLog,
      },
      {
        targetCats: ['codex'],
        content: '@缅因猫\nreview please',
        userId: 'user-1',
        threadId: 't-deleting',
        triggerMessage: {
          id: 'msg-1',
          threadId: 't-deleting',
          userId: 'user-1',
          catId: 'opus',
          content: 'test',
          mentions: [],
          timestamp: Date.now(),
        },
      },
    );

    const cancelUpdate = updates.find((u) => u.status === 'canceled');
    assert.ok(cancelUpdate, 'InvocationRecord must be marked as canceled on deleting race');
    assert.equal(cancelUpdate.id, 'inv-1');
  });

  test('does not trigger invocation for duplicate idempotency key', async () => {
    const { triggerA2AInvocation } = await import('../dist/routes/callback-a2a-trigger.js');

    const updates = [];
    const mockInvocationRecordStore = {
      create() {
        return { outcome: 'duplicate', invocationId: 'inv-existing' };
      },
      update(id, data) {
        updates.push({ id, ...data });
        return { id, ...data };
      },
    };

    const mockRouter = {
      async *routeExecution() {
        throw new Error('should not be called');
      },
    };

    const mockSocketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
    };

    const mockLog = { error() {}, warn() {}, info() {} };

    await triggerA2AInvocation(
      {
        router: mockRouter,
        invocationRecordStore: mockInvocationRecordStore,
        socketManager: mockSocketManager,
        log: mockLog,
      },
      {
        targetCats: ['codex'],
        content: '@缅因猫\nreview',
        userId: 'user-1',
        threadId: 't1',
        triggerMessage: {
          id: 'msg-1',
          threadId: 't1',
          userId: 'user-1',
          catId: 'opus',
          content: 'test',
          mentions: [],
          timestamp: Date.now(),
        },
      },
    );

    assert.equal(updates.length, 0, 'No updates on duplicate');
  });

  test('skips redundant A2A when target cat is already in active parent target set', async () => {
    const { triggerA2AInvocation } = await import('../dist/routes/callback-a2a-trigger.js');

    let createCalled = 0;
    let routeCalled = 0;

    const mockInvocationRecordStore = {
      create() {
        createCalled++;
        return { outcome: 'created', invocationId: 'inv-dup' };
      },
      update() {},
    };

    const mockInvocationTracker = {
      has() {
        return true;
      },
      getActiveSlots() {
        return ['opus', 'codex', 'gemini'];
      },
      start() {
        return new AbortController();
      },
      startAll() {
        return new AbortController();
      },
      tryStartThreadAll() {
        return new AbortController();
      },
      complete() {},
      completeAll() {},
    };

    const mockRouter = {
      async *routeExecution() {
        routeCalled++;
        yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
      },
    };

    const mockSocketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
    };

    const mockLog = { error() {}, warn() {}, info() {} };

    await triggerA2AInvocation(
      {
        router: mockRouter,
        invocationRecordStore: mockInvocationRecordStore,
        socketManager: mockSocketManager,
        invocationTracker: mockInvocationTracker,
        log: mockLog,
      },
      {
        targetCats: ['codex'],
        content: '@缅因猫\nalready covered by parent',
        userId: 'user-1',
        threadId: 'active-thread',
        triggerMessage: {
          id: 'msg-covered',
          threadId: 'active-thread',
          userId: 'user-1',
          catId: 'opus',
          content: 'test',
          mentions: [],
          timestamp: Date.now(),
        },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(createCalled, 0, 'redundant A2A should not create InvocationRecord');
    assert.equal(routeCalled, 0, 'redundant A2A should not execute routeExecution');
  });

  test('broadcasts terminal error + done when routeExecution throws (release loading lock)', async () => {
    const { triggerA2AInvocation } = await import('../dist/routes/callback-a2a-trigger.js');

    const updates = [];
    const roomEvents = [];
    const agentBroadcasts = [];
    const mockInvocationRecordStore = {
      create() {
        return { outcome: 'created', invocationId: 'inv-err' };
      },
      update(id, data) {
        updates.push({ id, ...data });
        return { id, ...data };
      },
    };

    const mockInvocationTracker = {
      has() {
        return false;
      },
      start() {
        return new AbortController();
      },
      startAll() {
        return new AbortController();
      },
      tryStartThreadAll() {
        return new AbortController();
      },
      complete() {},
      completeAll() {},
    };

    const mockRouter = {
      async *routeExecution() {
        throw new Error('route failed before done');
      },
    };

    const mockSocketManager = {
      broadcastAgentMessage(msg, threadId) {
        agentBroadcasts.push({ msg, threadId });
      },
      broadcastToRoom(room, event, payload) {
        roomEvents.push({ room, event, payload });
      },
    };

    const mockLog = { error() {}, warn() {}, info() {} };

    await triggerA2AInvocation(
      {
        router: mockRouter,
        invocationRecordStore: mockInvocationRecordStore,
        socketManager: mockSocketManager,
        invocationTracker: mockInvocationTracker,
        log: mockLog,
      },
      {
        targetCats: ['codex'],
        content: '@缅因猫\nplease review',
        userId: 'user-1',
        threadId: 'thread-err',
        triggerMessage: {
          id: 'msg-err',
          threadId: 'thread-err',
          userId: 'user-1',
          catId: 'opus',
          content: 'test',
          mentions: [],
          timestamp: Date.now(),
        },
      },
    );

    // triggerA2AInvocation is fire-and-forget; wait for background task to flush.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // #768: intent_mode is deferred to first CLI event; routeExecution threw before yielding,
    // so intent_mode must NOT be broadcast.
    assert.equal(
      roomEvents.filter((e) => e.event === 'intent_mode').length,
      0,
      '#768: intent_mode must NOT be broadcast when routeExecution throws before yielding',
    );
    assert.equal(
      agentBroadcasts.some((b) => b.msg.type === 'error'),
      true,
      'should broadcast error on execution failure',
    );
    assert.equal(
      agentBroadcasts.some((b) => b.msg.type === 'done' && b.msg.isFinal === true),
      true,
      'should broadcast terminal done(isFinal) to release loading lock',
    );
    assert.equal(
      updates.some((u) => u.status === 'failed'),
      true,
      'failed status should be persisted',
    );
  });

  test('#768 regression: intent_mode IS broadcast once CLI produces first event (a2a path)', async () => {
    const { triggerA2AInvocation } = await import('../dist/routes/callback-a2a-trigger.js');

    const roomEvents = [];
    const mockInvocationRecordStore = {
      create() {
        return { outcome: 'created', invocationId: 'inv-768-ok' };
      },
      update() {},
    };

    const mockInvocationTracker = {
      has() {
        return false;
      },
      start() {
        return new AbortController();
      },
      startAll() {
        return new AbortController();
      },
      tryStartThreadAll() {
        return new AbortController();
      },
      complete() {},
      completeAll() {},
    };

    const mockRouter = {
      async *routeExecution() {
        yield { type: 'text', catId: 'codex', content: 'hello', timestamp: Date.now() };
        yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
      },
    };

    const mockSocketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom(room, event, payload) {
        roomEvents.push({ room, event, payload });
      },
    };

    const mockLog = { error() {}, warn() {}, info() {} };

    await triggerA2AInvocation(
      {
        router: mockRouter,
        invocationRecordStore: mockInvocationRecordStore,
        socketManager: mockSocketManager,
        invocationTracker: mockInvocationTracker,
        log: mockLog,
      },
      {
        targetCats: ['codex'],
        content: '@缅因猫\nreview',
        userId: 'user-1',
        threadId: 't-768-ok',
        triggerMessage: {
          id: 'msg-768-ok',
          threadId: 't-768-ok',
          userId: 'user-1',
          catId: 'opus',
          content: 'test',
          mentions: [],
          timestamp: Date.now(),
        },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    const intentEvents = roomEvents.filter((e) => e.event === 'intent_mode');
    assert.equal(intentEvents.length, 1, '#768: intent_mode must be broadcast exactly once when CLI yields');
    assert.equal(intentEvents[0].payload.threadId, 't-768-ok');
  });

  test('calls queueProcessor.onInvocationComplete on success', async () => {
    const { triggerA2AInvocation } = await import('../dist/routes/callback-a2a-trigger.js');

    const completions = [];
    const invocationUpdates = [];
    const mockQueueProcessor = {
      async onInvocationComplete(threadId, catId, status) {
        completions.push({ threadId, catId, status });
      },
    };

    const mockInvocationRecordStore = {
      create() {
        return { outcome: 'created', invocationId: 'inv-q1' };
      },
      update(_id, input) {
        invocationUpdates.push(input);
      },
    };

    const mockInvocationTracker = {
      has() {
        return false;
      },
      start() {
        return new AbortController();
      },
      startAll() {
        return new AbortController();
      },
      tryStartThreadAll() {
        return new AbortController();
      },
      complete() {},
      completeAll() {},
    };

    const mockRouter = {
      async *routeExecution() {
        yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
      },
    };

    const mockSocketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
    };

    const mockLog = { error() {}, warn() {}, info() {} };

    await triggerA2AInvocation(
      {
        router: mockRouter,
        invocationRecordStore: mockInvocationRecordStore,
        socketManager: mockSocketManager,
        invocationTracker: mockInvocationTracker,
        queueProcessor: mockQueueProcessor,
        log: mockLog,
      },
      {
        targetCats: ['codex'],
        content: '@缅因猫\nreview',
        userId: 'user-1',
        threadId: 't-queue-ok',
        triggerMessage: {
          id: 'msg-q1',
          threadId: 't-queue-ok',
          userId: 'user-1',
          catId: 'opus',
          content: 'test',
          mentions: [],
          timestamp: Date.now(),
        },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(completions.length, 1, 'onInvocationComplete must be called once');
    assert.equal(completions[0].threadId, 't-queue-ok');
    assert.equal(completions[0].status, 'succeeded');
    const succeededUpdate = invocationUpdates.find((input) => input.status === 'succeeded');
    assert.deepEqual(succeededUpdate.successfulCatIds, ['codex']);
  });

  test('calls queueProcessor.onInvocationComplete with failed on error', async () => {
    const { triggerA2AInvocation } = await import('../dist/routes/callback-a2a-trigger.js');

    const completions = [];
    const mockQueueProcessor = {
      async onInvocationComplete(threadId, catId, status) {
        completions.push({ threadId, catId, status });
      },
    };

    const mockInvocationRecordStore = {
      create() {
        return { outcome: 'created', invocationId: 'inv-q2' };
      },
      update() {},
    };

    const mockInvocationTracker = {
      has() {
        return false;
      },
      start() {
        return new AbortController();
      },
      startAll() {
        return new AbortController();
      },
      tryStartThreadAll() {
        return new AbortController();
      },
      complete() {},
      completeAll() {},
    };

    const mockRouter = {
      async *routeExecution() {
        throw new Error('simulated failure');
      },
    };

    const mockSocketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
    };

    const mockLog = { error() {}, warn() {}, info() {} };

    await triggerA2AInvocation(
      {
        router: mockRouter,
        invocationRecordStore: mockInvocationRecordStore,
        socketManager: mockSocketManager,
        invocationTracker: mockInvocationTracker,
        queueProcessor: mockQueueProcessor,
        log: mockLog,
      },
      {
        targetCats: ['codex'],
        content: '@缅因猫\nreview',
        userId: 'user-1',
        threadId: 't-queue-err',
        triggerMessage: {
          id: 'msg-q2',
          threadId: 't-queue-err',
          userId: 'user-1',
          catId: 'opus',
          content: 'test',
          mentions: [],
          timestamp: Date.now(),
        },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(completions.length, 1, 'onInvocationComplete must be called on error');
    assert.equal(completions[0].threadId, 't-queue-err');
    assert.equal(completions[0].status, 'failed');
  });

  test('preserves a standalone A2A terminal child error instead of writing empty success', async () => {
    const { triggerA2AInvocation } = await import('../dist/routes/callback-a2a-trigger.js');

    const updates = [];
    const completions = [];
    const mockInvocationRecordStore = {
      create() {
        return { outcome: 'created', invocationId: 'inv-terminal-error' };
      },
      update(_id, input) {
        updates.push(input);
      },
    };
    const mockInvocationTracker = {
      has() {
        return false;
      },
      start() {
        return new AbortController();
      },
      startAll() {
        return new AbortController();
      },
      tryStartThreadAll() {
        return new AbortController();
      },
      complete() {},
      completeAll() {},
    };

    await triggerA2AInvocation(
      {
        router: {
          async *routeExecution() {
            yield {
              type: 'error',
              catId: 'codex',
              error: 'queued_prompt_exposure_rejected:standalone-message',
              timestamp: Date.now(),
            };
            yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
          },
        },
        invocationRecordStore: mockInvocationRecordStore,
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {} },
        invocationTracker: mockInvocationTracker,
        queueProcessor: {
          async onInvocationComplete(_threadId, _catId, status) {
            completions.push(status);
          },
        },
        log: { error() {}, warn() {}, info() {} },
      },
      {
        targetCats: ['codex'],
        content: '@codex reproduce terminal child error',
        userId: 'user-1',
        threadId: 'thread-terminal-error',
        triggerMessage: {
          id: 'message-terminal-error',
          threadId: 'thread-terminal-error',
          userId: 'user-1',
          catId: 'opus',
          content: 'handoff',
          mentions: ['codex'],
          timestamp: Date.now(),
        },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(
      updates.some((update) => update.status === 'succeeded'),
      false,
    );
    const failed = updates.find((update) => update.status === 'failed');
    assert.equal(failed.error, 'queued_prompt_exposure_rejected:standalone-message');
    assert.deepEqual(completions, ['failed']);
  });

  test('calls queueProcessor.onInvocationComplete with canceled on abort', async () => {
    const { triggerA2AInvocation } = await import('../dist/routes/callback-a2a-trigger.js');

    const completions = [];
    const mockQueueProcessor = {
      async onInvocationComplete(threadId, catId, status) {
        completions.push({ threadId, catId, status });
      },
    };

    const mockInvocationRecordStore = {
      create() {
        return { outcome: 'created', invocationId: 'inv-q3' };
      },
      update() {},
    };

    const abortController = new AbortController();
    const mockInvocationTracker = {
      has() {
        return false;
      },
      start() {
        // Simulate abort mid-execution (e.g., force-send canceled this invocation)
        setTimeout(() => abortController.abort(), 5);
        return abortController;
      },
      startAll() {
        return new AbortController();
      },
      tryStartThreadAll() {
        return new AbortController();
      },
      complete() {},
      completeAll() {},
    };

    const mockRouter = {
      async *routeExecution(_userId, _content, _threadId, _messageId, _targetCats, _intent, opts) {
        // Simulate some work before abort hits
        await new Promise((resolve) => setTimeout(resolve, 15));
        if (opts?.signal?.aborted) return;
        yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
      },
    };

    const mockSocketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
    };

    const mockLog = { error() {}, warn() {}, info() {} };

    await triggerA2AInvocation(
      {
        router: mockRouter,
        invocationRecordStore: mockInvocationRecordStore,
        socketManager: mockSocketManager,
        invocationTracker: mockInvocationTracker,
        queueProcessor: mockQueueProcessor,
        log: mockLog,
      },
      {
        targetCats: ['codex'],
        content: '@缅因猫\nreview',
        userId: 'user-1',
        threadId: 't-queue-cancel',
        triggerMessage: {
          id: 'msg-q3',
          threadId: 't-queue-cancel',
          userId: 'user-1',
          catId: 'opus',
          content: 'test',
          mentions: [],
          timestamp: Date.now(),
        },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(completions.length, 1, 'onInvocationComplete must be called on abort');
    assert.equal(completions[0].threadId, 't-queue-cancel');
    assert.equal(completions[0].status, 'canceled');
  });

  test('F222 P1: A2A direct routeExecution passes frustrationAutoIssueEligible=false', async () => {
    const { triggerA2AInvocation } = await import('../dist/routes/callback-a2a-trigger.js');

    let capturedOpts;
    const mockRouterCapture = {
      async *routeExecution(_userId, _content, _threadId, _messageId, _targetCats, _intent, opts) {
        capturedOpts = opts;
        yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
      },
    };

    const mockInvocationRecordStore = {
      create() {
        return { outcome: 'created', invocationId: 'inv-f222' };
      },
      update() {},
    };
    const mockInvocationTracker = {
      has() {
        return false;
      },
      start() {
        return new AbortController();
      },
      startAll() {
        return new AbortController();
      },
      tryStartThreadAll() {
        return new AbortController();
      },
      complete() {},
      completeAll() {},
    };
    const mockQueueProcessor = { async onInvocationComplete() {} };
    const mockSocketManager = { broadcastAgentMessage() {}, broadcastToRoom() {} };
    const mockLog = { error() {}, warn() {}, info() {} };

    await triggerA2AInvocation(
      {
        router: mockRouterCapture,
        invocationRecordStore: mockInvocationRecordStore,
        socketManager: mockSocketManager,
        invocationTracker: mockInvocationTracker,
        queueProcessor: mockQueueProcessor,
        log: mockLog,
      },
      {
        targetCats: ['codex'],
        content: '@缅因猫\nreview',
        userId: 'user-1',
        threadId: 't-f222-provenance',
        triggerMessage: {
          id: 'msg-f222',
          threadId: 't-f222-provenance',
          userId: 'user-1',
          catId: 'opus',
          content: 'test',
          mentions: [],
          timestamp: Date.now(),
        },
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 80));

    assert.equal(
      capturedOpts?.frustrationAutoIssueEligible,
      false,
      'A2A direct execution must suppress frustration detection',
    );
    assert.equal(capturedOpts?.humanDispositionInvocationOrigin, 'a2a');
  });
});

describe('enqueueA2ATargets (F27 primary path)', () => {
  test('enqueues targets to parent worklist when worklist exists', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { registerWorklist, unregisterWorklist } = await import(
      '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );

    const worklist = ['opus'];
    registerWorklist('t-enqueue', worklist, 15);

    const mockLog = { error() {}, warn() {}, info() {} };

    try {
      const result = await enqueueA2ATargets(
        {
          router: {},
          invocationRecordStore: {},
          socketManager: {},
          log: mockLog,
        },
        {
          targetCats: ['codex'],
          content: '@缅因猫\nreview please',
          userId: 'user-1',
          threadId: 't-enqueue',
          triggerMessage: {
            id: 'msg-1',
            threadId: 't-enqueue',
            userId: 'user-1',
            catId: 'opus',
            content: 'test',
            mentions: [],
            timestamp: Date.now(),
          },
        },
      );

      assert.equal(result.fallback, false, 'Should use worklist path, not fallback');
      assert.deepEqual(result.enqueued, ['codex'], 'codex should be enqueued');
      assert.deepEqual(worklist, ['opus', 'codex'], 'worklist should grow');
    } finally {
      unregisterWorklist('t-enqueue');
    }
  });

  test('deduplicates targets already in worklist', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { registerWorklist, unregisterWorklist } = await import(
      '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );

    const worklist = ['opus', 'codex'];
    registerWorklist('t-dedup', worklist, 15);

    const mockLog = { error() {}, warn() {}, info() {} };

    try {
      const result = await enqueueA2ATargets(
        {
          router: {},
          invocationRecordStore: {},
          socketManager: {},
          log: mockLog,
        },
        {
          targetCats: ['codex'],
          content: '@缅因猫\nagain',
          userId: 'user-1',
          threadId: 't-dedup',
          triggerMessage: {
            id: 'msg-2',
            threadId: 't-dedup',
            userId: 'user-1',
            catId: 'opus',
            content: 'test',
            mentions: [],
            timestamp: Date.now(),
          },
        },
      );

      assert.equal(result.fallback, false);
      assert.deepEqual(result.enqueued, [], 'codex already in worklist, nothing enqueued');
      assert.deepEqual(worklist, ['opus', 'codex'], 'worklist unchanged');
    } finally {
      unregisterWorklist('t-dedup');
    }
  });

  test('respects max depth limit', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { registerWorklist, unregisterWorklist, getWorklist } = await import(
      '../dist/domains/cats/services/agents/routing/WorklistRegistry.js'
    );

    const worklist = ['opus'];
    registerWorklist('t-depth', worklist, 1); // maxDepth=1

    const mockLog = { error() {}, warn() {}, info() {} };

    try {
      // Push one — should work (a2aCount 0 → 1)
      const r1 = await enqueueA2ATargets(
        { router: {}, invocationRecordStore: {}, socketManager: {}, log: mockLog },
        {
          targetCats: ['codex'],
          content: '@缅因猫',
          userId: 'u1',
          threadId: 't-depth',
          triggerMessage: {
            id: 'm1',
            threadId: 't-depth',
            userId: 'u1',
            catId: 'opus',
            content: 'test',
            mentions: [],
            timestamp: Date.now(),
          },
        },
      );
      assert.deepEqual(r1.enqueued, ['codex']);

      // Push another — should fail (a2aCount=1 >= maxDepth=1)
      const r2 = await enqueueA2ATargets(
        { router: {}, invocationRecordStore: {}, socketManager: {}, log: mockLog },
        {
          targetCats: ['gemini'],
          content: '@暹罗猫',
          userId: 'u1',
          threadId: 't-depth',
          triggerMessage: {
            id: 'm2',
            threadId: 't-depth',
            userId: 'u1',
            catId: 'opus',
            content: 'test',
            mentions: [],
            timestamp: Date.now(),
          },
        },
      );
      assert.deepEqual(r2.enqueued, [], 'depth limit reached');
      assert.equal(getWorklist('t-depth').a2aCount, 1);
    } finally {
      unregisterWorklist('t-depth');
    }
  });

  test('R1 P1-2: slot-aware fallback allows non-conflicting cross-slot invocation', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');

    let startCalled = 0;
    let createCalled = 0;
    const mockInvocationTracker = {
      has() {
        return true;
      }, // Parent is active
      getActiveSlots() {
        return ['opus'];
      }, // Only opus is active — codex is non-conflicting
      start() {
        startCalled++;
        return new AbortController();
      },
      startAll() {
        return new AbortController();
      },
      tryStartThreadAll() {
        return new AbortController();
      },
      complete() {},
      completeAll() {},
    };

    const mockInvocationRecordStore = {
      create() {
        createCalled++;
        return { outcome: 'created', invocationId: 'inv-x' };
      },
      update() {},
    };

    const mockRouter = {
      async *routeExecution() {
        yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
      },
    };

    const mockSocketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
    };

    const mockLog = { error() {}, warn() {}, info() {} };

    const result = await enqueueA2ATargets(
      {
        router: mockRouter,
        invocationRecordStore: mockInvocationRecordStore,
        socketManager: mockSocketManager,
        invocationTracker: mockInvocationTracker,
        log: mockLog,
      },
      {
        targetCats: ['codex'],
        content: '@缅因猫\nreview',
        userId: 'user-1',
        threadId: 'active-parent-thread',
        triggerMessage: {
          id: 'msg-p2',
          threadId: 'active-parent-thread',
          userId: 'user-1',
          catId: 'opus',
          content: 'test',
          mentions: [],
          timestamp: Date.now(),
        },
      },
    );

    // Wait for fire-and-forget background execution
    await new Promise((resolve) => setTimeout(resolve, 20));

    // F108 slot-aware: codex is non-conflicting with opus, safe to start
    assert.equal(startCalled, 1, 'tracker.start() should be called for non-conflicting slot');
    assert.equal(createCalled, 1, 'invocationRecord should be created for non-conflicting target');
    assert.equal(result.fallback, true, 'should indicate fallback path was used');
    assert.deepEqual(result.enqueued, ['codex'], 'non-conflicting target should be enqueued');
  });

  test('R1 P1-2: slot-aware fallback skips when all targets already active', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');

    let startCalled = 0;
    const mockInvocationTracker = {
      has() {
        return true;
      },
      getActiveSlots() {
        return ['opus', 'codex'];
      }, // codex already active
      start() {
        startCalled++;
        return new AbortController();
      },
      startAll() {
        return new AbortController();
      },
      tryStartThreadAll() {
        return new AbortController();
      },
      complete() {},
      completeAll() {},
    };

    const mockInvocationRecordStore = {
      create() {
        return { outcome: 'created', invocationId: 'inv-skip' };
      },
      update() {},
    };

    const mockRouter = {
      async *routeExecution() {
        throw new Error('must not be called');
      },
    };

    const mockSocketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
    };

    const mockLog = { error() {}, warn() {}, info() {} };

    const result = await enqueueA2ATargets(
      {
        router: mockRouter,
        invocationRecordStore: mockInvocationRecordStore,
        socketManager: mockSocketManager,
        invocationTracker: mockInvocationTracker,
        log: mockLog,
      },
      {
        targetCats: ['codex'],
        content: '@缅因猫\nreview',
        userId: 'user-1',
        threadId: 'all-active-thread',
        triggerMessage: {
          id: 'msg-allactive',
          threadId: 'all-active-thread',
          userId: 'user-1',
          catId: 'opus',
          content: 'test',
          mentions: [],
          timestamp: Date.now(),
        },
      },
    );

    assert.equal(startCalled, 0, 'tracker.start() must NOT be called when target already active');
    assert.equal(result.fallback, true, 'should indicate fallback path was attempted');
    assert.deepEqual(result.enqueued, [], 'nothing enqueued when all targets already active');
  });

  test('F122 AC-A3: not_found reason falls back to standalone invocation', async () => {
    // Race condition: hasWorklist returns true, but worklist is unregistered
    // between has() and push(). pushToWorklist returns { added: [], reason: 'not_found' }.
    // enqueueA2ATargets must fall through to standalone invocation.
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const {
      registerWorklist,
      unregisterWorklist,
      hasWorklist: hasWL,
    } = await import('../dist/domains/cats/services/agents/routing/WorklistRegistry.js');

    // Register then immediately unregister to set up the race
    // We need hasWorklist to return true but pushToWorklist to return not_found.
    // Since the module-level functions share state, we can't do this with the real registry.
    // Instead, test that when no worklist exists at all (hasWorklist=false),
    // fallback path triggers — and separately test the new not_found branch via
    // a targeted code path where we register + unregister between calls.
    // Actually the simplest way: the not_found branch now falls through to the same
    // fallback code. So if we register a worklist with parentInvocationId 'inv-X',
    // then call enqueueA2ATargets with parentInvocationId 'inv-Y' (wrong key),
    // hasWorklist(threadId) returns true (thread index), but pushToWorklist
    // with 'inv-Y' returns not_found (specific key doesn't exist).
    const threadId = 't-notfound-race';
    const worklist = ['opus'];
    const entry = registerWorklist(threadId, worklist, 10, 'inv-existing');
    assert.equal(hasWL(threadId), true, 'setup: thread has worklist via inv-existing');

    let routeCalled = 0;
    const mockInvocationRecordStore = {
      create() {
        return { outcome: 'created', invocationId: 'inv-fb-nf' };
      },
      update() {},
    };

    const mockInvocationTracker = {
      has() {
        return false;
      },
      start() {
        return new AbortController();
      },
      startAll() {
        return new AbortController();
      },
      tryStartThreadAll() {
        return new AbortController();
      },
      complete() {},
      completeAll() {},
    };

    let routeOptions;
    const mockRouter = {
      async *routeExecution(_userId, _content, _threadId, _messageId, _targetCats, _intent, opts) {
        routeCalled++;
        routeOptions = opts;
        yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
      },
    };

    const mockSocketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
    };

    const mockLog = { error() {}, warn() {}, info() {} };

    try {
      const result = await enqueueA2ATargets(
        {
          router: mockRouter,
          invocationRecordStore: mockInvocationRecordStore,
          socketManager: mockSocketManager,
          invocationTracker: mockInvocationTracker,
          log: mockLog,
        },
        {
          targetCats: ['codex'],
          content: '@缅因猫\nreview',
          userId: 'user-1',
          threadId,
          triggerMessage: {
            id: 'msg-nf',
            threadId,
            userId: 'user-1',
            catId: 'opus',
            content: 'test',
            mentions: [],
            timestamp: Date.now(),
          },
          // Wrong parentInvocationId — will cause not_found from pushToWorklist
          parentInvocationId: 'inv-nonexistent',
        },
      );

      await new Promise((resolve) => setTimeout(resolve, 20));

      assert.equal(result.fallback, true, 'not_found must trigger fallback path');
      assert.equal(routeCalled, 1, 'standalone invocation must be triggered on not_found');
      assert.deepEqual(routeOptions.turnCustodyWakeForCat('codex'), {
        kind: 'structured',
        protocol: 'dispatch',
        subjectKey: `ball:thread:${threadId}`,
        holderCatId: 'codex',
        handoff: {
          sourceEventId: 'route:msg-nf:codex',
          messageId: 'msg-nf',
          fromCatId: 'opus',
        },
      });
    } finally {
      unregisterWorklist(threadId, entry, 'inv-existing');
    }
  });

  test('falls back to standalone invocation when no worklist exists', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');

    const updates = [];
    const mockInvocationRecordStore = {
      create() {
        return { outcome: 'created', invocationId: 'inv-fb' };
      },
      update(id, data) {
        updates.push({ id, ...data });
      },
    };

    const mockInvocationTracker = {
      has() {
        return false;
      },
      start() {
        return new AbortController();
      },
      startAll() {
        return new AbortController();
      },
      tryStartThreadAll() {
        return new AbortController();
      },
      complete() {},
      completeAll() {},
    };

    let routeCalled = 0;
    let routeOptions;
    const mockRouter = {
      async *routeExecution(_userId, _content, _threadId, _messageId, _targetCats, _intent, opts) {
        routeCalled++;
        routeOptions = opts;
        yield { type: 'done', catId: 'codex', isFinal: true, timestamp: Date.now() };
      },
    };

    const mockSocketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
    };

    const mockLog = { error() {}, warn() {}, info() {} };

    const result = await enqueueA2ATargets(
      {
        router: mockRouter,
        invocationRecordStore: mockInvocationRecordStore,
        socketManager: mockSocketManager,
        invocationTracker: mockInvocationTracker,
        log: mockLog,
      },
      {
        targetCats: ['codex', 'codex-terra'],
        content: '@缅因猫\nreview',
        userId: 'user-1',
        threadId: 'no-worklist-thread',
        triggerMessage: {
          id: 'msg-fb',
          threadId: 'no-worklist-thread',
          userId: 'user-1',
          catId: 'opus',
          content: 'test',
          mentions: [],
          timestamp: Date.now(),
        },
      },
    );

    // Wait for fire-and-forget background task
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(result.fallback, true, 'should use fallback when no worklist');
    assert.equal(routeCalled, 1, 'routeExecution called in fallback path');
    assert.deepEqual(
      ['codex', 'codex-terra'].map((catId) => routeOptions.turnCustodyWakeForCat(catId)),
      ['codex', 'codex-terra'].map((catId) => ({
        kind: 'structured',
        protocol: 'dispatch',
        subjectKey: 'ball:thread:no-worklist-thread',
        holderCatId: catId,
        handoff: {
          sourceEventId: `route:msg-fb:${catId}`,
          messageId: 'msg-fb',
          fromCatId: 'opus',
        },
      })),
    );
  });
});

// ── F122B: A2A enqueue to InvocationQueue ──
describe('enqueueA2ATargets F122B (InvocationQueue path)', () => {
  test('persists exact ball.handed before accepted single-recipient A2A work can auto-execute', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');

    const order = [];
    const custodyEvents = [];
    const mockInvocationQueue = {
      enqueue(input) {
        return {
          outcome: 'enqueued',
          entry: { id: `q-${input.targetCats[0]}`, ...input, status: 'queued', createdAt: Date.now() },
        };
      },
      countAgentEntriesForThread() {
        return 0;
      },
      findInFlightAgentEntry() {
        return null;
      },
      backfillMessageId() {},
      list() {
        return [];
      },
    };

    const result = await enqueueA2ATargets(
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        queueProcessor: {
          onInvocationComplete() {},
          async tryAutoExecute() {
            order.push('auto-execute');
            assert.equal(custodyEvents.length, 1, 'the accepted handoff must be durable before execution starts');
          },
        },
        invocationQueue: mockInvocationQueue,
        ballCustody: {
          async record(event) {
            order.push(`handoff:${event.payload.toCatId}`);
            custodyEvents.push(event);
          },
        },
        log: { info() {}, warn() {}, error() {} },
      },
      {
        targetCats: ['opus'],
        content: 'A2A handoff message',
        userId: 'system',
        threadId: 'thread-a2a',
        triggerMessage: {
          id: 'msg-trigger',
          mentions: ['opus'],
          content: 'test',
          catId: 'gemini',
        },
        callerCatId: 'gemini',
      },
    );

    assert.deepEqual(result.enqueued, ['opus']);
    assert.deepEqual(order, ['handoff:opus', 'auto-execute']);
    assert.deepEqual(
      custodyEvents.map((event) => ({
        sourceEventId: event.sourceEventId,
        subjectKey: event.subjectKey,
        kind: event.kind,
        payload: event.payload,
      })),
      [
        {
          sourceEventId: 'route:msg-trigger:opus',
          subjectKey: 'ball:thread:thread-a2a',
          kind: 'ball.handed',
          payload: { toCatId: 'opus', fromCatId: 'gemini' },
        },
      ],
    );
  });

  test('keeps an accepted single-recipient queue path off fail-open broadcast when custody shadow write rejects', async () => {
    const [{ enqueueA2ATargets }, { MessageDeliveryService }] = await Promise.all([
      import('../dist/routes/callback-a2a-trigger.js'),
      import('../dist/domains/cats/services/agents/invocation/MessageDeliveryService.js'),
    ]);

    const queueEntries = [];
    const autoExecuteCalls = [];
    const markDeliveredCalls = [];
    const warnCalls = [];
    const errorCalls = [];
    const log = {
      info() {},
      warn(context, message) {
        warnCalls.push({ context, message });
      },
      error(context, message) {
        errorCalls.push({ context, message });
      },
    };
    const deps = {
      router: { async *routeExecution() {} },
      invocationRecordStore: { create() {}, update() {} },
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      queueProcessor: {
        onInvocationComplete() {},
        async tryAutoExecute(threadId) {
          autoExecuteCalls.push(threadId);
        },
      },
      invocationQueue: {
        enqueue(input) {
          const entry = {
            id: `q-${input.targetCats[0]}`,
            ...input,
            status: 'queued',
            createdAt: Date.now(),
          };
          queueEntries.push(entry);
          return { outcome: 'enqueued', entry };
        },
        countAgentEntriesForThread() {
          return 0;
        },
        findInFlightAgentEntry() {
          return null;
        },
        backfillMessageId() {},
        list() {
          return queueEntries;
        },
      },
      ballCustody: {
        async record() {
          throw new Error('shadow Redis append unavailable');
        },
      },
      log,
    };

    const result = await MessageDeliveryService.resolveCallbackDeliveryDecision({
      canEnqueueA2A: true,
      willEnqueueToQueue: true,
      messageId: 'stored-message',
      threadId: 'thread-shadow-failure',
      log,
      enqueueA2A: () =>
        enqueueA2ATargets(deps, {
          targetCats: ['opus'],
          content: 'A2A handoff message',
          userId: 'system',
          threadId: 'thread-shadow-failure',
          triggerMessage: {
            id: 'msg-shadow-failure',
            mentions: ['opus'],
            content: 'test',
            catId: 'gemini',
          },
          callerCatId: 'gemini',
        }),
      markDelivered: async (messageId) => {
        markDeliveredCalls.push(messageId);
        return null;
      },
      zeroEnqueuedWarnMessage: 'zero targets',
      enqueueFailureMessage: 'enqueue failed',
    });

    assert.equal(result.shouldBroadcastNow, false, 'accepted queue work must not fail open to parent broadcast');
    assert.equal(result.enqueueFailed, false);
    assert.deepEqual(result.enqueued, ['opus']);
    assert.equal(queueEntries.length, 1, 'the child must be accepted exactly once');
    assert.deepEqual(autoExecuteCalls, ['thread-shadow-failure']);
    assert.equal(markDeliveredCalls.length, 0, 'queued parent message must remain queued');
    assert.equal(warnCalls.length, 1, 'the shadow write gap must remain observable');
    assert.equal(errorCalls.length, 0, 'the accepted queue path must not be reported as enqueue failure');
  });

  test('enqueues to InvocationQueue with agent source when invocationQueue dep is provided', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');

    const enqueueCalls = [];
    const emitCalls = [];
    const mockInvocationQueue = {
      enqueue(input) {
        enqueueCalls.push(input);
        return { outcome: 'enqueued', entry: { id: 'q-1', ...input, status: 'queued', createdAt: Date.now() } };
      },
      countAgentEntriesForThread() {
        return 0;
      },
      hasQueuedAgentForCat() {
        return false;
      },
      backfillMessageId() {},
      list() {
        return [{ id: 'q-1', status: 'queued' }];
      },
    };
    const tryAutoExecuteCalls = [];
    const mockQueueProcessor = {
      onInvocationComplete() {},
      tryAutoExecute(threadId) {
        tryAutoExecuteCalls.push(threadId);
        return Promise.resolve();
      },
    };
    const socketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
      emitToUser(userId, event, data) {
        emitCalls.push({ userId, event, data });
      },
    };

    const result = await enqueueA2ATargets(
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager,
        invocationTracker: {
          has() {
            return false;
          },
          start() {
            return new AbortController();
          },
          startAll() {
            return new AbortController();
          },
          tryStartThreadAll() {
            return new AbortController();
          },
          complete() {},
          completeAll() {},
        },
        queueProcessor: mockQueueProcessor,
        invocationQueue: mockInvocationQueue,
        log: { info() {}, warn() {}, error() {} },
      },
      {
        targetCats: ['opus'],
        content: 'A2A handoff message',
        userId: 'system',
        ownerAuthProvenance: 'strict',
        threadId: 't1',
        triggerMessage: { id: 'msg-trigger', mentions: ['opus'], content: 'test' },
        callerCatId: 'codex',
        parentInvocationId: 'inv-parent',
      },
    );

    assert.equal(enqueueCalls.length, 1, 'should enqueue to InvocationQueue');
    assert.equal(enqueueCalls[0].source, 'agent');
    assert.equal(enqueueCalls[0].autoExecute, true);
    assert.equal(enqueueCalls[0].callerCatId, 'codex');
    assert.equal(enqueueCalls[0].ownerAuthProvenance, 'strict');
    assert.equal(enqueueCalls[0].a2aTriggerMessageId, 'msg-trigger');
    assert.equal(enqueueCalls[0].targetCats[0], 'opus');
    assert.equal(tryAutoExecuteCalls.length, 1, 'should trigger tryAutoExecute');
    const queueUpdated = emitCalls.find((c) => c.event === 'queue_updated');
    assert.ok(queueUpdated, 'should emit queue_updated after enqueue');
    assert.equal(queueUpdated.userId, 'system');
    assert.equal(queueUpdated.data.action, 'enqueued');
    assert.equal(queueUpdated.data.threadId, 't1');
    assert.deepEqual(result.enqueued, ['opus']);
    assert.equal(result.fallback, false);
  });

  test('respects A2A depth limit — rejects when depth exceeded', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');

    const enqueueCalls = [];
    const mockInvocationQueue = {
      enqueue(input) {
        enqueueCalls.push(input);
        return { outcome: 'enqueued', entry: { id: 'q-1', ...input } };
      },
      // F122B: agent entry count for depth tracking
      countAgentEntriesForThread(threadId) {
        return 10; // At depth limit
      },
      list() {
        return [];
      },
    };
    const result = await enqueueA2ATargets(
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        invocationTracker: {
          has() {
            return false;
          },
          start() {
            return new AbortController();
          },
          startAll() {
            return new AbortController();
          },
          tryStartThreadAll() {
            return new AbortController();
          },
          complete() {},
          completeAll() {},
        },
        queueProcessor: {
          onInvocationComplete() {},
          tryAutoExecute() {
            return Promise.resolve();
          },
        },
        invocationQueue: mockInvocationQueue,
        log: { info() {}, warn() {}, error() {} },
      },
      {
        targetCats: ['opus'],
        content: 'deep A2A',
        userId: 'system',
        threadId: 't1',
        triggerMessage: { id: 'msg-deep', mentions: ['opus'], content: 'test' },
        callerCatId: 'codex',
      },
    );

    assert.equal(enqueueCalls.length, 0, 'should NOT enqueue when depth limit reached');
    assert.deepEqual(result.enqueued, []);
  });

  test('F-coalesce: merges into a queued agent entry instead of dispatching a duplicate', async () => {
    // Contract change (F-coalesce): a repeated same-turn handoff to a cat that already has a QUEUED
    // agent entry is now MERGED into that entry (caller intent preserved) rather than skip-dropped
    // (old behaviour lost the follow-up). A new (non-duplicate) cat still enqueues normally.
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');

    const enqueueCalls = [];
    const findCalls = [];
    const coalesceCalls = [];
    const custodyEvents = [];
    const mockInvocationQueue = {
      enqueue(input) {
        enqueueCalls.push(input);
        return { outcome: 'enqueued', entry: { id: 'q-1', ...input } };
      },
      countAgentEntriesForThread() {
        return 0;
      },
      // opus already has a queued agent entry → returned as in-flight for coalescing
      findInFlightAgentEntry(_threadId, catId, callerCatId, parentInvocationId, ownerAuthProvenance) {
        findCalls.push({ callerCatId, parentInvocationId, ownerAuthProvenance });
        return catId === 'opus'
          ? { id: 'q-existing', userId: 'system', status: 'queued', source: 'agent', targetCats: ['opus'] }
          : null;
      },
      coalesceContentIntoQueuedAgent(
        _threadId,
        _userId,
        entryId,
        content,
        messageId,
        callerCatId,
        parentInvocationId,
        ownerAuthProvenance,
      ) {
        coalesceCalls.push({
          entryId,
          content,
          messageId,
          callerCatId,
          parentInvocationId,
          ownerAuthProvenance,
        });
        return true;
      },
      backfillMessageId() {},
      list() {
        return [];
      },
    };
    const result = await enqueueA2ATargets(
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        invocationTracker: {
          has() {
            return false;
          },
          start() {
            return new AbortController();
          },
          startAll() {
            return new AbortController();
          },
          tryStartThreadAll() {
            return new AbortController();
          },
          complete() {},
          completeAll() {},
        },
        queueProcessor: {
          onInvocationComplete() {},
          tryAutoExecute() {
            return Promise.resolve();
          },
        },
        invocationQueue: mockInvocationQueue,
        ballCustody: {
          async record(event) {
            custodyEvents.push(event);
          },
        },
        log: { info() {}, warn() {}, error() {} },
      },
      {
        targetCats: ['opus'],
        content: 'A2A handoff',
        userId: 'system',
        ownerAuthProvenance: 'strict',
        threadId: 't1',
        triggerMessage: { id: 'msg-dup', mentions: ['opus'], content: 'test' },
        callerCatId: 'gemini',
        parentInvocationId: 'parent-strict',
      },
    );

    // opus → coalesced into its queued entry (no new enqueue), but the accepted route still
    // advances the thread ball before that queued entry can execute.
    assert.equal(coalesceCalls.length, 1, 'opus handoff should be coalesced into the queued entry');
    assert.equal(coalesceCalls[0].entryId, 'q-existing');
    assert.deepEqual(findCalls, [
      { callerCatId: 'gemini', parentInvocationId: 'parent-strict', ownerAuthProvenance: 'strict' },
    ]);
    assert.equal(coalesceCalls[0].ownerAuthProvenance, 'strict');
    assert.equal(enqueueCalls.length, 0, 'coalescing must not create a duplicate entry');
    assert.deepEqual(
      custodyEvents.map((event) => event.payload.toCatId),
      ['opus'],
    );
    assert.deepEqual(result.enqueued, [], 'coalescing is not a new route');
    assert.deepEqual(result.coalesced, ['opus'], 'the merged cat is reported as coalesced, not routed');
  });

  test('depth limit enforced per-target — multi-target stops at limit (cloud P1)', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');

    let depth = 9; // one slot left
    const enqueueCalls = [];
    const mockInvocationQueue = {
      enqueue(input) {
        enqueueCalls.push(input);
        depth++; // simulate entry being added
        return { outcome: 'enqueued', entry: { id: `q-${depth}`, ...input } };
      },
      countAgentEntriesForThread() {
        return depth;
      },
      hasQueuedAgentForCat() {
        return false;
      },
      backfillMessageId() {},
      list() {
        return [];
      },
    };
    const result = await enqueueA2ATargets(
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        invocationTracker: {
          has() {
            return false;
          },
          start() {
            return new AbortController();
          },
          startAll() {
            return new AbortController();
          },
          tryStartThreadAll() {
            return new AbortController();
          },
          complete() {},
          completeAll() {},
        },
        queueProcessor: {
          onInvocationComplete() {},
          tryAutoExecute() {
            return Promise.resolve();
          },
        },
        invocationQueue: mockInvocationQueue,
        log: { info() {}, warn() {}, error() {} },
      },
      {
        targetCats: ['opus', 'codex'],
        content: 'multi-target near limit',
        userId: 'system',
        threadId: 't1',
        triggerMessage: { id: 'msg-overflow', mentions: ['opus', 'codex'], content: 'test' },
        callerCatId: 'gemini',
      },
    );

    // depth starts at 9, first enqueue (opus) brings it to 10, second (codex) should be rejected
    assert.equal(enqueueCalls.length, 1, 'should enqueue only first target before hitting limit');
    assert.equal(enqueueCalls[0].targetCats[0], 'opus');
    assert.deepEqual(result.enqueued, ['opus']);
  });

  test('backfills triggerMessage.id onto queue entry after enqueue (AC-B6-P1)', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');

    const backfillCalls = [];
    const mockInvocationQueue = {
      enqueue(input) {
        return { outcome: 'enqueued', entry: { id: 'q-1', ...input, status: 'queued', createdAt: Date.now() } };
      },
      countAgentEntriesForThread() {
        return 0;
      },
      hasQueuedAgentForCat() {
        return false;
      },
      backfillMessageId(threadId, userId, entryId, messageId) {
        backfillCalls.push({ threadId, userId, entryId, messageId });
      },
      appendMergedMessageId() {},
      list() {
        return [];
      },
    };
    await enqueueA2ATargets(
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        invocationTracker: {
          has() {
            return false;
          },
          start() {
            return new AbortController();
          },
          startAll() {
            return new AbortController();
          },
          tryStartThreadAll() {
            return new AbortController();
          },
          complete() {},
          completeAll() {},
        },
        queueProcessor: {
          onInvocationComplete() {},
          tryAutoExecute() {
            return Promise.resolve();
          },
        },
        invocationQueue: mockInvocationQueue,
        log: { info() {}, warn() {}, error() {} },
      },
      {
        targetCats: ['opus'],
        content: 'A2A handoff',
        userId: 'system',
        threadId: 't1',
        triggerMessage: { id: 'msg-trigger-123', mentions: ['opus'], content: 'test' },
        callerCatId: 'codex',
      },
    );

    assert.equal(backfillCalls.length, 1, 'should backfill messageId onto queue entry');
    assert.equal(backfillCalls[0].entryId, 'q-1');
    assert.equal(backfillCalls[0].messageId, 'msg-trigger-123');
  });

  test('PR7 initializes same-thread A2A custody before prompt exposure', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
    const { QueuedMessageCustodyCoordinator } = await import(
      '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const invocationQueue = new InvocationQueue();
    const messageStore = new MessageStore();
    const queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore });
    const socketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
      emitToUser() {},
    };
    const promptProcessor = new QueueProcessor({
      queue: invocationQueue,
      messageStore,
      queueCustodyCoordinator,
      socketManager,
    });
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'same-thread handoff already published in history',
      mentions: ['codex'],
      timestamp: 100,
      threadId: 'thread-target',
      deliveryStatus: 'queued',
    });
    let promptBoundaryReached = false;

    const result = await enqueueA2ATargets(
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager,
        invocationTracker: {
          has() {
            return false;
          },
          start() {
            return new AbortController();
          },
          startAll() {
            return new AbortController();
          },
          tryStartThreadAll() {
            return new AbortController();
          },
          complete() {},
          completeAll() {},
        },
        messageStore,
        queueProcessor: {
          onInvocationComplete() {},
          async tryAutoExecute() {
            const [entry] = invocationQueue.list('thread-target', 'user-1');
            assert.equal(entry.messageId, triggerMessage.id, 'callback must backfill the published trigger');
            const custody = messageStore.getById(triggerMessage.id)?.queueCustody;
            assert.ok(custody, 'same-thread custody must be durable before provider execution');
            assert.deepEqual(custody.allTargetCats, ['codex']);
            assert.equal(custody.carrierByTargetCatId.codex.entryId, entry.id);
            await promptProcessor.markPromptMessagesSeen({
              threadId: 'thread-target',
              userId: 'user-1',
              catId: 'codex',
              invocationId: 'inv-same-thread-child',
              messageIds: [triggerMessage.id],
              seenAt: 200,
            });
            promptBoundaryReached = true;
          },
        },
        invocationQueue,
        log: { info() {}, warn() {}, error() {} },
      },
      {
        targetCats: ['codex'],
        content: triggerMessage.content,
        userId: 'user-1',
        threadId: 'thread-target',
        triggerMessage,
        callerCatId: 'opus',
        parentInvocationId: 'parent-same-thread',
      },
    );

    assert.deepEqual(result.enqueued, ['codex']);
    assert.equal(promptBoundaryReached, true);
    assert.deepEqual(messageStore.getById(triggerMessage.id).queueCustody.seenByCatIds, ['codex']);
    assert.deepEqual(invocationQueue.list('thread-target', 'user-1')[0].queuedSeenByCatIds, ['codex']);
  });

  test('PR7 establishes complete same-thread custody for mixed enqueued and coalesced fan-out', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const invocationQueue = new InvocationQueue();
    const messageStore = new MessageStore();
    const existing = invocationQueue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-target',
      userId: 'user-1',
      content: 'existing codex carrier',
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
      a2aParentInvocationId: 'parent-same-thread',
      a2aTriggerMessageId: 'message-existing',
    }).entry;
    invocationQueue.backfillMessageId('thread-target', 'user-1', existing.id, 'message-existing');
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'fan out to both targets',
      mentions: ['codex', 'codex-terra'],
      timestamp: 200,
      threadId: 'thread-target',
      deliveryStatus: 'queued',
    });
    let custodyAtAutoExecute;

    const result = await enqueueA2ATargets(
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        messageStore,
        queueProcessor: {
          onInvocationComplete() {},
          tryAutoExecute() {
            custodyAtAutoExecute = messageStore.getById(triggerMessage.id)?.queueCustody;
            return Promise.resolve();
          },
        },
        invocationQueue,
        log: { info() {}, warn() {}, error() {} },
      },
      {
        targetCats: ['codex', 'codex-terra'],
        content: triggerMessage.content,
        userId: 'user-1',
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-target',
        triggerMessage,
        callerCatId: 'opus',
        parentInvocationId: 'parent-same-thread',
      },
    );

    assert.deepEqual(result.enqueued, ['codex-terra']);
    assert.deepEqual(result.coalesced, ['codex']);
    assert.ok(custodyAtAutoExecute, 'the complete fan-out must be durable before either target executes');
    assert.deepEqual(custodyAtAutoExecute.allTargetCats, ['codex', 'codex-terra']);
    assert.deepEqual(custodyAtAutoExecute.pendingTargetCats, ['codex', 'codex-terra']);
    const entries = invocationQueue.list('thread-target', 'user-1');
    assert.equal(custodyAtAutoExecute.carrierByTargetCatId.codex.entryId, existing.id);
    assert.equal(
      custodyAtAutoExecute.carrierByTargetCatId['codex-terra'].entryId,
      entries.find((entry) => entry.targetCats.includes('codex-terra')).id,
    );
  });

  test('PR7 establishes complete same-thread custody when every fan-out target coalesces', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const invocationQueue = new InvocationQueue();
    const messageStore = new MessageStore();
    const existingByCat = new Map();
    for (const catId of ['codex', 'codex-terra']) {
      const entry = invocationQueue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-target',
        userId: 'user-1',
        content: `existing ${catId} carrier`,
        source: 'agent',
        sourceCategory: 'a2a',
        targetCats: [catId],
        intent: 'execute',
        autoExecute: true,
        callerCatId: 'opus',
        a2aParentInvocationId: 'parent-same-thread',
        a2aTriggerMessageId: `message-existing-${catId}`,
      }).entry;
      invocationQueue.backfillMessageId('thread-target', 'user-1', entry.id, `message-existing-${catId}`);
      existingByCat.set(catId, entry);
    }
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'coalesce both targets',
      mentions: ['codex', 'codex-terra'],
      timestamp: 300,
      threadId: 'thread-target',
      deliveryStatus: 'queued',
    });
    let custodyAtAutoExecute;

    const result = await enqueueA2ATargets(
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        messageStore,
        queueProcessor: {
          onInvocationComplete() {},
          tryAutoExecute() {
            custodyAtAutoExecute = messageStore.getById(triggerMessage.id)?.queueCustody;
            return Promise.resolve();
          },
        },
        invocationQueue,
        log: { info() {}, warn() {}, error() {} },
      },
      {
        targetCats: ['codex', 'codex-terra'],
        content: triggerMessage.content,
        userId: 'user-1',
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-target',
        triggerMessage,
        callerCatId: 'opus',
        parentInvocationId: 'parent-same-thread',
      },
    );

    assert.deepEqual(result.enqueued, []);
    assert.deepEqual(result.coalesced, ['codex', 'codex-terra']);
    assert.ok(custodyAtAutoExecute, 'all-coalesced fan-out still requires durable group custody');
    assert.deepEqual(custodyAtAutoExecute.allTargetCats, ['codex', 'codex-terra']);
    assert.deepEqual(custodyAtAutoExecute.pendingTargetCats, ['codex', 'codex-terra']);
    for (const catId of ['codex', 'codex-terra']) {
      assert.equal(custodyAtAutoExecute.carrierByTargetCatId[catId].entryId, existingByCat.get(catId).id);
    }
  });

  test('PR7 competing scheduler cannot cross the provider boundary before fan-out custody commits', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
    const { QueuedMessageCustodyCoordinator } = await import(
      '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const invocationQueue = new InvocationQueue();
    const messageStore = new MessageStore();
    const initializeQueueCustody = messageStore.initializeQueueCustody.bind(messageStore);
    let releaseFanoutCustody;
    const fanoutCustodyGate = new Promise((resolve) => {
      releaseFanoutCustody = resolve;
    });
    let fanoutInitializationStarted;
    const fanoutInitializationStart = new Promise((resolve) => {
      fanoutInitializationStarted = resolve;
    });
    let initializationCalls = 0;
    messageStore.initializeQueueCustody = async (...args) => {
      initializationCalls += 1;
      if (initializationCalls === 1) {
        fanoutInitializationStarted();
        await fanoutCustodyGate;
      }
      return initializeQueueCustody(...args);
    };
    const queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore });
    const socketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
      emitToUser() {},
    };
    let providerStarts = 0;
    const invocationTracker = {
      has() {
        return false;
      },
      startAll() {
        return new AbortController();
      },
      waitForSessionSealRelease() {
        return Promise.resolve();
      },
      completeAll() {},
    };
    const queueProcessor = new QueueProcessor({
      queue: invocationQueue,
      messageStore,
      queueCustodyCoordinator,
      socketManager,
      invocationTracker,
      invocationRecordStore: {
        create() {
          return { outcome: 'created', invocationId: `inv-fanout-race-${Date.now()}` };
        },
        update(id, data) {
          return { id, ...data };
        },
      },
      router: {
        async *routeExecution(_userId, _content, _threadId, _messageId, targetCats) {
          providerStarts += 1;
          for (const catId of targetCats) {
            yield { type: 'done', catId, timestamp: Date.now() };
          }
        },
        async ackCollectedCursors() {},
      },
      log: { info() {}, warn() {}, error() {} },
    });
    const existingCodex = invocationQueue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-target',
      userId: 'user-1',
      content: 'existing codex carrier',
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
      a2aParentInvocationId: 'parent-same-thread',
      a2aTriggerMessageId: 'message-existing-codex',
    }).entry;
    invocationQueue.backfillMessageId('thread-target', 'user-1', existingCodex.id, 'message-existing-codex');
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'fan out under a competing scheduler',
      mentions: ['codex', 'codex-terra'],
      timestamp: 350,
      threadId: 'thread-target',
      deliveryStatus: 'queued',
    });

    const admission = enqueueA2ATargets(
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager,
        messageStore,
        invocationTracker,
        queueProcessor,
        invocationQueue,
        log: { info() {}, warn() {}, error() {} },
      },
      {
        targetCats: ['codex', 'codex-terra'],
        content: triggerMessage.content,
        userId: 'user-1',
        threadId: 'thread-target',
        triggerMessage,
        callerCatId: 'opus',
        parentInvocationId: 'parent-same-thread',
      },
    );

    await fanoutInitializationStart;
    await queueProcessor.tryAutoExecute('thread-target');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const providerStartsBeforeCustody = providerStarts;
    releaseFanoutCustody();
    let admissionResult;
    let admissionError;
    try {
      admissionResult = await admission;
    } catch (error) {
      admissionError = error;
    }

    assert.equal(
      providerStartsBeforeCustody,
      0,
      'provider execution must not begin until complete fan-out custody is durable',
    );
    assert.ifError(admissionError);
    assert.deepEqual(admissionResult.coalesced, ['codex']);
    assert.deepEqual(admissionResult.enqueued, ['codex-terra']);
    assert.deepEqual(messageStore.getById(triggerMessage.id).queueCustody.pendingTargetCats, ['codex', 'codex-terra']);
  });

  test('PR7 same-source reentry joins one staged carrier during the first custody CAS', async () => {
    const [
      { enqueueA2ATargets },
      { MessageDeliveryService },
      { InvocationQueue },
      { QueueProcessor },
      { QueuedMessageCustodyCoordinator },
      { MessageStore },
    ] = await Promise.all([
      import('../dist/routes/callback-a2a-trigger.js'),
      import('../dist/domains/cats/services/agents/invocation/MessageDeliveryService.js'),
      import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js'),
      import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js'),
      import('../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js'),
      import('../dist/domains/cats/services/stores/ports/MessageStore.js'),
    ]);

    const invocationQueue = new InvocationQueue();
    const messageStore = new MessageStore();
    const initializeQueueCustody = messageStore.initializeQueueCustody.bind(messageStore);
    let releaseFirstCustodyCas;
    const firstCustodyCasGate = new Promise((resolve) => {
      releaseFirstCustodyCas = resolve;
    });
    let firstCustodyCasStarted;
    const firstCustodyCasStart = new Promise((resolve) => {
      firstCustodyCasStarted = resolve;
    });
    let releaseSecondCustodyReturn;
    const secondCustodyReturnGate = new Promise((resolve) => {
      releaseSecondCustodyReturn = resolve;
    });
    let secondCustodyCommitted;
    const secondCustodyCommit = new Promise((resolve) => {
      secondCustodyCommitted = resolve;
    });
    let initializeCalls = 0;
    let stagedCarrierIdsAtSecondCas = [];
    messageStore.initializeQueueCustody = async (...args) => {
      initializeCalls += 1;
      if (initializeCalls === 1) {
        firstCustodyCasStarted();
        await firstCustodyCasGate;
        return initializeQueueCustody(...args);
      }
      const result = initializeQueueCustody(...args);
      stagedCarrierIdsAtSecondCas = invocationQueue
        .list('thread-same-source-reentry', 'user-1')
        .filter((entry) => entry.targetCats.includes('codex'))
        .map((entry) => entry.id);
      secondCustodyCommitted();
      await secondCustodyReturnGate;
      return result;
    };

    const queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore });
    const socketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
      emitToUser() {},
    };
    let providerStarts = 0;
    const providerContents = [];
    const invocationTracker = {
      has() {
        return false;
      },
      startAll() {
        return new AbortController();
      },
      waitForSessionSealRelease() {
        return Promise.resolve();
      },
      completeAll() {},
    };
    const queueProcessor = new QueueProcessor({
      queue: invocationQueue,
      messageStore,
      queueCustodyCoordinator,
      socketManager,
      invocationTracker,
      invocationRecordStore: {
        create() {
          return { outcome: 'created', invocationId: `inv-same-source-${Date.now()}` };
        },
        update(id, data) {
          return { id, ...data };
        },
      },
      router: {
        async *routeExecution(_userId, content, _threadId, _messageId, targetCats) {
          providerStarts += 1;
          providerContents.push(content);
          for (const catId of targetCats) {
            yield { type: 'done', catId, timestamp: Date.now() };
          }
        },
        async ackCollectedCursors() {},
      },
      log: { info() {}, warn() {}, error() {} },
    });
    const realTryAutoExecute = queueProcessor.tryAutoExecute.bind(queueProcessor);
    let autoExecuteEntrants = 0;
    let releaseAutoExecute;
    const autoExecuteGate = new Promise((resolve) => {
      releaseAutoExecute = resolve;
    });
    queueProcessor.tryAutoExecute = async (threadId) => {
      autoExecuteEntrants += 1;
      if (autoExecuteEntrants === 2) releaseAutoExecute();
      if (autoExecuteEntrants === 1) setTimeout(releaseAutoExecute, 25);
      await autoExecuteGate;
      return realTryAutoExecute(threadId);
    };

    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'same durable source must execute once',
      mentions: ['codex'],
      timestamp: 365,
      threadId: 'thread-same-source-reentry',
      deliveryStatus: 'queued',
    });
    const deps = {
      router: { async *routeExecution() {} },
      invocationRecordStore: { create() {}, update() {} },
      socketManager,
      messageStore,
      invocationTracker,
      queueProcessor,
      invocationQueue,
      log: { info() {}, warn() {}, error() {} },
    };
    const opts = {
      targetCats: ['codex'],
      content: triggerMessage.content,
      userId: 'user-1',
      ownerAuthProvenance: 'unknown',
      threadId: triggerMessage.threadId,
      triggerMessage,
      callerCatId: 'opus',
      parentInvocationId: 'parent-same-source-reentry',
    };
    const fallbackBroadcasts = [];
    const recoverSameSource = async () => {
      const decision = await MessageDeliveryService.resolveCallbackDeliveryDecision({
        canEnqueueA2A: true,
        willEnqueueToQueue: true,
        messageId: triggerMessage.id,
        threadId: triggerMessage.threadId,
        log: deps.log,
        enqueueA2A: () => enqueueA2ATargets(deps, opts),
        markDelivered: (deliveredAt) => messageStore.markDelivered(triggerMessage.id, deliveredAt),
        zeroEnqueuedWarnMessage: 'same-source recovery had no target',
        enqueueFailureMessage: 'same-source recovery failed',
      });
      if (decision.shouldBroadcastNow) fallbackBroadcasts.push(triggerMessage.id);
      return decision;
    };

    const firstRecovery = recoverSameSource();
    await firstCustodyCasStart;
    const duplicateRecovery = recoverSameSource();
    await secondCustodyCommit;
    releaseFirstCustodyCas();
    releaseSecondCustodyReturn();

    const [firstDecision, duplicateDecision] = await Promise.all([firstRecovery, duplicateRecovery]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(initializeCalls, 2, 'both callers converge through the same custody CAS identity');
    assert.equal(new Set(stagedCarrierIdsAtSecondCas).size, 1, 'same-source reentry must stage one carrier identity');
    assert.equal(firstDecision.enqueueFailed, false, 'the legitimate first callback must converge successfully');
    assert.equal(duplicateDecision.enqueueFailed, false, 'the duplicate recovery must converge successfully');
    assert.deepEqual(fallbackBroadcasts, [], 'custody convergence must not fall open to live broadcast');
    assert.equal(providerStarts, 1, 'the joined carrier may enter the provider exactly once');
    assert.deepEqual(
      providerContents,
      [triggerMessage.content],
      'same-source join must not duplicate provider content',
    );
  });

  test('PR7 same-source delivery joins restart custody after CAS before Queue projection', async () => {
    const [
      { enqueueA2ATargets },
      { MessageDeliveryService },
      { InvocationQueue },
      { QueueProcessor },
      { QueuedMessageCustodyCoordinator, createFanoutQueueCustodyAdmission },
      { StartupReconciler },
      { MessageStore },
    ] = await Promise.all([
      import('../dist/routes/callback-a2a-trigger.js'),
      import('../dist/domains/cats/services/agents/invocation/MessageDeliveryService.js'),
      import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js'),
      import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js'),
      import('../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js'),
      import('../dist/domains/cats/services/agents/invocation/StartupReconciler.js'),
      import('../dist/domains/cats/services/stores/ports/MessageStore.js'),
    ]);

    const invocationQueue = new InvocationQueue();
    const messageStore = new MessageStore();
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'restart projection gap must still execute once',
      mentions: ['codex'],
      timestamp: 370,
      threadId: 'thread-restart-projection-gap',
      deliveryStatus: 'queued',
    });
    await messageStore.initializeQueueCustodyAdmission(
      triggerMessage.id,
      createFanoutQueueCustodyAdmission(triggerMessage.id, {
        ownerUserId: 'user-1',
        ownerAuthProvenance: 'unknown',
        targetCats: ['codex'],
        requestedTargetCats: ['codex'],
        intent: 'execute',
        callerCatId: 'opus',
        a2aParentInvocationId: 'parent-restart-projection-gap',
        createdAt: triggerMessage.timestamp,
      }),
    );
    messageStore.scanByDeliveryStatus = (status) =>
      status === 'queued' && messageStore.getById(triggerMessage.id)?.deliveryStatus === 'queued'
        ? [triggerMessage.id]
        : [];

    const getById = messageStore.getById.bind(messageStore);
    const initializeQueueCustody = messageStore.initializeQueueCustody.bind(messageStore);
    let blockNextPostCasRead = false;
    let postCasReadBlocked = false;
    let enterProjectionGap;
    const projectionGapEntered = new Promise((resolve) => {
      enterProjectionGap = resolve;
    });
    let releaseProjectionGap;
    const projectionGap = new Promise((resolve) => {
      releaseProjectionGap = resolve;
    });
    messageStore.initializeQueueCustody = async (...args) => {
      const result = await initializeQueueCustody(...args);
      blockNextPostCasRead = true;
      return result;
    };
    messageStore.getById = (messageId) => {
      if (messageId === triggerMessage.id && blockNextPostCasRead && !postCasReadBlocked) {
        postCasReadBlocked = true;
        blockNextPostCasRead = false;
        enterProjectionGap();
        return projectionGap.then(() => getById(messageId));
      }
      return getById(messageId);
    };

    const startup = new StartupReconciler({
      invocationRecordStore: {
        async scanByStatus() {
          return [];
        },
        async get() {
          return null;
        },
      },
      invocationQueue,
      messageStore,
      a2aDispatchDispositionService: {
        async inspectHandoff({ sourceMessageId }) {
          return {
            outcome: 'live',
            sourceMessageId,
            fromCatId: 'opus',
            handoffSourceEventId: `route:${sourceMessageId}`,
          };
        },
      },
      taskProgressStore: { async deleteSnapshot() {} },
      log: { info() {}, warn() {} },
    });
    const startupRun = startup.reconcileOrphans();
    await projectionGapEntered;

    const committed = getById(triggerMessage.id);
    assert.equal(committed.queueCustody?.status, 'queued', 'startup committed full custody before projection');
    assert.equal(invocationQueue.list(triggerMessage.threadId, 'user-1').length, 0, 'local Queue is still empty');

    const socketManager = {
      broadcastAgentMessage() {},
      broadcastToRoom() {},
      emitToUser() {},
    };
    const callbackDeps = {
      router: { async *routeExecution() {} },
      invocationRecordStore: { create() {}, update() {} },
      socketManager,
      messageStore,
      invocationQueue,
      queueProcessor: { async tryAutoExecute() {} },
      log: { info() {}, warn() {}, error() {} },
    };
    const decision = await MessageDeliveryService.resolveCallbackDeliveryDecision({
      canEnqueueA2A: true,
      willEnqueueToQueue: true,
      messageId: triggerMessage.id,
      threadId: triggerMessage.threadId,
      log: callbackDeps.log,
      enqueueA2A: () =>
        enqueueA2ATargets(callbackDeps, {
          targetCats: ['codex'],
          content: triggerMessage.content,
          userId: 'user-1',
          ownerAuthProvenance: 'unknown',
          threadId: triggerMessage.threadId,
          triggerMessage,
          callerCatId: 'opus',
          parentInvocationId: 'parent-restart-projection-gap',
        }),
      markDelivered: (deliveredAt) => messageStore.markDelivered(triggerMessage.id, deliveredAt),
      zeroEnqueuedWarnMessage: 'restart projection join had no target',
      enqueueFailureMessage: 'restart projection join failed',
    });

    releaseProjectionGap();
    await startupRun;

    const canonicalEntryId = `queue-custody:${triggerMessage.id}:codex`;
    const projectedEntries = invocationQueue.list(triggerMessage.threadId, 'user-1');
    assert.equal(decision.enqueueFailed, false, 'same-source callback must join committed custody');
    assert.equal(decision.shouldBroadcastNow, false, 'committed custody must never fall open to broadcast');
    assert.deepEqual(
      projectedEntries.map((entry) => entry.id),
      [canonicalEntryId],
      'callback and startup must converge on one canonical Queue carrier',
    );

    let providerStarts = 0;
    const providerContents = [];
    const queueProcessor = new QueueProcessor({
      queue: invocationQueue,
      messageStore,
      queueCustodyCoordinator: new QueuedMessageCustodyCoordinator({ messageStore }),
      socketManager,
      invocationTracker: {
        has() {
          return false;
        },
        startAll() {
          return new AbortController();
        },
        waitForSessionSealRelease() {
          return Promise.resolve();
        },
        completeAll() {},
      },
      invocationRecordStore: {
        create() {
          return { outcome: 'created', invocationId: `inv-restart-gap-${Date.now()}` };
        },
        update(id, data) {
          return { id, ...data };
        },
      },
      router: {
        async *routeExecution(_userId, content, _threadId, _messageId, targetCats) {
          providerStarts += 1;
          providerContents.push(content);
          for (const catId of targetCats) yield { type: 'done', catId, timestamp: Date.now() };
        },
        async ackCollectedCursors() {},
      },
      log: { info() {}, warn() {}, error() {} },
    });
    await queueProcessor.tryAutoExecute(triggerMessage.threadId);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(providerStarts, 1, 'the custody-bound carrier executes exactly once');
    assert.deepEqual(providerContents, [triggerMessage.content], 'the source content is not duplicated');
  });

  test('PR7 pure restart preserves a full-custody action fence before provider admission', async () => {
    const [
      { enqueueA2ATargets },
      { InvocationQueue },
      { QueueProcessor },
      { QueuedMessageCustodyCoordinator },
      { StartupReconciler },
      { MessageStore },
    ] = await Promise.all([
      import('../dist/routes/callback-a2a-trigger.js'),
      import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js'),
      import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js'),
      import('../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js'),
      import('../dist/domains/cats/services/agents/invocation/StartupReconciler.js'),
      import('../dist/domains/cats/services/stores/ports/MessageStore.js'),
    ]);

    const actionSuccessorFence = {
      leaseId: 'lease-action-restart',
      generation: 7,
      dispatchId: 'cross-post:action-restart',
      terminalPredicateDigest: 'terminal-predicate-action-restart',
      invocationLineageRef: 'dispatch:cross-post:action-restart',
    };
    const messageStore = new MessageStore();
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'terminal action must stay fenced after restart',
      mentions: ['codex'],
      timestamp: 372,
      threadId: 'thread-action-restart',
      deliveryStatus: 'queued',
      extra: {
        crossPost: {
          sourceThreadId: 'thread-action-source',
          sourceInvocationId: 'parent-action-restart',
          effectClass: 'assign_work',
        },
      },
    });
    messageStore.scanByDeliveryStatus = (status) =>
      status === 'queued' && messageStore.getById(triggerMessage.id)?.deliveryStatus === 'queued'
        ? [triggerMessage.id]
        : [];

    const beforeRestartQueue = new InvocationQueue();
    const admission = await enqueueA2ATargets(
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        messageStore,
        invocationQueue: beforeRestartQueue,
        queueProcessor: { async tryAutoExecute() {} },
        log: { info() {}, warn() {}, error() {} },
      },
      {
        targetCats: ['codex'],
        content: triggerMessage.content,
        userId: 'user-1',
        ownerAuthProvenance: 'strict',
        threadId: triggerMessage.threadId,
        triggerMessage,
        callerCatId: 'opus',
        parentInvocationId: 'parent-action-restart',
        actionSuccessorFence,
      },
    );
    assert.deepEqual(admission.enqueued, ['codex']);
    const committed = messageStore.getById(triggerMessage.id);
    assert.equal(committed.queueCustody?.status, 'queued');
    assert.equal(committed.queueCustodyAdmission, undefined, 'full custody atomically replaces admission intent');

    const restartedQueue = new InvocationQueue();
    const startup = new StartupReconciler({
      invocationRecordStore: {
        async scanByStatus() {
          return [];
        },
        async get() {
          return null;
        },
      },
      invocationQueue: restartedQueue,
      messageStore,
      a2aDispatchDispositionService: {
        async inspectHandoff({ sourceMessageId }) {
          return {
            outcome: 'live',
            sourceMessageId,
            fromCatId: 'opus',
            handoffSourceEventId: `route:${sourceMessageId}`,
          };
        },
      },
      taskProgressStore: { async deleteSnapshot() {} },
      log: { info() {}, warn() {} },
    });
    await startup.reconcileOrphans();

    const restored = restartedQueue.markProcessing(triggerMessage.threadId, 'user-1');
    assert.ok(restored, 'pure restart must restore the full-custody carrier');
    let preflightCalls = 0;
    let providerStarts = 0;
    let invocationRecordCreates = 0;
    const queueProcessor = new QueueProcessor({
      queue: restartedQueue,
      messageStore,
      queueCustodyCoordinator: new QueuedMessageCustodyCoordinator({ messageStore }),
      actionSuccessorLeaseStore: {
        async preflight(leaseId, generation, terminalPredicateDigest) {
          preflightCalls += 1;
          assert.deepEqual(
            { leaseId, generation, terminalPredicateDigest },
            {
              leaseId: actionSuccessorFence.leaseId,
              generation: actionSuccessorFence.generation,
              terminalPredicateDigest: actionSuccessorFence.terminalPredicateDigest,
            },
          );
          return { ok: false, reason: 'subject_terminal' };
        },
      },
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      invocationTracker: {
        has() {
          return false;
        },
        startAll() {
          return new AbortController();
        },
        waitForSessionSealRelease() {
          return Promise.resolve();
        },
        completeAll() {},
      },
      invocationRecordStore: {
        create() {
          invocationRecordCreates += 1;
          return { outcome: 'created', invocationId: 'inv-action-restart' };
        },
        update(id, data) {
          return { id, ...data };
        },
      },
      router: {
        async *routeExecution() {
          providerStarts += 1;
          yield { type: 'done', catId: 'codex', timestamp: Date.now() };
        },
        async ackCollectedCursors() {},
      },
      log: { info() {}, warn() {}, error() {} },
    });

    const result = await queueProcessor.executeEntry(restored);

    assert.deepEqual(restored.actionSuccessorFence, actionSuccessorFence);
    assert.equal(restored.idempotencyKey, 'action:lease-action-restart:7:codex');
    assert.equal(result.status, 'canceled', 'terminal action lease must fail closed before provider admission');
    assert.equal(preflightCalls, 1, 'restart projection must retain the action preflight boundary');
    assert.equal(invocationRecordCreates, 0, 'terminal action must not mint an invocation record');
    assert.equal(providerStarts, 0, 'terminal action must never reach the provider after restart');
  });

  test('PR7 restart recovers the complete fan-out when the process dies before the first custody CAS', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { StartupReconciler } = await import('../dist/domains/cats/services/agents/invocation/StartupReconciler.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const crashedQueue = new InvocationQueue();
    const messageStore = new MessageStore();
    const initializeQueueCustody = messageStore.initializeQueueCustody.bind(messageStore);
    let releaseFirstCustodyCas;
    const firstCustodyCasGate = new Promise((resolve) => {
      releaseFirstCustodyCas = resolve;
    });
    let firstCustodyCasStarted;
    const firstCustodyCasStart = new Promise((resolve) => {
      firstCustodyCasStarted = resolve;
    });
    let initializeCalls = 0;
    messageStore.initializeQueueCustody = async (...args) => {
      initializeCalls += 1;
      if (initializeCalls === 1) {
        firstCustodyCasStarted();
        await firstCustodyCasGate;
      }
      return initializeQueueCustody(...args);
    };
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'fan out and survive restart',
      mentions: ['codex', 'codex-terra'],
      timestamp: 375,
      threadId: 'thread-target',
      deliveryStatus: 'queued',
    });
    messageStore.scanByDeliveryStatus = (status) =>
      status === 'queued' && messageStore.getById(triggerMessage.id)?.deliveryStatus === 'queued'
        ? [triggerMessage.id]
        : [];

    const interruptedAdmission = enqueueA2ATargets(
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        messageStore,
        invocationQueue: crashedQueue,
        log: { info() {}, warn() {}, error() {} },
      },
      {
        targetCats: ['codex', 'codex-terra'],
        content: triggerMessage.content,
        userId: 'user-1',
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-target',
        triggerMessage,
        callerCatId: 'opus',
        parentInvocationId: 'parent-same-thread',
      },
    );

    await firstCustodyCasStart;
    assert.equal(crashedQueue.list('thread-target', 'user-1').length, 2, 'old process staged both carriers');

    const restartedQueue = new InvocationQueue();
    const startup = new StartupReconciler({
      invocationRecordStore: {
        async scanByStatus() {
          return [];
        },
        async get() {
          return null;
        },
      },
      invocationQueue: restartedQueue,
      messageStore,
      a2aDispatchDispositionService: {
        async inspectHandoff({ sourceMessageId }) {
          return {
            outcome: 'live',
            sourceMessageId,
            fromCatId: 'opus',
            handoffSourceEventId: `route:${sourceMessageId}`,
          };
        },
      },
      taskProgressStore: { async deleteSnapshot() {} },
      log: { info() {}, warn() {} },
    });

    await startup.reconcileOrphans();

    const restoredEntries = restartedQueue.list('thread-target', 'user-1');
    assert.equal(restoredEntries.length, 2, 'restart must rebuild every target carrier');
    assert.deepEqual(restoredEntries.flatMap((entry) => entry.targetCats).sort(), ['codex', 'codex-terra']);
    const recoveredMessage = messageStore.getById(triggerMessage.id);
    assert.equal(recoveredMessage.deliveryStatus, 'queued', 'pending fan-out must not become delivered-only');
    assert.deepEqual(recoveredMessage.queueCustody?.pendingTargetCats, ['codex', 'codex-terra']);

    releaseFirstCustodyCas();
    await interruptedAdmission.catch(() => {});
  });

  test('PR7 restart never revives a target rejected before the first custody CAS', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { StartupReconciler } = await import('../dist/domains/cats/services/agents/invocation/StartupReconciler.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const crashedQueue = new InvocationQueue();
    for (let index = 0; index < 10; index += 1) {
      crashedQueue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-depth-rejection',
        userId: 'user-1',
        content: `existing pending A2A ${index}`,
        source: 'agent',
        sourceCategory: 'a2a',
        targetCats: ['opus'],
        intent: 'execute',
        autoExecute: false,
        callerCatId: 'codex-terra',
        a2aParentInvocationId: `parent-existing-${index}`,
        a2aTriggerMessageId: `message-existing-${index}`,
      });
    }

    const messageStore = new MessageStore();
    const initializeQueueCustody = messageStore.initializeQueueCustody.bind(messageStore);
    let releaseFirstCustodyCas;
    const firstCustodyCasGate = new Promise((resolve) => {
      releaseFirstCustodyCas = resolve;
    });
    let firstCustodyCasStarted;
    const firstCustodyCasStart = new Promise((resolve) => {
      firstCustodyCasStarted = resolve;
    });
    let initializeCalls = 0;
    messageStore.initializeQueueCustody = async (...args) => {
      initializeCalls += 1;
      if (initializeCalls === 1) {
        firstCustodyCasStarted();
        await firstCustodyCasGate;
      }
      return initializeQueueCustody(...args);
    };
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'codex-terra',
      content: 'this target must remain rejected after restart',
      mentions: ['codex'],
      timestamp: 390,
      threadId: 'thread-depth-rejection',
      deliveryStatus: 'queued',
    });
    messageStore.scanByDeliveryStatus = (status) =>
      status === 'queued' && messageStore.getById(triggerMessage.id)?.deliveryStatus === 'queued'
        ? [triggerMessage.id]
        : [];

    const interruptedAdmission = enqueueA2ATargets(
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        messageStore,
        invocationQueue: crashedQueue,
        log: { info() {}, warn() {}, error() {} },
      },
      {
        targetCats: ['codex'],
        content: triggerMessage.content,
        userId: 'user-1',
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-depth-rejection',
        triggerMessage,
        callerCatId: 'codex-terra',
        parentInvocationId: 'parent-depth-rejection',
      },
    );

    await firstCustodyCasStart;
    assert.equal(
      crashedQueue.list('thread-depth-rejection', 'user-1').filter((entry) => entry.targetCats.includes('codex'))
        .length,
      0,
      'ordinary enqueue policy rejects codex before the crash window',
    );
    const persistedAdmission = messageStore.getById(triggerMessage.id)?.queueCustodyAdmission;
    assert.deepEqual(persistedAdmission?.requestedTargetCats, ['codex']);
    assert.deepEqual(persistedAdmission?.targetCats, [], 'durable admission records the final rejected outcome');

    const restartedQueue = new InvocationQueue();
    const startup = new StartupReconciler({
      invocationRecordStore: {
        async scanByStatus() {
          return [];
        },
        async get() {
          return null;
        },
      },
      invocationQueue: restartedQueue,
      messageStore,
      a2aDispatchDispositionService: {
        async inspectHandoff({ sourceMessageId }) {
          return {
            outcome: 'live',
            sourceMessageId,
            fromCatId: 'codex-terra',
            handoffSourceEventId: `route:${sourceMessageId}`,
          };
        },
      },
      taskProgressStore: { async deleteSnapshot() {} },
      log: { info() {}, warn() {} },
    });

    await startup.reconcileOrphans();

    assert.equal(
      restartedQueue.listAutoExecute('thread-depth-rejection').filter((entry) => entry.targetCats.includes('codex'))
        .length,
      0,
      'restart recovery must preserve the enqueue-time target rejection',
    );

    releaseFirstCustodyCas();
    await interruptedAdmission.catch(() => {});
  });

  test('PR7 rejects incompatible same-thread custody before any target can auto-execute', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const invocationQueue = new InvocationQueue();
    const messageStore = new MessageStore();
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'same-thread custody collision',
      mentions: ['codex'],
      timestamp: 400,
      threadId: 'thread-target',
      deliveryStatus: 'queued',
    });
    messageStore.initializeQueueCustody(triggerMessage.id, {
      version: 1,
      entryId: 'unrelated-entry',
      revision: 1,
      intent: 'execute',
      status: 'queued',
      allTargetCats: ['codex'],
      pendingTargetCats: ['codex'],
      notifiedByCatIds: [],
      seenByCatIds: [],
      seenInvocationIdByCatId: {},
      failedByCatIds: [],
      handledByCatIds: [],
      priority: 'normal',
      createdAt: 400,
      updatedAt: 400,
    });
    let autoExecuteCalls = 0;

    await assert.rejects(
      enqueueA2ATargets(
        {
          router: { async *routeExecution() {} },
          invocationRecordStore: { create() {}, update() {} },
          socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
          messageStore,
          queueProcessor: {
            onInvocationComplete() {},
            tryAutoExecute() {
              autoExecuteCalls += 1;
              return Promise.resolve();
            },
          },
          invocationQueue,
          log: { info() {}, warn() {}, error() {} },
        },
        {
          targetCats: ['codex'],
          content: triggerMessage.content,
          userId: 'user-1',
          threadId: 'thread-target',
          triggerMessage,
          callerCatId: 'opus',
          parentInvocationId: 'parent-same-thread',
        },
      ),
      /custody identity mismatch/,
    );

    assert.equal(autoExecuteCalls, 0);
    assert.deepEqual(invocationQueue.list('thread-target', 'user-1'), []);
  });

  test('F264 initializes per-target cross-thread custody before A2A auto-execution', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const invocationQueue = new InvocationQueue();
    const messageStore = new MessageStore();
    const userEvents = [];
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'terminal release',
      mentions: ['codex', 'codex-terra'],
      timestamp: 100,
      threadId: 'thread-target',
      deliveryStatus: 'queued',
      extra: {
        crossPost: {
          sourceThreadId: 'thread-source',
          sourceInvocationId: 'parent-source',
          effectClass: 'coordinate',
        },
        coordination: {
          id: 'coord-1',
          phase: 'terminal',
          hop: 1,
        },
      },
    });

    let custodyAtAutoExecute;
    const result = await enqueueA2ATargets(
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: {
          broadcastAgentMessage() {},
          broadcastToRoom() {},
          emitToUser(userId, event, data) {
            userEvents.push({ userId, event, data });
          },
        },
        messageStore,
        queueProcessor: {
          onInvocationComplete() {},
          tryAutoExecute() {
            custodyAtAutoExecute = messageStore.getById(triggerMessage.id)?.queueCustody;
            return Promise.resolve();
          },
        },
        invocationQueue,
        log: { info() {}, warn() {}, error() {} },
      },
      {
        targetCats: ['codex', 'codex-terra'],
        content: 'terminal release',
        userId: 'user-1',
        threadId: 'thread-target',
        triggerMessage,
        callerCatId: 'opus',
        parentInvocationId: 'parent-source',
      },
    );

    assert.deepEqual(result.enqueued, ['codex', 'codex-terra']);
    assert.ok(custodyAtAutoExecute, 'durable receipt custody must exist before the child can start');
    assert.equal(custodyAtAutoExecute.receiptScope, 'cross_thread_delivery');
    assert.deepEqual(custodyAtAutoExecute.allTargetCats, ['codex', 'codex-terra']);
    assert.deepEqual(custodyAtAutoExecute.pendingTargetCats, ['codex', 'codex-terra']);

    const entries = invocationQueue.list('thread-target', 'user-1');
    assert.equal(entries.length, 2, 'A2A keeps independent per-target Queue carriers');
    assert.deepEqual(
      custodyAtAutoExecute.carrierByTargetCatId,
      Object.fromEntries(
        entries.map((entry) => [
          entry.targetCats[0],
          {
            entryId: entry.id,
            source: 'agent',
            sourceCategory: 'a2a',
            callerCatId: 'opus',
            a2aParentInvocationId: 'parent-source',
            a2aTriggerMessageId: triggerMessage.id,
            autoExecute: true,
            createdAt: entry.createdAt,
          },
        ]),
      ),
    );
    const queuedTimelineEvent = userEvents.find((event) => event.event === 'messages_queued');
    assert.equal(queuedTimelineEvent.userId, 'user-1');
    assert.equal(queuedTimelineEvent.data.threadId, 'thread-target');
    assert.equal(queuedTimelineEvent.data.messages[0].id, triggerMessage.id);
    assert.equal(queuedTimelineEvent.data.messages[0].extra.queueReceipt.scope, 'cross_thread_delivery');
    assert.deepEqual(
      queuedTimelineEvent.data.messages[0].extra.queueReceipt.targets.map((target) => target.state),
      ['queued', 'queued'],
    );
  });

  test('PR7 direct-active cross-thread handoff drains exactly once when the target slot becomes idle', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { InvocationTracker } = await import('../dist/domains/cats/services/agents/invocation/InvocationTracker.js');
    const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
    const { QueuedMessageCustodyCoordinator } = await import(
      '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js'
    );
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const threadId = 'thread-direct-active-cross-thread';
    const targetCatId = 'codex-sol';
    const invocationQueue = new InvocationQueue();
    const invocationTracker = new InvocationTracker();
    const invocationRecordStore = new InvocationRecordStore();
    const messageStore = new MessageStore();
    const queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore });
    const socketManager = { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} };
    let providerStarts = 0;
    const queueProcessor = new QueueProcessor({
      queue: invocationQueue,
      invocationTracker,
      invocationRecordStore,
      messageStore,
      queueCustodyCoordinator,
      socketManager,
      router: {
        async *routeExecution(userId, _content, routedThreadId, _messageId, targetCats, _intent, options) {
          providerStarts += 1;
          await options.onPromptMessagesExposed({
            threadId: routedThreadId,
            userId,
            catId: targetCats[0],
            invocationId: 'inv-queued-successor',
            messageIds: options.persistedPromptMessageIds,
            seenAt: Date.now(),
          });
          yield {
            type: 'done',
            catId: targetCats[0],
            invocationId: 'inv-queued-successor',
            timestamp: Date.now(),
          };
        },
        async ackCollectedCursors() {},
      },
      log: { info() {}, warn() {}, error() {} },
    });
    const directController = invocationTracker.startAll(threadId, [targetCatId], 'user-1', 'inv-direct-active');
    assert.ok(directController, 'test must hold the exact target slot before the handoff arrives');
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'coordinate queued while the target is busy',
      mentions: [targetCatId],
      timestamp: 450,
      threadId,
      deliveryStatus: 'queued',
      extra: {
        crossPost: {
          sourceThreadId: 'thread-source',
          sourceInvocationId: 'inv-source',
          effectClass: 'coordinate',
        },
      },
    });

    await enqueueA2ATargets(
      {
        router: { async *routeExecution() {} },
        invocationRecordStore,
        socketManager,
        messageStore,
        invocationTracker,
        queueProcessor,
        invocationQueue,
        log: { info() {}, warn() {}, error() {} },
      },
      {
        targetCats: [targetCatId],
        content: triggerMessage.content,
        userId: 'user-1',
        ownerAuthProvenance: 'unknown',
        threadId,
        triggerMessage,
        callerCatId: 'opus',
        parentInvocationId: 'inv-source',
      },
    );

    assert.equal(providerStarts, 0, 'busy admission must stay durable without starting a competing provider');
    assert.equal(invocationQueue.list(threadId, 'user-1').length, 1);
    assert.equal(messageStore.getById(triggerMessage.id).deliveryStatus, 'queued');

    invocationTracker.completeAll(threadId, [targetCatId], directController);
    await queueProcessor.onInvocationComplete(threadId, targetCatId, 'succeeded', 'inv-direct-active', [targetCatId]);
    for (
      let attempt = 0;
      attempt < 50 && messageStore.getById(triggerMessage.id)?.deliveryStatus !== 'delivered';
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(providerStarts, 1, 'the durable carrier must start once when the direct slot becomes idle');
    assert.deepEqual(invocationQueue.list(threadId, 'user-1'), []);
    const terminal = messageStore.getById(triggerMessage.id);
    assert.equal(terminal.deliveryStatus, 'delivered');
    assert.equal(terminal.queueCustody.status, 'terminal');
    assert.deepEqual(terminal.queueCustody.handledByCatIds, [targetCatId]);
  });

  test('F264 rejects a mismatched existing cross-thread custody before auto-execution', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const invocationQueue = new InvocationQueue();
    const messageStore = new MessageStore();
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'terminal release',
      mentions: ['codex'],
      timestamp: 100,
      threadId: 'thread-target',
      deliveryStatus: 'queued',
      extra: {
        crossPost: {
          sourceThreadId: 'thread-source',
          sourceInvocationId: 'parent-source',
          effectClass: 'coordinate',
        },
      },
    });
    messageStore.initializeQueueCustody(triggerMessage.id, {
      version: 1,
      entryId: 'unrelated-entry',
      revision: 1,
      intent: 'execute',
      status: 'queued',
      allTargetCats: ['codex'],
      pendingTargetCats: ['codex'],
      notifiedByCatIds: [],
      seenByCatIds: [],
      seenInvocationIdByCatId: {},
      failedByCatIds: [],
      handledByCatIds: [],
      priority: 'normal',
      createdAt: 100,
      updatedAt: 100,
    });
    let autoExecuteCalls = 0;

    await assert.rejects(
      enqueueA2ATargets(
        {
          router: { async *routeExecution() {} },
          invocationRecordStore: { create() {}, update() {} },
          socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
          messageStore,
          queueProcessor: {
            onInvocationComplete() {},
            tryAutoExecute() {
              autoExecuteCalls += 1;
              return Promise.resolve();
            },
          },
          invocationQueue,
          log: { info() {}, warn() {}, error() {} },
        },
        {
          targetCats: ['codex'],
          content: 'terminal release',
          userId: 'user-1',
          threadId: 'thread-target',
          triggerMessage,
          callerCatId: 'opus',
          parentInvocationId: 'parent-source',
        },
      ),
      /custody identity mismatch/,
    );

    assert.equal(autoExecuteCalls, 0);
    assert.deepEqual(invocationQueue.list('thread-target', 'user-1'), []);
  });

  test('F264 binds a coalesced cross-thread message to the existing exact Queue carrier', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const invocationQueue = new InvocationQueue();
    const messageStore = new MessageStore();
    const existing = invocationQueue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-target',
      userId: 'user-1',
      content: 'first handoff',
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
      a2aParentInvocationId: 'parent-source',
      a2aTriggerMessageId: 'message-first',
    }).entry;
    invocationQueue.backfillMessageId('thread-target', 'user-1', existing.id, 'message-first');
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'second handoff',
      mentions: ['codex'],
      timestamp: 200,
      threadId: 'thread-target',
      deliveryStatus: 'queued',
      extra: {
        crossPost: {
          sourceThreadId: 'thread-source',
          sourceInvocationId: 'parent-source',
          effectClass: 'coordinate',
        },
      },
    });
    let custodyAtAutoExecute;

    const result = await enqueueA2ATargets(
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        messageStore,
        queueProcessor: {
          onInvocationComplete() {},
          tryAutoExecute() {
            custodyAtAutoExecute = messageStore.getById(triggerMessage.id)?.queueCustody;
            return Promise.resolve();
          },
        },
        invocationQueue,
        log: { info() {}, warn() {}, error() {} },
      },
      {
        targetCats: ['codex'],
        content: 'second handoff',
        userId: 'user-1',
        threadId: 'thread-target',
        triggerMessage,
        callerCatId: 'opus',
        parentInvocationId: 'parent-source',
      },
    );

    assert.deepEqual(result.enqueued, []);
    assert.deepEqual(result.coalesced, ['codex']);
    assert.equal(custodyAtAutoExecute.carrierByTargetCatId.codex.entryId, existing.id);
    assert.equal(custodyAtAutoExecute.carrierByTargetCatId.codex.a2aTriggerMessageId, 'message-first');
    const merged = invocationQueue.getEntrySnapshot('thread-target', 'user-1', existing.id);
    assert.equal(merged.content, 'first handoff\n\nsecond handoff');
    assert.deepEqual(merged.mergedMessageIds, [triggerMessage.id]);
  });

  test('F264 action replay restores every durable coalesced member beyond the recent timeline window', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
    const { createInitialCrossThreadQueuedMessageCustody, QueuedMessageCustodyCoordinator } = await import(
      '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const admissionQueue = new InvocationQueue();
    const enqueueCarrier = (catId, triggerMessageId) =>
      admissionQueue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-target',
        userId: 'user-1',
        content: 'first handoff',
        source: 'agent',
        sourceCategory: 'a2a',
        targetCats: [catId],
        intent: 'execute',
        autoExecute: true,
        callerCatId: 'sonnet',
        a2aParentInvocationId: 'parent-source',
        a2aTriggerMessageId: triggerMessageId,
      }).entry;
    const opusCarrier = enqueueCarrier('opus', 'message-first');
    const codexCarrier = enqueueCarrier('codex', 'message-first');
    const messageStore = new MessageStore({ maxMessages: 3_000 });
    const crossPost = {
      sourceThreadId: 'thread-source',
      sourceInvocationId: 'parent-source',
      effectClass: 'coordinate',
    };
    const first = messageStore.append({
      userId: 'user-1',
      catId: 'sonnet',
      content: 'first handoff',
      mentions: ['opus', 'codex'],
      timestamp: 100,
      threadId: 'thread-target',
      deliveryStatus: 'queued',
      extra: { crossPost },
    });
    admissionQueue.backfillMessageId('thread-target', 'user-1', opusCarrier.id, first.id);
    admissionQueue.backfillMessageId('thread-target', 'user-1', codexCarrier.id, first.id);
    assert.equal(
      messageStore.initializeQueueCustody(
        first.id,
        createInitialCrossThreadQueuedMessageCustody(first.id, [opusCarrier, codexCarrier], {
          requestedTargetCats: ['opus', 'codex'],
          createdAt: first.timestamp,
        }),
      ).kind,
      'initialized',
    );
    const second = messageStore.append({
      userId: 'user-1',
      catId: 'sonnet',
      content: 'second handoff',
      mentions: ['opus'],
      timestamp: 101,
      threadId: 'thread-target',
      deliveryStatus: 'queued',
      extra: { crossPost },
    });
    assert.equal(
      admissionQueue.coalesceContentIntoQueuedAgent(
        'thread-target',
        'user-1',
        opusCarrier.id,
        second.content,
        second.id,
        'sonnet',
        'parent-source',
      ),
      true,
    );
    const mergedOpusCarrier = admissionQueue.getEntrySnapshot('thread-target', 'user-1', opusCarrier.id);
    assert.equal(
      messageStore.initializeQueueCustody(
        second.id,
        createInitialCrossThreadQueuedMessageCustody(second.id, [mergedOpusCarrier], {
          requestedTargetCats: ['opus'],
          createdAt: second.timestamp,
        }),
      ).kind,
      'initialized',
    );
    for (let index = 0; index < 2_001; index += 1) {
      const newerMessage = messageStore.append({
        userId: 'user-1',
        catId: 'sonnet',
        content: `newer durable message ${index}`,
        mentions: [],
        timestamp: 102 + index,
        threadId: 'thread-target',
        deliveryStatus: 'queued',
      });
      assert.equal(messageStore.markDelivered(newerMessage.id, 102 + index)?.deliveryStatus, 'delivered');
    }

    const replayQueue = new InvocationQueue();
    const result = await enqueueA2ATargets(
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        messageStore,
        queueProcessor: {
          onInvocationComplete() {},
          tryAutoExecute() {
            return Promise.resolve();
          },
        },
        invocationQueue: replayQueue,
        log: { info() {}, warn() {}, error() {} },
      },
      {
        targetCats: ['opus'],
        content: second.content,
        userId: 'user-1',
        threadId: 'thread-target',
        triggerMessage: second,
        callerCatId: 'sonnet',
        parentInvocationId: 'parent-source',
        ownerAuthProvenance: 'strict',
        actionSuccessorFence: {
          leaseId: 'lease-review-1',
          generation: 2,
          dispatchId: 'cross-post:message-second',
        },
      },
    );

    assert.deepEqual(result.enqueued, ['opus']);
    const restored = replayQueue.getEntrySnapshot('thread-target', 'user-1', opusCarrier.id);
    assert.equal(restored.messageId, first.id);
    assert.equal(restored.ownerAuthProvenance, 'unknown');
    assert.deepEqual(restored.mergedMessageIds, [second.id]);
    assert.deepEqual(restored.targetCats, ['opus']);
    assert.deepEqual(restored.actionSuccessorFence, {
      leaseId: 'lease-review-1',
      generation: 2,
      dispatchId: 'cross-post:message-second',
    });
    for (const messageId of [first.id, second.id]) {
      const binding = messageStore.getById(messageId).queueCustody.carrierByTargetCatId.opus;
      assert.equal(binding.idempotencyKey, 'action:lease-review-1:2:opus');
      assert.deepEqual(
        binding.actionSuccessorFence,
        restored.actionSuccessorFence,
        'action replay must durably rebind every coalesced custody member before Queue projection',
      );
    }
    assert.equal(replayQueue.getEntrySnapshot('thread-target', 'user-1', codexCarrier.id), null);

    const processing = replayQueue.markProcessing('thread-target', 'user-1');
    assert.ok(processing, 'the complete restored carrier must remain provider-selectable');
    let providerStarts = 0;
    const providerContents = [];
    const queueProcessor = new QueueProcessor({
      queue: replayQueue,
      messageStore,
      queueCustodyCoordinator: new QueuedMessageCustodyCoordinator({ messageStore }),
      actionSuccessorLeaseStore: {
        async preflight() {
          return { ok: true, reason: 'active' };
        },
        async commitOutcome() {
          return { outcome: 'recorded', lease: { status: 'completed' } };
        },
      },
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      invocationTracker: {
        has() {
          return false;
        },
        startAll() {
          return new AbortController();
        },
        waitForSessionSealRelease() {
          return Promise.resolve();
        },
        completeAll() {},
      },
      invocationRecordStore: {
        create() {
          return { outcome: 'created', invocationId: 'inv-windowed-action-replay' };
        },
        update(id, data) {
          return { id, ...data };
        },
      },
      router: {
        async *routeExecution(_userId, content, _threadId, _messageId, targetCats, _intent, options) {
          providerStarts += 1;
          providerContents.push(content);
          for (const catId of targetCats) {
            assert.equal(await options.beforeOutputCommit(catId), true);
            yield { type: 'done', catId, timestamp: Date.now() };
          }
        },
        async ackCollectedCursors() {},
      },
      log: { info() {}, warn() {}, error() {} },
    });

    const execution = await queueProcessor.executeEntry(processing);

    assert.equal(execution.status, 'succeeded');
    assert.equal(providerStarts, 1, 'the complete durable carrier executes exactly once');
    assert.deepEqual(providerContents, ['first handoff\nsecond handoff']);
  });

  test('F264 restores a coalesced Queue carrier when durable receipt initialization fails', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const invocationQueue = new InvocationQueue();
    const existing = invocationQueue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-target',
      userId: 'user-1',
      content: 'first handoff',
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
      a2aParentInvocationId: 'parent-source',
      a2aTriggerMessageId: 'message-first',
    }).entry;
    invocationQueue.backfillMessageId('thread-target', 'user-1', existing.id, 'message-first');
    const before = invocationQueue.getEntrySnapshot('thread-target', 'user-1', existing.id);
    const messageStore = new MessageStore();
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'second handoff',
      mentions: ['codex'],
      timestamp: 210,
      threadId: 'thread-target',
      deliveryStatus: 'queued',
      extra: {
        crossPost: {
          sourceThreadId: 'thread-source',
          sourceInvocationId: 'parent-source',
          effectClass: 'coordinate',
        },
      },
    });
    messageStore.initializeQueueCustody(triggerMessage.id, {
      version: 1,
      entryId: 'conflicting-custody',
      revision: 1,
      intent: 'execute',
      status: 'queued',
      allTargetCats: ['codex'],
      pendingTargetCats: ['codex'],
      notifiedByCatIds: [],
      seenByCatIds: [],
      seenInvocationIdByCatId: {},
      failedByCatIds: [],
      handledByCatIds: [],
      priority: 'normal',
      createdAt: 210,
      updatedAt: 210,
    });

    await assert.rejects(
      enqueueA2ATargets(
        {
          router: { async *routeExecution() {} },
          invocationRecordStore: { create() {}, update() {} },
          socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
          messageStore,
          queueProcessor: { onInvocationComplete() {}, tryAutoExecute() {} },
          invocationQueue,
          log: { info() {}, warn() {}, error() {} },
        },
        {
          targetCats: ['codex'],
          content: 'second handoff',
          userId: 'user-1',
          threadId: 'thread-target',
          triggerMessage,
          callerCatId: 'opus',
          parentInvocationId: 'parent-source',
        },
      ),
      /custody identity mismatch/,
    );

    assert.deepEqual(invocationQueue.getEntrySnapshot('thread-target', 'user-1', existing.id), before);
  });

  test('F264 persists a distinct failed receipt when no cross-thread target is admitted', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const invocationQueue = new InvocationQueue();
    for (let index = 0; index < 10; index += 1) {
      invocationQueue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-target',
        userId: 'user-1',
        content: `existing-${index}`,
        source: 'agent',
        sourceCategory: 'a2a',
        targetCats: [`cat-${index}`],
        intent: 'execute',
      });
    }
    const messageStore = new MessageStore();
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'terminal release',
      mentions: ['codex'],
      timestamp: 300,
      threadId: 'thread-target',
      deliveryStatus: 'queued',
      extra: {
        crossPost: {
          sourceThreadId: 'thread-source',
          sourceInvocationId: 'parent-source',
          effectClass: 'coordinate',
        },
      },
    });
    const userEvents = [];

    const result = await enqueueA2ATargets(
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: {
          broadcastAgentMessage() {},
          broadcastToRoom() {},
          emitToUser(userId, event, data) {
            userEvents.push({ userId, event, data });
          },
        },
        messageStore,
        queueProcessor: { onInvocationComplete() {}, tryAutoExecute() {} },
        invocationQueue,
        log: { info() {}, warn() {}, error() {} },
      },
      {
        targetCats: ['codex'],
        content: 'terminal release',
        userId: 'user-1',
        threadId: 'thread-target',
        triggerMessage,
        callerCatId: 'opus',
        parentInvocationId: 'parent-source',
      },
    );

    assert.deepEqual(result.enqueued, []);
    const stored = messageStore.getById(triggerMessage.id);
    assert.equal(stored.queueCustody.status, 'terminal');
    assert.deepEqual(stored.queueCustody.pendingTargetCats, []);
    assert.deepEqual(stored.queueCustody.failedByCatIds, ['codex']);
    const receipt = userEvents.find((event) => event.event === 'messages_queued').data.messages[0].extra.queueReceipt;
    assert.deepEqual(receipt.targets, [
      {
        catId: 'codex',
        state: 'failed',
        retryable: false,
        attempts: [
          {
            id: `cross-thread:${triggerMessage.id}:codex:1`,
            targetCatId: 'codex',
            sequence: 1,
            state: 'failed',
            terminalReason: 'invocation_failed',
            createdAt: triggerMessage.timestamp,
            updatedAt: triggerMessage.timestamp,
          },
        ],
      },
    ]);
  });

  test('F264 rejects an idempotent-looking empty carrier receipt for a different requested target', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const invocationQueue = new InvocationQueue();
    for (let index = 0; index < 10; index += 1) {
      invocationQueue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-target',
        userId: 'user-1',
        content: `existing-${index}`,
        source: 'agent',
        sourceCategory: 'a2a',
        targetCats: [`cat-${index}`],
        intent: 'execute',
      });
    }
    const messageStore = new MessageStore();
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'terminal release',
      mentions: ['codex'],
      timestamp: 320,
      threadId: 'thread-target',
      deliveryStatus: 'queued',
      extra: {
        crossPost: {
          sourceThreadId: 'thread-source',
          sourceInvocationId: 'parent-source',
          effectClass: 'coordinate',
        },
      },
    });
    messageStore.initializeQueueCustody(triggerMessage.id, {
      version: 1,
      entryId: `cross-thread:${triggerMessage.id}`,
      revision: 1,
      receiptScope: 'cross_thread_delivery',
      carrierByTargetCatId: {},
      intent: 'execute',
      status: 'terminal',
      allTargetCats: ['opus'],
      pendingTargetCats: [],
      notifiedByCatIds: [],
      seenByCatIds: [],
      seenInvocationIdByCatId: {},
      failedByCatIds: ['opus'],
      handledByCatIds: [],
      priority: 'normal',
      createdAt: 320,
      updatedAt: 320,
    });

    await assert.rejects(
      enqueueA2ATargets(
        {
          router: { async *routeExecution() {} },
          invocationRecordStore: { create() {}, update() {} },
          socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
          messageStore,
          queueProcessor: { onInvocationComplete() {}, tryAutoExecute() {} },
          invocationQueue,
          log: { info() {}, warn() {}, error() {} },
        },
        {
          targetCats: ['codex'],
          content: 'terminal release',
          userId: 'user-1',
          threadId: 'thread-target',
          triggerMessage,
          callerCatId: 'opus',
          parentInvocationId: 'parent-source',
        },
      ),
      /custody identity mismatch/,
    );
  });
});
