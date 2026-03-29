/**
 * Unit tests for callback-a2a-trigger.ts (F27 rewrite)
 *
 * F27: callback A2A now pushes to parent worklist instead of spawning
 * independent invocations. triggerA2AInvocation is kept as fallback only.
 */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

describe('triggerA2AInvocation (fallback path)', () => {
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
      complete() {},
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
      complete() {},
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
      complete() {},
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
      complete() {},
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
    const mockQueueProcessor = {
      async onInvocationComplete(threadId, catId, status) {
        completions.push({ threadId, catId, status });
      },
    };

    const mockInvocationRecordStore = {
      create() {
        return { outcome: 'created', invocationId: 'inv-q1' };
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
      complete() {},
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
      complete() {},
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
      complete() {},
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
      complete() {},
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
      complete() {},
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
      complete() {},
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
      complete() {},
    };

    let routeCalled = 0;
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
  });
});

// ── F122B: A2A enqueue to InvocationQueue ──
describe('enqueueA2ATargets F122B (InvocationQueue path)', () => {
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
      appendMergedMessageId() {},
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
          complete() {},
        },
        queueProcessor: mockQueueProcessor,
        invocationQueue: mockInvocationQueue,
        log: { info() {}, warn() {}, error() {} },
      },
      {
        targetCats: ['opus'],
        content: 'A2A handoff message',
        userId: 'system',
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
          complete() {},
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

  test('deduplicates — skips targets already queued as agent entries', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');

    const enqueueCalls = [];
    const mockInvocationQueue = {
      enqueue(input) {
        enqueueCalls.push(input);
        return { outcome: 'enqueued', entry: { id: 'q-1', ...input } };
      },
      countAgentEntriesForThread() {
        return 0;
      },
      // opus already has a queued agent entry
      hasQueuedAgentForCat(_threadId, catId) {
        return catId === 'opus';
      },
      backfillMessageId() {},
      appendMergedMessageId() {},
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
          complete() {},
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
        content: 'A2A handoff',
        userId: 'system',
        threadId: 't1',
        triggerMessage: { id: 'msg-dup', mentions: ['opus', 'codex'], content: 'test' },
        callerCatId: 'gemini',
      },
    );

    // opus should be skipped (already queued), codex should enqueue
    assert.equal(enqueueCalls.length, 1, 'should only enqueue non-duplicate cat');
    assert.equal(enqueueCalls[0].targetCats[0], 'codex');
    assert.deepEqual(result.enqueued, ['codex']);
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
      appendMergedMessageId() {},
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
          complete() {},
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
          complete() {},
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
});
