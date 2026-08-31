/** Canonical Queue-path tests for callback A2A dispatch. */

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

function canonicalTestMessageInput(input) {
  const { catId, lifecycle: legacyLifecycle, ...rest } = input;
  const { from: lifecycleFrom, ...lifecycle } = legacyLifecycle ?? {};
  const from =
    input.from ??
    lifecycleFrom ??
    (catId === 'system'
      ? { kind: 'system', service: input.source?.connector ?? 'callback-a2a-test' }
      : input.extra?.pluginMessage?.instanceId
        ? { kind: 'plugin', instanceId: input.extra.pluginMessage.instanceId }
        : catId
          ? { kind: 'agent', catId }
          : input.userId === 'system' || input.userId === 'scheduler'
            ? { kind: 'system', service: input.source?.connector ?? 'callback-a2a-test' }
            : input.source
              ? {
                  kind: 'external',
                  connectorId: input.source.connector,
                  ...(input.source.sender ? { sender: input.source.sender } : {}),
                }
              : { kind: 'user', userId: input.userId });
  return {
    ...rest,
    from,
    ...(legacyLifecycle ? { lifecycle } : {}),
  };
}

function adaptMessageStore(store) {
  const append = store.append.bind(store);
  const appendWithQueueCustodyAdmission = store.appendWithQueueCustodyAdmission?.bind(store);
  store.append = (input) => append(canonicalTestMessageInput(input));
  if (appendWithQueueCustodyAdmission) {
    store.appendWithQueueCustodyAdmission = (input, buildAdmission) =>
      appendWithQueueCustodyAdmission(canonicalTestMessageInput(input), buildAdmission);
  }
  return store;
}

function canonicalTestQueueInput(input) {
  if (input.from) return input;
  const { source = 'user', callerCatId, senderMeta, ...rest } = input;
  const from =
    source === 'agent'
      ? { kind: 'agent', catId: callerCatId ?? 'opus' }
      : source === 'connector'
        ? {
            kind: 'external',
            connectorId: senderMeta?.connector ?? 'callback-a2a-test',
            ...(senderMeta?.id
              ? { sender: { id: senderMeta.id, ...(senderMeta.name ? { name: senderMeta.name } : {}) } }
              : {}),
          }
        : source === 'system'
          ? { kind: 'system', service: 'callback-a2a-test' }
          : { kind: 'user', userId: input.userId };
  return { ...rest, from };
}

function adaptInvocationQueue(queue) {
  const enqueue = queue.enqueue.bind(queue);
  queue.enqueue = (input) => enqueue(canonicalTestQueueInput(input));
  return queue;
}

async function enqueueDurableA2ATargets(enqueueA2ATargets, deps, opts) {
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  const messageStore = deps.messageStore ?? adaptMessageStore(new MessageStore());
  let triggerMessage = await messageStore.getById?.(opts.triggerMessage.id);
  if (!triggerMessage) {
    triggerMessage = messageStore.append({
      userId: opts.userId,
      threadId: opts.threadId,
      from: { kind: 'agent', catId: opts.triggerMessage.catId ?? opts.callerCatId ?? 'opus' },
      content: opts.triggerMessage.content,
      mentions: opts.triggerMessage.mentions,
      timestamp: opts.triggerMessage.timestamp ?? 100,
      ...(opts.triggerMessage.extra ? { extra: opts.triggerMessage.extra } : {}),
    });
    triggerMessage.id = opts.triggerMessage.id;
  }
  const rawQueue = deps.invocationQueue;
  const snapshots = new Map();
  const normalizeEntry = (entry, input = {}) => {
    if (!entry) return null;
    const targetCats = entry.targetCats ?? input.targetCats ?? [];
    return {
      kind: 'message_wake',
      threadId: opts.threadId,
      userId: opts.userId,
      ownerAuthProvenance: opts.ownerAuthProvenance ?? 'unknown',
      content: opts.content,
      messageId: triggerMessage.id,
      mergedMessageIds: [],
      from: input.from ?? triggerMessage.from ?? { kind: 'agent', catId: opts.callerCatId ?? 'opus' },
      sourceCategory: 'a2a',
      targetCats,
      allTargetCats: targetCats,
      intent: 'execute',
      status: 'queued',
      createdAt: opts.triggerMessage.timestamp ?? 100,
      autoExecute: true,
      priority: 'normal',
      ...input,
      ...entry,
    };
  };
  const invocationQueue = {
    ...rawQueue,
    countAgentEntriesForThread(...args) {
      return rawQueue.countAgentEntriesForThread(...args);
    },
    list(...args) {
      return rawQueue
        .list(...args)
        .map((entry) => normalizeEntry(entry))
        .filter(Boolean);
    },
    commitQueueCustodyAdmission(...args) {
      return rawQueue.commitQueueCustodyAdmission?.(...args) ?? true;
    },
    rollbackEnqueue(...args) {
      return rawQueue.rollbackEnqueue?.(...args) ?? true;
    },
    restoreEntrySnapshotIfUnchanged(...args) {
      return rawQueue.restoreEntrySnapshotIfUnchanged?.(...args) ?? true;
    },
    restoreDurableEntry(...args) {
      return rawQueue.restoreDurableEntry?.(...args);
    },
    removeProcessed(...args) {
      return rawQueue.removeProcessed?.(...args) ?? null;
    },
    backfillMessageId(...args) {
      return rawQueue.backfillMessageId?.(...args);
    },
    enqueue(input) {
      const result = rawQueue.enqueue(input);
      const entry = normalizeEntry(result.entry, input);
      if (entry) snapshots.set(entry.id, entry);
      return { ...result, ...(entry ? { entry } : {}) };
    },
    findInFlightAgentEntry(...args) {
      const entry = normalizeEntry(rawQueue.findInFlightAgentEntry?.(...args));
      if (entry) snapshots.set(entry.id, entry);
      return entry;
    },
    coalesceContentIntoQueuedAgent(...args) {
      const merged = rawQueue.coalesceContentIntoQueuedAgent?.(...args) ?? false;
      if (merged) {
        const entry = snapshots.get(args[2]);
        if (entry) snapshots.set(entry.id, { ...entry, content: args[3] });
      }
      return merged;
    },
    getEntrySnapshot(threadId, userId, entryId) {
      return rawQueue.getEntrySnapshot?.(threadId, userId, entryId) ?? snapshots.get(entryId) ?? null;
    },
  };
  return enqueueA2ATargets(
    { ...deps, invocationQueue, messageStore },
    { ...opts, triggerMessage: { ...triggerMessage, ...opts.triggerMessage, id: triggerMessage.id } },
  );
}

