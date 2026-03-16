// @ts-check

import assert from 'node:assert';
import { beforeEach, describe, it } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
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
 */
function mockRouter(opts = {}) {
  const calls =
    /** @type {Array<{userId: string, message: string, threadId: string, userMessageId: string, targetCats: string[], intent: object}>} */ ([]);
  const ackCalls = /** @type {Array<{userId: string, threadId: string}>} */ ([]);

  return {
    calls,
    ackCalls,
    /** @type {any} */
    router: {
      async *routeExecution(userId, message, threadId, userMessageId, targetCats, intent, options) {
        calls.push({ userId, message, threadId, userMessageId, targetCats, intent });

        if (opts.throwError) throw opts.throwError;

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
        return { outcome: 'created', invocationId: `inv-${createCounter}` };
      },
      async update(id, data) {
        beforeUpdate?.();
        updates.push({ id, data });
      },
      async getByIdempotencyKey(_threadId, _userId, _key) {
        return null;
      },
    },
    /** Force next create to return duplicate */
    setDuplicate() {
      duplicateOnCreate = true;
    },
    setBeforeCreate(cb) {
      beforeCreate = cb;
    },
    setBeforeUpdate(cb) {
      beforeUpdate = cb;
    },
  };
}

function mockInvocationTracker() {
  const starts = /** @type {Array<{threadId: string, catId: string}>} */ ([]);
  const completes = /** @type {Array<{threadId: string, catId: string}>} */ ([]);
  const cancelCalls = /** @type {Array<{threadId: string, catId: string, userId: (string|undefined)}>} */ ([]);
  let aborted = false;
  let cancelDenied = false;
  /** @type {Map<string, string>} key = "threadId:catId" or "threadId" for legacy */
  const activeSlots = new Map();

  return {
    starts,
    completes,
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
      complete(threadId, catId, _controller) {
        completes.push({ threadId, catId });
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
    return new ConnectorInvokeTrigger({
      router: routerMock.router,
      socketManager: socketMock.manager,
      invocationRecordStore: recordMock.store,
      invocationTracker: trackerMock.tracker,
      invocationQueue: queue,
      log: noopLog(),
      ...overrides,
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

  it('broadcasts agent messages to WebSocket room', async () => {
    const trigger = createTrigger();
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Review msg', 'msg-1');
    await waitForTrigger();

    // Should have broadcast text + done messages
    const agentBroadcasts = socketMock.broadcasts.filter((b) => b.threadId === 'thread-1');
    assert.ok(agentBroadcasts.length >= 2, `Expected at least 2 broadcasts, got ${agentBroadcasts.length}`);
    assert.strictEqual(agentBroadcasts[0].msg.type, 'text');
    assert.strictEqual(agentBroadcasts[1].msg.type, 'done');

    // Should have broadcast intent_mode
    const intentBroadcast = socketMock.roomBroadcasts.find((b) => b.event === 'intent_mode');
    assert.ok(intentBroadcast, 'Should broadcast intent_mode');
    assert.strictEqual(intentBroadcast.data.mode, 'execute');
  });

  it('updates InvocationRecord through lifecycle: userMessageId → running → succeeded', async () => {
    const trigger = createTrigger();
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
    await waitForTrigger();

    // Check update sequence
    const updates = recordMock.updates;
    assert.ok(updates.length >= 3, `Expected at least 3 updates, got ${updates.length}`);

    // First update: backfill userMessageId
    assert.strictEqual(updates[0].data.userMessageId, 'msg-1');

    // Second update: status running
    assert.strictEqual(updates[1].data.status, 'running');

    // Last update: status succeeded
    const lastUpdate = updates[updates.length - 1];
    assert.strictEqual(lastUpdate.data.status, 'succeeded');
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

    assert.strictEqual(trackerMock.starts.length, 1);
    assert.strictEqual(trackerMock.completes.length, 1);
    assert.strictEqual(trackerMock.completes[0].threadId, 'thread-1');
  });

  it('skips duplicate invocations', async () => {
    recordMock.setDuplicate();
    const trigger = createTrigger();
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
    await waitForTrigger();

    // Should not call routeExecution
    assert.strictEqual(routerMock.calls.length, 0);
    // Should not start tracker
    assert.strictEqual(trackerMock.starts.length, 0);
  });

  it('cancels when thread is being deleted (aborted signal)', async () => {
    trackerMock.setAborted(true);
    const trigger = createTrigger();
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
    await waitForTrigger();

    // Should not call routeExecution
    assert.strictEqual(routerMock.calls.length, 0);

    // Should update status to canceled
    const cancelUpdate = recordMock.updates.find((u) => u.data.status === 'canceled');
    assert.ok(cancelUpdate, 'Should set status to canceled');
  });

  it('handles routeExecution errors gracefully', async () => {
    routerMock = mockRouter({ throwError: new Error('CLI crashed') });
    const trigger = createTrigger({ router: routerMock.router });
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
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
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
    await waitForTrigger();

    // Should NOT start tracker (create failed before start)
    assert.strictEqual(trackerMock.starts.length, 0);
    // Should NOT call routeExecution
    assert.strictEqual(routerMock.calls.length, 0);
    // No unhandledRejection = test process survives
  });

  it('R1-P1 regression: userMessageId backfill throws → tracker completes, status=failed', async () => {
    let updateCallCount = 0;
    recordMock.store.update = async (id, data) => {
      updateCallCount++;
      // First update is userMessageId backfill → throw
      if (updateCallCount === 1 && data.userMessageId) {
        throw new Error('backfill boom');
      }
      recordMock.updates.push({ id, data });
    };

    const trigger = createTrigger();
    trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
    await waitForTrigger();

    // Tracker must have been started AND completed (no leak)
    assert.strictEqual(trackerMock.starts.length, 1, 'tracker should start');
    assert.strictEqual(trackerMock.completes.length, 1, 'tracker must complete even on backfill error');

    // Should NOT call routeExecution (error happened before)
    assert.strictEqual(routerMock.calls.length, 0);
  });

  // ── F39 Phase C: Queue mode tests ──

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

    it('preempts active invocation for urgent connector triggers', async () => {
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

      // Should execute directly instead of queueing
      assert.strictEqual(routerMock.calls.length, 1, 'Should execute immediately for urgent connector');
      assert.strictEqual(recordMock.creates.length, 1, 'Should create invocation record');
      assert.strictEqual(queue.list('thread-1', 'user-1').length, 0, 'Should not enqueue urgent connector');

      // Should attempt to cancel active invocation owned by same user
      assert.strictEqual(trackerMock.cancelCalls.length, 1, 'Should call invocationTracker.cancel');
      assert.deepStrictEqual(trackerMock.cancelCalls[0], { threadId: 'thread-1', catId: 'opus', userId: 'user-1' });
    });

    it('clears queue pause before urgent preempt replacement execution', async () => {
      trackerMock.setActive('thread-1', 'user-1');
      const clearPauseCalls = /** @type {Array<{threadId: string, catId: string}>} */ ([]);
      const mockQueueProcessor = /** @type {any} */ ({
        clearPause(threadId, catId) {
          clearPauseCalls.push({ threadId, catId });
        },
        async onInvocationComplete() {},
      });
      const trigger = createTrigger({ queueProcessor: mockQueueProcessor });
      trigger.trigger(
        'thread-1',
        /** @type {any} */ ('opus'),
        'user-1',
        'Urgent review msg',
        'msg-urgent-clear-pause',
        undefined,
        { priority: 'urgent', reason: 'github_review' },
      );
      await waitForTrigger();

      assert.strictEqual(routerMock.calls.length, 1, 'Should execute urgent replacement');
      assert.deepStrictEqual(
        clearPauseCalls,
        [{ threadId: 'thread-1', catId: 'opus' }],
        'Should clear stale pause before replacement execution',
      );
    });

    it('does not preempt when urgent cancel is denied (owner mismatch)', async () => {
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

      // owner mismatch should enqueue without attempting cancel
      assert.strictEqual(trackerMock.cancelCalls.length, 0, 'Should not call cancel when active owner differs');
      assert.strictEqual(routerMock.calls.length, 0, 'Should not execute when cancel denied');

      const entries = queue.list('thread-1', 'user-2');
      assert.strictEqual(entries.length, 1, 'Should enqueue urgent connector when cancel denied');
      assert.strictEqual(entries[0].messageId, 'msg-urgent-2');
    });

    it('skips urgent preempt when create returns duplicate idempotency key', async () => {
      trackerMock.setActive('thread-1', 'user-1');
      recordMock.setDuplicate();
      const trigger = createTrigger();
      trigger.trigger(
        'thread-1',
        /** @type {any} */ ('opus'),
        'user-1',
        'Urgent duplicate review msg',
        'msg-dup-1',
        undefined,
        {
          priority: 'urgent',
          reason: 'github_review',
        },
      );
      await waitForTrigger();

      // Existing invocation should remain untouched.
      assert.strictEqual(trackerMock.cancelCalls.length, 0, 'Should not cancel active invocation on duplicate');
      assert.strictEqual(routerMock.calls.length, 0, 'Should not execute duplicate urgent connector');
      assert.strictEqual(recordMock.creates.length, 1, 'Should only perform create duplicate check');
      assert.strictEqual(queue.list('thread-1', 'user-1').length, 0, 'Should not enqueue duplicate urgent connector');
    });

    it('does not cancel winner invocation when duplicate urgent trigger races', async () => {
      trackerMock.setActive('thread-1', 'user-1');
      let createCallCount = 0;
      /** @type {() => void} */
      let releaseFirstCreate;
      const firstCreatePending = new Promise((resolve) => {
        releaseFirstCreate = resolve;
      });

      recordMock.store.create = async (input) => {
        recordMock.creates.push(input);
        createCallCount++;
        if (createCallCount === 1) {
          await firstCreatePending;
          return { outcome: 'created', invocationId: 'inv-1' };
        }
        return { outcome: 'duplicate', invocationId: 'inv-1' };
      };

      const trigger = createTrigger();
      trigger.trigger(
        'thread-1',
        /** @type {any} */ ('opus'),
        'user-1',
        'Urgent duplicate race',
        'msg-dup-race',
        undefined,
        {
          priority: 'urgent',
          reason: 'github_review',
        },
      );

      // Let first trigger enter create() await, then send duplicate.
      await Promise.resolve();
      trigger.trigger(
        'thread-1',
        /** @type {any} */ ('opus'),
        'user-1',
        'Urgent duplicate race',
        'msg-dup-race',
        undefined,
        {
          priority: 'urgent',
          reason: 'github_review',
        },
      );

      await waitForTrigger();
      assert.strictEqual(trackerMock.cancelCalls.length, 0, 'Duplicate trigger must not cancel before winner resolves');

      releaseFirstCreate();
      await waitForTrigger();

      assert.strictEqual(recordMock.creates.length, 2, 'Both urgent triggers should attempt create');
      assert.strictEqual(trackerMock.cancelCalls.length, 1, 'Only create winner should cancel active invocation');
      assert.strictEqual(routerMock.calls.length, 1, 'Only winner should execute');
      assert.strictEqual(queue.list('thread-1', 'user-1').length, 0, 'Duplicate should not enqueue');
    });

    it('falls through to direct execution when active invocation ends before urgent fallback', async () => {
      trackerMock.setActive('thread-1', 'user-1');
      recordMock.setBeforeCreate(() => {
        // Simulate race: active invocation completes while urgent path awaits create.
        trackerMock.clearActive('thread-1');
      });
      const trigger = createTrigger();
      trigger.trigger(
        'thread-1',
        /** @type {any} */ ('opus'),
        'user-1',
        'Urgent review after race',
        'msg-urgent-race',
        undefined,
        { priority: 'urgent', reason: 'github_review' },
      );
      await waitForTrigger();

      assert.strictEqual(routerMock.calls.length, 1, 'Should execute directly when thread no longer active');
      assert.strictEqual(recordMock.creates.length, 1, 'Should create invocation record');
      assert.strictEqual(queue.list('thread-1', 'user-1').length, 0, 'Should not enqueue when thread is idle');
    });

    it('enqueues fallback before awaited update to avoid urgent queue race', async () => {
      trackerMock.setActive('thread-1', 'user-1');
      trackerMock.setCancelDenied(true);
      recordMock.setBeforeUpdate(() => {
        // Simulate race: active invocation ends while urgent fallback awaits status update.
        trackerMock.clearActive('thread-1');
      });
      const trigger = createTrigger();
      trigger.trigger(
        'thread-1',
        /** @type {any} */ ('opus'),
        'user-1',
        'Urgent review fallback race',
        'msg-urgent-fallback-race',
        undefined,
        { priority: 'urgent', reason: 'github_review' },
      );
      await waitForTrigger();

      assert.strictEqual(trackerMock.cancelCalls.length, 1, 'Should attempt cancel once');
      assert.strictEqual(routerMock.calls.length, 0, 'Should not execute fallback inline while cancel denied');
      assert.strictEqual(
        queue.list('thread-1', 'user-1').length,
        1,
        'Fallback entry should already be enqueued before awaited update',
      );
      const canceledUpdates = recordMock.updates.filter((update) => update.data.status === 'canceled');
      assert.strictEqual(
        canceledUpdates.length,
        1,
        'Fallback invocation should be marked canceled after queue handoff',
      );
    });

    it('falls back to direct execution when urgent fallback queue is full', async () => {
      trackerMock.setActive('thread-1', 'user-1');
      trackerMock.setCancelDenied(true);
      const trigger = createTrigger();

      // Fill queue to MAX_QUEUE_DEPTH with non-mergeable entries.
      const cats = ['codex', 'opus', 'codex', 'opus', 'codex'];
      for (let i = 0; i < 5; i++) {
        trigger.trigger('thread-1', /** @type {any} */ (cats[i]), 'user-1', `prefill ${i}`, `msg-prefill-${i}`);
        await waitForTrigger();
      }

      trigger.trigger(
        'thread-1',
        /** @type {any} */ ('opus'),
        'user-1',
        'Urgent when queue full',
        'msg-urgent-full',
        undefined,
        {
          priority: 'urgent',
          reason: 'github_review',
        },
      );
      await waitForTrigger();

      assert.strictEqual(trackerMock.cancelCalls.length, 1, 'Should attempt cancel once');
      assert.strictEqual(routerMock.calls.length, 1, 'Should execute directly when fallback enqueue is full');
      assert.strictEqual(
        queue.list('thread-1', 'user-1').length,
        5,
        'Queue should remain full without fallback enqueue',
      );
      const canceledFallback = recordMock.updates.filter(
        (update) => update.data.status === 'canceled' && update.data.error === 'urgent preempt fallback to queue',
      );
      assert.strictEqual(canceledFallback.length, 0, 'Direct fallback must not mark invocation canceled');
    });

    it('does not execute urgent fallback on queue-full owner-mismatch race', async () => {
      trackerMock.setActive('thread-1', 'user-1');
      // Fill user-1 queue to full so urgent fallback enqueue returns full.
      const cats = ['codex', 'opus', 'codex', 'opus', 'codex'];
      for (let i = 0; i < 5; i++) {
        queue.enqueue({
          threadId: 'thread-1',
          userId: 'user-1',
          content: `prefill ${i}`,
          source: 'connector',
          targetCats: [/** @type {any} */ (cats[i])],
          intent: 'execute',
        });
      }
      // Race: owner changes after initial getUserId() but before cancel().
      recordMock.setBeforeCreate(() => {
        trackerMock.setActive('thread-1', 'owner-user');
      });

      const trigger = createTrigger();
      trigger.trigger(
        'thread-1',
        /** @type {any} */ ('opus'),
        'user-1',
        'Urgent owner mismatch + queue full',
        'msg-urgent-owner-race',
        undefined,
        { priority: 'urgent', reason: 'github_review' },
      );
      await waitForTrigger();

      assert.strictEqual(trackerMock.cancelCalls.length, 1, 'Should attempt cancel once');
      assert.strictEqual(routerMock.calls.length, 0, 'Must not execute when queue is full and owner changed');
      const failedUpdates = recordMock.updates.filter(
        (update) =>
          update.data.status === 'failed' && update.data.error === 'urgent fallback queue full with owner mismatch',
      );
      assert.strictEqual(failedUpdates.length, 1, 'Should mark provisional invocation as failed');
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

    it('merges consecutive connector messages from same source', async () => {
      trackerMock.setActive('thread-1');
      const trigger = createTrigger();

      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'First review', 'msg-1');
      await waitForTrigger();
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'Second review', 'msg-2');
      await waitForTrigger();

      const entries = queue.list('thread-1', 'user-1');
      assert.strictEqual(entries.length, 1, 'Should merge into one entry');
      assert.ok(entries[0].content.includes('First review'));
      assert.ok(entries[0].content.includes('Second review'));
      assert.strictEqual(entries[0].messageId, 'msg-1');
      assert.deepStrictEqual(entries[0].mergedMessageIds, ['msg-2']);
    });

    it('emits queue_full_warning when queue is full', async () => {
      trackerMock.setActive('thread-1');
      const trigger = createTrigger();

      // Fill the queue (5 entries = MAX_QUEUE_DEPTH)
      // Use different targetCats to prevent merge
      const cats = ['opus', 'codex', 'opus', 'codex', 'opus'];
      for (let i = 0; i < 5; i++) {
        trigger.trigger('thread-1', /** @type {any} */ (cats[i]), 'user-1', `msg ${i}`, `msg-${i}`);
        await waitForTrigger();
      }

      // 6th message should trigger full warning
      trigger.trigger('thread-1', /** @type {any} */ ('codex'), 'user-1', 'overflow msg', 'msg-overflow');
      await waitForTrigger();

      const fullWarning = socketMock.userEmits.find((e) => e.event === 'queue_full_warning');
      assert.ok(fullWarning, 'Should emit queue_full_warning');
      assert.strictEqual(fullWarning.data.source, 'connector');

      // Should NOT have emitted queue_updated for the overflow
      const lastUpdate = socketMock.userEmits.filter((e) => e.event === 'queue_updated');
      // 5 successful enqueues = 5 queue_updated events (but not 6)
      assert.strictEqual(lastUpdate.length, 5);
    });

    it('P1 fix: direct execution calls queueProcessor.onInvocationComplete on success', async () => {
      // Codex cloud review P1: connector direct execution doesn't notify QueueProcessor,
      // so queued follow-ups stall forever. This test verifies the fix.
      const qpCalls = /** @type {Array<{threadId: string, catId: string, status: string}>} */ ([]);
      const mockQueueProcessor = /** @type {any} */ ({
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

    it('P1 fix: direct execution calls queueProcessor.onInvocationComplete on failure', async () => {
      const qpCalls = /** @type {Array<{threadId: string, catId: string, status: string}>} */ ([]);
      const mockQueueProcessor = /** @type {any} */ ({
        async onInvocationComplete(threadId, catId, status) {
          qpCalls.push({ threadId, catId, status });
        },
      });

      routerMock = mockRouter({ throwError: new Error('boom') });
      const trigger = createTrigger({ router: routerMock.router, queueProcessor: mockQueueProcessor });
      trigger.trigger('thread-1', /** @type {any} */ ('opus'), 'user-1', 'msg', 'msg-1');
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
});