describe('enqueueA2ATargets F122B (InvocationQueue path)', () => {
  test('completes one response bubble and publishes its durable wake without copying Agent speech', async () => {
    const [{ commitCompletedResponseAndEnqueueA2ATargets }, { InvocationQueue }, { MessageStore }] = await Promise.all([
      import('../dist/routes/callback-a2a-trigger.js'),
      import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js'),
      import('../dist/domains/cats/services/stores/ports/MessageStore.js'),
    ]);
    const messageStore = adaptMessageStore(new MessageStore());
    const invocationQueue = adaptInvocationQueue(new InvocationQueue());
    const response = messageStore.append({
      userId: 'owner-1',
      threadId: 'thread-completed-wake',
      catId: 'opus',
      content: '',
      mentions: [],
      timestamp: 100,
      lifecycle: {
        kind: 'response',
        orderKey: '0000000000100:response-1',
        from: { kind: 'agent', catId: 'opus' },
        invocationId: 'invocation-1',
        targetId: 'opus',
        inputEntryIds: ['entry-1'],
        inputMessageIds: ['message-1'],
        status: 'processing',
        startedAt: 100,
      },
    });
    const drainCalls = [];

    const stored = await commitCompletedResponseAndEnqueueA2ATargets(
      {
        socketManager: { broadcastAgentMessage() {}, emitToUser() {} },
        messageStore,
        invocationQueue,
        queueProcessor: { requestDrain: async (threadId) => drainCalls.push(threadId) },
        log: { info() {}, warn() {}, error() {} },
      },
      {
        responseMessageId: response.id,
        invocationId: 'invocation-1',
        terminal: { status: 'completed', completedAt: 200 },
        message: {
          userId: 'owner-1',
          threadId: 'thread-completed-wake',
          catId: 'opus',
          content: '@codex review this',
          mentions: ['codex'],
          timestamp: 200,
          origin: 'stream',
        },
        targetCats: ['codex'],
        userId: 'owner-1',
        ownerAuthProvenance: 'strict',
        threadId: 'thread-completed-wake',
        callerCatId: 'opus',
        parentInvocationId: 'invocation-1',
      },
    );

    assert.equal(stored.id, response.id);
    assert.equal(stored.lifecycle.status, 'completed');
    assert.deepEqual(stored.lifecycle.dispatchRefs, [{ targetId: 'codex', phase: 'assigned' }]);
    assert.equal(
      messageStore.getByThread('thread-completed-wake', 10, 'owner-1').length,
      1,
      'the terminal response remains the only Agent speech bubble',
    );
    const entries = invocationQueue.list('thread-completed-wake', 'owner-1');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].kind, 'message_wake');
    assert.equal(entries[0].messageId, response.id);
    assert.deepEqual(entries[0].targetCats, ['codex']);
    assert.deepEqual(drainCalls, ['thread-completed-wake']);
    assert.equal(messageStore.getById(response.id).queueCustody.status, 'queued');
  });

  test('blocks the fourth short A↔B wake from durable causal history after each route worklist was rebuilt', async () => {
    const [{ commitCompletedResponseAndEnqueueA2ATargets }, { InvocationQueue }, { MessageStore }] = await Promise.all([
      import('../dist/routes/callback-a2a-trigger.js'),
      import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js'),
      import('../dist/domains/cats/services/stores/ports/MessageStore.js'),
    ]);
    const messageStore = adaptMessageStore(new MessageStore());
    const invocationQueue = adaptInvocationQueue(new InvocationQueue());
    const threadId = 'thread-durable-pingpong';
    const user = messageStore.append({
      userId: 'owner-1',
      threadId,
      catId: null,
      content: 'start',
      mentions: ['opus'],
      timestamp: 1,
    });
    const appendCompletedResponse = (catId, invocationId, triggerMessageId, timestamp) =>
      messageStore.append({
        userId: 'owner-1',
        threadId,
        catId,
        content: 'next',
        mentions: [],
        timestamp,
        extra: { causal: { kind: 'invocation_reply', triggerMessageId } },
        lifecycle: {
          kind: 'response',
          orderKey: `${timestamp}:${invocationId}`,
          from: { kind: 'agent', catId },
          invocationId,
          targetId: catId,
          inputEntryIds: [`entry-${invocationId}`],
          inputMessageIds: [triggerMessageId],
          status: 'completed',
          startedAt: timestamp,
          completedAt: timestamp,
        },
      });
    const opus1 = appendCompletedResponse('opus', 'inv-opus-1', user.id, 10);
    const codex1 = appendCompletedResponse('codex', 'inv-codex-1', opus1.id, 20);
    const opus2 = appendCompletedResponse('opus', 'inv-opus-2', codex1.id, 30);
    const current = messageStore.append({
      userId: 'owner-1',
      threadId,
      catId: 'codex',
      content: '',
      mentions: [],
      timestamp: 40,
      lifecycle: {
        kind: 'response',
        orderKey: '40:inv-codex-2',
        from: { kind: 'agent', catId: 'codex' },
        invocationId: 'inv-codex-2',
        targetId: 'codex',
        inputEntryIds: ['entry-inv-codex-2'],
        inputMessageIds: [opus2.id],
        status: 'processing',
        startedAt: 40,
      },
    });
    const broadcasts = [];

    const stored = await commitCompletedResponseAndEnqueueA2ATargets(
      {
        socketManager: {
          broadcastAgentMessage(message) {
            broadcasts.push(message);
          },
          emitToUser() {},
        },
        messageStore,
        invocationQueue,
        queueProcessor: { async requestDrain() {} },
        log: { info() {}, warn() {}, error() {} },
      },
      {
        responseMessageId: current.id,
        invocationId: 'inv-codex-2',
        terminal: { status: 'completed', completedAt: 50 },
        message: {
          userId: 'owner-1',
          threadId,
          catId: 'codex',
          content: '@opus next',
          mentions: ['opus'],
          timestamp: 50,
          origin: 'stream',
          extra: { causal: { kind: 'invocation_reply', triggerMessageId: opus2.id } },
        },
        targetCats: ['opus'],
        userId: 'owner-1',
        ownerAuthProvenance: 'strict',
        threadId,
        callerCatId: 'codex',
        parentInvocationId: 'parent-codex-2',
      },
    );

    assert.equal(stored.lifecycle.status, 'completed');
    assert.equal(stored.lifecycle.dispatchRefs, undefined);
    assert.equal(invocationQueue.list(threadId, 'owner-1').length, 0);
    assert.equal(broadcasts.length, 1);
    assert.match(broadcasts[0].content, /a2a_pingpong_terminated/);
    assert.match(broadcasts[0].content, /"pairCount":4/);
  });

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

    const result = await enqueueDurableA2ATargets(
      enqueueA2ATargets,
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        queueProcessor: {
          onInvocationComplete() {},
          async requestDrain() {
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

  test('keeps an accepted single-recipient wake admitted when custody shadow write rejects', async () => {
    const [{ enqueueA2ATargets }, { MessageDeliveryService }] = await Promise.all([
      import('../dist/routes/callback-a2a-trigger.js'),
      import('../dist/domains/cats/services/agents/invocation/MessageDeliveryService.js'),
    ]);

    const queueEntries = [];
    const autoExecuteCalls = [];
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
        async requestDrain(threadId) {
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
      messageId: 'stored-message',
      threadId: 'thread-shadow-failure',
      log,
      enqueueA2A: () =>
        enqueueDurableA2ATargets(enqueueA2ATargets, deps, {
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
      enqueueFailureMessage: 'enqueue failed',
    });

    assert.equal(result.enqueueFailed, false);
    assert.deepEqual(result.enqueued, ['opus']);
    assert.equal(queueEntries.length, 1, 'the child must be accepted exactly once');
    assert.deepEqual(autoExecuteCalls, ['thread-shadow-failure']);
    assert.equal(warnCalls.length, 1, 'the shadow write gap must remain observable');
    assert.equal(errorCalls.length, 0, 'the accepted queue path must not be reported as enqueue failure');
  });

  test('enqueues to InvocationQueue with an agent MessageFrom when invocationQueue dep is provided', async () => {
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
    const drainCalls = [];
    const mockQueueProcessor = {
      onInvocationComplete() {},
      requestDrain(threadId) {
        drainCalls.push(threadId);
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

    const result = await enqueueDurableA2ATargets(
      enqueueA2ATargets,
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
    assert.deepEqual(enqueueCalls[0].from, { kind: 'agent', catId: 'codex' });
    assert.equal(enqueueCalls[0].autoExecute, true);
    assert.equal(enqueueCalls[0].source, undefined);
    assert.equal(enqueueCalls[0].callerCatId, undefined);
    assert.equal(enqueueCalls[0].ownerAuthProvenance, 'strict');
    assert.equal(enqueueCalls[0].a2aTriggerMessageId, 'msg-trigger');
    assert.equal(enqueueCalls[0].targetCats[0], 'opus');
    assert.equal(drainCalls.length, 1, 'should signal requestDrain');
    const queueUpdated = emitCalls.find((c) => c.event === 'queue_updated');
    assert.ok(queueUpdated, 'should emit queue_updated after enqueue');
    assert.equal(queueUpdated.userId, 'system');
    assert.equal(queueUpdated.data.action, 'enqueued');
    assert.equal(queueUpdated.data.threadId, 't1');
    assert.deepEqual(result.enqueued, ['opus']);
    assert.equal('fallback' in result, false);
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
    const result = await enqueueDurableA2ATargets(
      enqueueA2ATargets,
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
          requestDrain() {
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
          ? {
              id: 'q-existing',
              userId: 'system',
              status: 'queued',
              from: { kind: 'agent', catId: 'codex' },
              targetCats: ['opus'],
            }
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
    const result = await enqueueDurableA2ATargets(
      enqueueA2ATargets,
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
          requestDrain() {
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
    assert.equal(findCalls.length, 2, 'durable planning and carrier staging must use the same owner identity');
    assert.ok(
      findCalls.every(
        (call) =>
          call.callerCatId === 'gemini' &&
          call.parentInvocationId === 'parent-strict' &&
          call.ownerAuthProvenance === 'strict',
      ),
    );
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
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    let depth = 9; // one slot left
    const enqueueCalls = [];
    const lifecycleEvents = [];
    const messageStore = adaptMessageStore(new MessageStore());
    const triggerMessage = messageStore.append({
      userId: 'system',
      threadId: 't1',
      catId: 'gemini',
      content: 'multi-target near limit',
      mentions: ['opus', 'codex'],
      timestamp: 100,
    });
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
    const result = await enqueueDurableA2ATargets(
      enqueueA2ATargets,
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: {
          broadcastAgentMessage() {},
          broadcastToRoom() {},
          emitToUser(_userId, event, payload) {
            lifecycleEvents.push({ event, payload });
          },
        },
        messageStore,
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
          requestDrain() {
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
        triggerMessage,
        callerCatId: 'gemini',
      },
    );

    // depth starts at 9, first enqueue (opus) brings it to 10, second (codex) should be rejected
    assert.equal(enqueueCalls.length, 1, 'should enqueue only first target before hitting limit');
    assert.equal(enqueueCalls[0].targetCats[0], 'opus');
    assert.deepEqual(result.enqueued, ['opus']);
    const stored = messageStore.getById(triggerMessage.id);
    const failure = messageStore
      .getByThread('t1', 10, 'system')
      .find((message) => message.lifecycle?.kind === 'delivery_failure');
    assert.ok(failure, 'the rejected target must have one durable failure status');
    assert.deepEqual(stored.queueCustody.pendingTargetCats, ['opus']);
    assert.deepEqual(stored.queueCustody.failedByCatIds, ['codex']);
    assert.deepEqual(stored.lifecycle.dispatchRefs, [
      { targetId: 'opus', phase: 'assigned' },
      { targetId: 'codex', phase: 'settled', statusMessageId: failure.id },
    ]);
    assert.deepEqual(failure.lifecycle.requestedTargets, ['codex']);
    assert.equal(stored.deliveryStatus, undefined, 'partial rejection must not hide accepted public Agent speech');
    assert.equal(
      lifecycleEvents.filter(({ event }) => event === 'message_lifecycle_updated').length,
      2,
      'source settlement and failure status must both be projected',
    );
  });

  test('binds triggerMessage.id during Queue admission (AC-B6-P1)', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');

    const enqueueCalls = [];
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
      appendMergedMessageId() {},
      list() {
        return [];
      },
    };
    await enqueueDurableA2ATargets(
      enqueueA2ATargets,
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
          requestDrain() {
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

    assert.equal(enqueueCalls.length, 1);
    assert.equal(enqueueCalls[0].kind, 'message_wake');
    assert.equal(enqueueCalls[0].messageId, 'msg-trigger-123');
  });

  test('PR7 initializes same-thread A2A custody before prompt exposure', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { QueueProcessor } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');
    const { QueuedMessageCustodyCoordinator } = await import(
      '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const invocationQueue = adaptInvocationQueue(new InvocationQueue());
    const messageStore = adaptMessageStore(new MessageStore());
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
    });
    let promptBoundaryReached = false;

    const result = await enqueueDurableA2ATargets(
      enqueueA2ATargets,
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
          async requestDrain() {
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

    const invocationQueue = adaptInvocationQueue(new InvocationQueue());
    const messageStore = adaptMessageStore(new MessageStore());
    const existing = invocationQueue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-target',
      userId: 'user-1',
      kind: 'message_wake',
      content: 'existing codex carrier',
      messageId: 'message-existing',
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
      a2aParentInvocationId: 'parent-same-thread',
      a2aTriggerMessageId: 'message-existing',
    }).entry;
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'fan out to both targets',
      mentions: ['codex', 'codex-terra'],
      timestamp: 200,
      threadId: 'thread-target',
    });
    let custodyAtAutoExecute;

    const result = await enqueueDurableA2ATargets(
      enqueueA2ATargets,
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        messageStore,
        queueProcessor: {
          onInvocationComplete() {},
          requestDrain() {
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

    const invocationQueue = adaptInvocationQueue(new InvocationQueue());
    const messageStore = adaptMessageStore(new MessageStore());
    const existingByCat = new Map();
    for (const catId of ['codex', 'codex-terra']) {
      const entry = invocationQueue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-target',
        userId: 'user-1',
        kind: 'message_wake',
        content: `existing ${catId} carrier`,
        messageId: `message-existing-${catId}`,
        source: 'agent',
        sourceCategory: 'a2a',
        targetCats: [catId],
        intent: 'execute',
        autoExecute: true,
        callerCatId: 'opus',
        a2aParentInvocationId: 'parent-same-thread',
        a2aTriggerMessageId: `message-existing-${catId}`,
      }).entry;
      existingByCat.set(catId, entry);
    }
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'coalesce both targets',
      mentions: ['codex', 'codex-terra'],
      timestamp: 300,
      threadId: 'thread-target',
    });
    let custodyAtAutoExecute;

    const result = await enqueueDurableA2ATargets(
      enqueueA2ATargets,
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        messageStore,
        queueProcessor: {
          onInvocationComplete() {},
          requestDrain() {
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

    const invocationQueue = adaptInvocationQueue(new InvocationQueue());
    const messageStore = adaptMessageStore(new MessageStore());
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
        async resolveExplicitTargets(targetCats) {
          return [...targetCats];
        },
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
      kind: 'message_wake',
      content: 'existing codex carrier',
      messageId: 'message-existing-codex',
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
      a2aParentInvocationId: 'parent-same-thread',
      a2aTriggerMessageId: 'message-existing-codex',
    }).entry;
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'fan out under a competing scheduler',
      mentions: ['codex', 'codex-terra'],
      timestamp: 350,
      threadId: 'thread-target',
    });

    const admission = enqueueDurableA2ATargets(
      enqueueA2ATargets,
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
    await queueProcessor.requestDrain('thread-target');
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

    const invocationQueue = adaptInvocationQueue(new InvocationQueue());
    const messageStore = adaptMessageStore(new MessageStore());
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
        async resolveExplicitTargets(targetCats) {
          return [...targetCats];
        },
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
    const realRequestDrain = queueProcessor.requestDrain.bind(queueProcessor);
    let autoExecuteEntrants = 0;
    let releaseAutoExecute;
    const autoExecuteGate = new Promise((resolve) => {
      releaseAutoExecute = resolve;
    });
    queueProcessor.requestDrain = async (threadId) => {
      autoExecuteEntrants += 1;
      if (autoExecuteEntrants === 2) releaseAutoExecute();
      if (autoExecuteEntrants === 1) setTimeout(releaseAutoExecute, 25);
      await autoExecuteGate;
      return realRequestDrain(threadId);
    };

    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'same durable source must execute once',
      mentions: ['codex'],
      timestamp: 365,
      threadId: 'thread-same-source-reentry',
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
    const recoverSameSource = async () => {
      return MessageDeliveryService.resolveCallbackDeliveryDecision({
        canEnqueueA2A: true,
        messageId: triggerMessage.id,
        threadId: triggerMessage.threadId,
        log: deps.log,
        enqueueA2A: () => enqueueDurableA2ATargets(enqueueA2ATargets, deps, opts),
        enqueueFailureMessage: 'same-source recovery failed',
      });
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

    const invocationQueue = adaptInvocationQueue(new InvocationQueue());
    const messageStore = adaptMessageStore(new MessageStore());
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'restart projection gap must still execute once',
      mentions: ['codex'],
      timestamp: 370,
      threadId: 'thread-restart-projection-gap',
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
    messageStore.scanByActiveQueueCustody = () =>
      messageStore.getById(triggerMessage.id)?.queueCustodyAdmission ? [triggerMessage.id] : [];

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
      queueProcessor: { async requestDrain() {} },
      log: { info() {}, warn() {}, error() {} },
    };
    const decision = await MessageDeliveryService.resolveCallbackDeliveryDecision({
      canEnqueueA2A: true,
      messageId: triggerMessage.id,
      threadId: triggerMessage.threadId,
      log: callbackDeps.log,
      enqueueA2A: () =>
        enqueueDurableA2ATargets(enqueueA2ATargets, callbackDeps, {
          targetCats: ['codex'],
          content: triggerMessage.content,
          userId: 'user-1',
          ownerAuthProvenance: 'unknown',
          threadId: triggerMessage.threadId,
          triggerMessage,
          callerCatId: 'opus',
          parentInvocationId: 'parent-restart-projection-gap',
        }),
      enqueueFailureMessage: 'restart projection join failed',
    });

    releaseProjectionGap();
    await startupRun;

    const canonicalEntryId = `queue-custody:${triggerMessage.id}:codex`;
    const projectedEntries = invocationQueue.list(triggerMessage.threadId, 'user-1');
    assert.equal(decision.enqueueFailed, false, 'same-source callback must join committed custody');
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
        async resolveExplicitTargets(targetCats) {
          return [...targetCats];
        },
        async *routeExecution(_userId, content, _threadId, _messageId, targetCats) {
          providerStarts += 1;
          providerContents.push(content);
          for (const catId of targetCats) yield { type: 'done', catId, timestamp: Date.now() };
        },
        async ackCollectedCursors() {},
      },
      log: { info() {}, warn() {}, error() {} },
    });
    await queueProcessor.requestDrain(triggerMessage.threadId);
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
    const messageStore = adaptMessageStore(new MessageStore());
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'terminal action must stay fenced after restart',
      mentions: ['codex'],
      timestamp: 372,
      threadId: 'thread-action-restart',
      extra: {
        crossPost: {
          sourceThreadId: 'thread-action-source',
          sourceInvocationId: 'parent-action-restart',
          effectClass: 'assign_work',
        },
      },
    });
    messageStore.scanByActiveQueueCustody = () => {
      const message = messageStore.getById(triggerMessage.id);
      return message?.queueCustody || message?.queueCustodyAdmission ? [triggerMessage.id] : [];
    };

    const beforeRestartQueue = adaptInvocationQueue(new InvocationQueue());
    const admission = await enqueueDurableA2ATargets(
      enqueueA2ATargets,
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        messageStore,
        invocationQueue: beforeRestartQueue,
        queueProcessor: { async requestDrain() {} },
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

    const restartedQueue = adaptInvocationQueue(new InvocationQueue());
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

    const crashedQueue = adaptInvocationQueue(new InvocationQueue());
    const messageStore = adaptMessageStore(new MessageStore());
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
    });
    messageStore.scanByActiveQueueCustody = () => {
      const message = messageStore.getById(triggerMessage.id);
      return message?.queueCustody || message?.queueCustodyAdmission ? [triggerMessage.id] : [];
    };

    const interruptedAdmission = enqueueDurableA2ATargets(
      enqueueA2ATargets,
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        messageStore,
        invocationQueue: crashedQueue,
        queueProcessor: { async requestDrain() {} },
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

    const restartedQueue = adaptInvocationQueue(new InvocationQueue());
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
    assert.equal(recoveredMessage.deliveryStatus, undefined, 'restart must preserve already-public Agent speech');
    assert.deepEqual(recoveredMessage.queueCustody?.pendingTargetCats, ['codex', 'codex-terra']);

    releaseFirstCustodyCas();
    await interruptedAdmission.catch(() => {});
  });

  test('PR7 restart never revives a target rejected before the first custody CAS', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { StartupReconciler } = await import('../dist/domains/cats/services/agents/invocation/StartupReconciler.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const crashedQueue = adaptInvocationQueue(new InvocationQueue());
    for (let index = 0; index < 10; index += 1) {
      crashedQueue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-depth-rejection',
        userId: 'user-1',
        kind: 'message_wake',
        content: `existing pending A2A ${index}`,
        messageId: `message-existing-${index}`,
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

    const messageStore = adaptMessageStore(new MessageStore());
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
    });
    messageStore.scanByActiveQueueCustody = () => {
      const message = messageStore.getById(triggerMessage.id);
      return message?.queueCustody || message?.queueCustodyAdmission ? [triggerMessage.id] : [];
    };

    const interruptedAdmission = enqueueDurableA2ATargets(
      enqueueA2ATargets,
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        messageStore,
        invocationQueue: crashedQueue,
        queueProcessor: { async requestDrain() {} },
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

    const restartedQueue = adaptInvocationQueue(new InvocationQueue());
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

    const invocationQueue = adaptInvocationQueue(new InvocationQueue());
    const messageStore = adaptMessageStore(new MessageStore());
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'same-thread custody collision',
      mentions: ['codex'],
      timestamp: 400,
      threadId: 'thread-target',
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
      enqueueDurableA2ATargets(
        enqueueA2ATargets,
        {
          router: { async *routeExecution() {} },
          invocationRecordStore: { create() {}, update() {} },
          socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
          messageStore,
          queueProcessor: {
            onInvocationComplete() {},
            requestDrain() {
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

    const invocationQueue = adaptInvocationQueue(new InvocationQueue());
    const messageStore = adaptMessageStore(new MessageStore());
    const userEvents = [];
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'terminal release',
      mentions: ['codex', 'codex-terra'],
      timestamp: 100,
      threadId: 'thread-target',
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
    const result = await enqueueDurableA2ATargets(
      enqueueA2ATargets,
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
          requestDrain() {
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
            threadId: 'thread-target',
            userId: 'user-1',
            sourceCategory: 'a2a',
            a2aParentInvocationId: 'parent-source',
            a2aTriggerMessageId: triggerMessage.id,
            autoExecute: true,
            createdAt: entry.createdAt,
          },
        ]),
      ),
    );
    assert.equal(
      userEvents.some((event) => event.event === 'messages_queued'),
      false,
      'pre-admission Queue custody must not be projected into History',
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
    const { MessageStore, commitLifecycleResponseFromAppendInput } = await import(
      '../dist/domains/cats/services/stores/ports/MessageStore.js'
    );

    const threadId = 'thread-direct-active-cross-thread';
    const targetCatId = 'codex-sol';
    const invocationQueue = adaptInvocationQueue(new InvocationQueue());
    const invocationTracker = new InvocationTracker();
    const invocationRecordStore = new InvocationRecordStore();
    const messageStore = adaptMessageStore(new MessageStore());
    const queueCustodyCoordinator = new QueuedMessageCustodyCoordinator({ messageStore });
    const socketManager = { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} };
    const processorErrors = [];
    let providerStarts = 0;
    const queueProcessor = new QueueProcessor({
      queue: invocationQueue,
      invocationTracker,
      invocationRecordStore,
      messageStore,
      queueCustodyCoordinator,
      socketManager,
      router: {
        async resolveExplicitTargets(targetCats) {
          return [...targetCats];
        },
        async *routeExecution(userId, _content, routedThreadId, _messageId, targetCats, _intent, options) {
          providerStarts += 1;
          const startedAt = Date.now();
          const lifecycleAdmission = await options.onLifecycleInvocationStarted({
            threadId: routedThreadId,
            userId,
            catId: targetCats[0],
            invocationId: 'inv-queued-successor',
            parentInvocationId: options.parentInvocationId,
            startedAt,
          });
          await options.onPromptMessagesExposed({
            threadId: routedThreadId,
            userId,
            catId: targetCats[0],
            invocationId: 'inv-queued-successor',
            messageIds: options.persistedPromptMessageIds,
            seenAt: Date.now(),
          });
          await commitLifecycleResponseFromAppendInput(
            messageStore,
            lifecycleAdmission.responseMessageId,
            'inv-queued-successor',
            { status: 'completed', completedAt: startedAt + 1 },
            {
              userId,
              threadId: routedThreadId,
              catId: targetCats[0],
              content: 'queued successor complete',
              mentions: [],
              origin: 'stream',
              timestamp: startedAt + 1,
            },
          );
          yield {
            type: 'done',
            catId: targetCats[0],
            invocationId: 'inv-queued-successor',
            timestamp: Date.now(),
          };
        },
        async ackCollectedCursors() {},
      },
      log: {
        info() {},
        warn() {},
        error(...args) {
          processorErrors.push(args);
        },
      },
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
      extra: {
        crossPost: {
          sourceThreadId: 'thread-source',
          sourceInvocationId: 'inv-source',
          effectClass: 'coordinate',
        },
      },
    });

    await enqueueDurableA2ATargets(
      enqueueA2ATargets,
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
    assert.equal(
      messageStore.getById(triggerMessage.id).deliveryStatus,
      undefined,
      'public Agent speech must not be hidden while its wake waits for a free target slot',
    );

    invocationTracker.completeAll(threadId, [targetCatId], directController);
    await queueProcessor.onInvocationComplete(threadId, targetCatId, 'succeeded', 'inv-direct-active', [targetCatId]);
    for (
      let attempt = 0;
      attempt < 50 && messageStore.getById(triggerMessage.id)?.queueCustody?.status !== 'terminal';
      attempt++
    ) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(providerStarts, 1, 'the durable carrier must start once when the direct slot becomes idle');
    assert.deepEqual(invocationQueue.list(threadId, 'user-1'), []);
    const terminal = messageStore.getById(triggerMessage.id);
    assert.equal(terminal.deliveryStatus, undefined, 'wake settlement must not mutate public Agent visibility');
    assert.deepEqual(processorErrors, [], 'queue execution must not swallow a lifecycle settlement failure');
    assert.equal(terminal.queueCustody.status, 'terminal');
    assert.deepEqual(terminal.queueCustody.handledByCatIds, [targetCatId]);
  });

  test('F264 rejects a mismatched existing cross-thread custody before auto-execution', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const invocationQueue = adaptInvocationQueue(new InvocationQueue());
    const messageStore = adaptMessageStore(new MessageStore());
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'terminal release',
      mentions: ['codex'],
      timestamp: 100,
      threadId: 'thread-target',
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
      enqueueDurableA2ATargets(
        enqueueA2ATargets,
        {
          router: { async *routeExecution() {} },
          invocationRecordStore: { create() {}, update() {} },
          socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
          messageStore,
          queueProcessor: {
            onInvocationComplete() {},
            requestDrain() {
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

    const invocationQueue = adaptInvocationQueue(new InvocationQueue());
    const messageStore = adaptMessageStore(new MessageStore());
    const existing = invocationQueue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-target',
      userId: 'user-1',
      kind: 'message_wake',
      content: 'first handoff',
      messageId: 'message-first',
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
      a2aParentInvocationId: 'parent-source',
      a2aTriggerMessageId: 'message-first',
    }).entry;
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'second handoff',
      mentions: ['codex'],
      timestamp: 200,
      threadId: 'thread-target',
      extra: {
        crossPost: {
          sourceThreadId: 'thread-source',
          sourceInvocationId: 'parent-source',
          effectClass: 'coordinate',
        },
      },
    });
    let custodyAtAutoExecute;

    const result = await enqueueDurableA2ATargets(
      enqueueA2ATargets,
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        messageStore,
        queueProcessor: {
          onInvocationComplete() {},
          requestDrain() {
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

    const admissionQueue = adaptInvocationQueue(new InvocationQueue());
    const enqueueCarrier = (catId, triggerMessageId) =>
      admissionQueue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-target',
        userId: 'user-1',
        kind: 'message_wake',
        content: 'first handoff',
        messageId: triggerMessageId,
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
    const messageStore = adaptMessageStore(new MessageStore({ maxMessages: 3_000 }));
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
      extra: { crossPost },
    });
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
      });
      assert.equal(
        messageStore.getById(newerMessage.id)?.deliveryStatus,
        undefined,
        'newer Agent speech is public without a queued-to-delivered compatibility transition',
      );
    }

    const replayQueue = adaptInvocationQueue(new InvocationQueue());
    const result = await enqueueDurableA2ATargets(
      enqueueA2ATargets,
      {
        router: { async *routeExecution() {} },
        invocationRecordStore: { create() {}, update() {} },
        socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
        messageStore,
        queueProcessor: {
          onInvocationComplete() {},
          requestDrain() {
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

    const invocationQueue = adaptInvocationQueue(new InvocationQueue());
    const existing = invocationQueue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-target',
      userId: 'user-1',
      kind: 'message_wake',
      content: 'first handoff',
      messageId: 'message-first',
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
      a2aParentInvocationId: 'parent-source',
      a2aTriggerMessageId: 'message-first',
    }).entry;
    const before = invocationQueue.getEntrySnapshot('thread-target', 'user-1', existing.id);
    const messageStore = adaptMessageStore(new MessageStore());
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'second handoff',
      mentions: ['codex'],
      timestamp: 210,
      threadId: 'thread-target',
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
      enqueueDurableA2ATargets(
        enqueueA2ATargets,
        {
          router: { async *routeExecution() {} },
          invocationRecordStore: { create() {}, update() {} },
          socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
          messageStore,
          queueProcessor: { onInvocationComplete() {}, requestDrain() {} },
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

  test('F264 settles the public source lifecycle when no cross-thread target is admitted', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const invocationQueue = adaptInvocationQueue(new InvocationQueue());
    for (let index = 0; index < 10; index += 1) {
      invocationQueue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-target',
        userId: 'user-1',
        kind: 'message_wake',
        content: `existing-${index}`,
        messageId: `message-existing-${index}`,
        source: 'agent',
        sourceCategory: 'a2a',
        targetCats: [`cat-${index}`],
        intent: 'execute',
      });
    }
    const messageStore = adaptMessageStore(new MessageStore());
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'terminal release',
      mentions: ['codex'],
      timestamp: 300,
      threadId: 'thread-target',
      extra: {
        crossPost: {
          sourceThreadId: 'thread-source',
          sourceInvocationId: 'parent-source',
          effectClass: 'coordinate',
        },
      },
    });
    const userEvents = [];

    const result = await enqueueDurableA2ATargets(
      enqueueA2ATargets,
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
        queueProcessor: { onInvocationComplete() {}, requestDrain() {} },
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
    const failure = messageStore
      .getByThread('thread-target', 10, 'system')
      .find((message) => message.lifecycle?.kind === 'delivery_failure');
    assert.ok(failure, 'policy rejection must publish one durable lifecycle failure');
    assert.equal(stored.deliveryStatus, undefined, 'public Agent speech remains visible after wake rejection');
    assert.equal(stored.queueCustody, undefined, 'terminal wake custody must not remain as a second truth source');
    assert.equal(stored.queueCustodyAdmission, undefined);
    assert.deepEqual(stored.lifecycle.dispatchRefs, [
      { targetId: 'codex', phase: 'settled', statusMessageId: failure.id },
    ]);
    assert.deepEqual(failure.lifecycle.requestedTargets, ['codex']);
    assert.equal(failure.lifecycle.inputMessageId, triggerMessage.id);
    assert.equal(
      userEvents.some((event) => event.event === 'messages_queued'),
      false,
      'a terminal pre-admission failure must not manufacture a History projection',
    );
    assert.equal(
      userEvents.filter((event) => event.event === 'message_lifecycle_updated').length,
      2,
      'source settlement and failure status must both reach the frontend',
    );
  });

  test('F264 rejects an idempotent-looking empty carrier receipt for a different requested target', async () => {
    const { enqueueA2ATargets } = await import('../dist/routes/callback-a2a-trigger.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');

    const invocationQueue = adaptInvocationQueue(new InvocationQueue());
    for (let index = 0; index < 10; index += 1) {
      invocationQueue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-target',
        userId: 'user-1',
        kind: 'message_wake',
        content: `existing-${index}`,
        messageId: `message-existing-${index}`,
        source: 'agent',
        sourceCategory: 'a2a',
        targetCats: [`cat-${index}`],
        intent: 'execute',
      });
    }
    const messageStore = adaptMessageStore(new MessageStore());
    const triggerMessage = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'terminal release',
      mentions: ['codex'],
      timestamp: 320,
      threadId: 'thread-target',
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
      enqueueDurableA2ATargets(
        enqueueA2ATargets,
        {
          router: { async *routeExecution() {} },
          invocationRecordStore: { create() {}, update() {} },
          socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
          messageStore,
          queueProcessor: { onInvocationComplete() {}, requestDrain() {} },
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
