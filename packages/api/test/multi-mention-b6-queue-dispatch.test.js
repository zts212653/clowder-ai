/**
 * B6: multi_mention dispatch via InvocationQueue (F122B)
 *
 * Tests that when invocationQueue + queueProcessor deps are provided,
 * multi-mention dispatches go through the queue path instead of direct
 * routeExecution, and response aggregation works via entryCompleteHook.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';
import {
  InvocationQueue,
  queueEntryTargetCats,
} from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import {
  getMultiMentionOrchestrator,
  resetMultiMentionOrchestrator,
} from '../dist/routes/callback-multi-mention-routes.js';
import {
  adaptInvocationQueue,
  adaptMessageStore,
  appendTestLifecycleResponseSource,
  canonicalTestQueueInput,
} from './helpers/message-from-fixtures.js';

// ── Mocks ──────────────────────────────────────────────────────────────

function createMockRegistry() {
  const records = new Map();
  return {
    register(catId, threadId, userId, overrides = {}) {
      const id = `inv-${records.size}`;
      const token = `tok-${records.size}`;
      records.set(id, {
        catId,
        threadId,
        userId,
        invocationId: id,
        callbackToken: token,
        ownerAuthProvenance: 'strict',
        ...overrides,
      });
      return { invocationId: id, callbackToken: token };
    },
    async verify(invocationId, callbackToken) {
      const r = records.get(invocationId);
      if (!r) return { ok: false, reason: 'unknown_invocation' };
      if (r.callbackToken !== callbackToken) return { ok: false, reason: 'invalid_token' };
      return { ok: true, record: r };
    },
    isLatest: () => true,
    claimClientMessageId: () => true,
  };
}

function createMockSocketManager() {
  const messages = [];
  const roomEvents = [];
  return {
    broadcastAgentMessage(msg, threadId) {
      messages.push({ ...msg, threadId });
    },
    broadcastToRoom(room, event, data) {
      roomEvents.push({ room, event, data });
    },
    emitToUser() {},
    getMessages: () => messages,
    getRoomEvents: () => roomEvents,
  };
}

function createMockMessageStore() {
  const store = adaptMessageStore(new MessageStore());
  const messages = [];
  const append = store.append.bind(store);
  store.append = (msg) => {
    const stored = append(msg);
    messages.push(stored);
    return stored;
  };
  store.getMessages = () => messages;
  return store;
}

function createMockInvocationRecordStore() {
  let counter = 0;
  return {
    create(input) {
      return { outcome: 'created', invocationId: `inv-mm-${counter++}` };
    },
    update() {},
  };
}

function createMockInvocationTracker() {
  return {
    start(threadId, catId, userId, catIds) {
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
}

function createMockRouter() {
  const executions = [];
  return {
    async *routeExecution(userId, message, threadId, userMessageId, targetCats, intent, options) {
      executions.push({ userId, message, threadId, userMessageId, targetCats, intent, options });
      yield { type: 'text', catId: targetCats[0], content: `Response from ${targetCats[0]}`, timestamp: Date.now() };
      yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: Date.now() };
    },
    getExecutions: () => executions,
  };
}

/**
 * Mock QueueProcessor that captures registered hooks and simulates execution.
 */
function createMockQueueProcessor() {
  const hooks = new Map();
  const autoExecuteCalls = [];
  return {
    registerEntryCompleteHook(entryId, hook, targetCatId) {
      const hookId = targetCatId ? `${entryId}:${targetCatId}` : entryId;
      hooks.set(hookId, { entryId, hook, targetCatId });
    },
    unregisterEntryCompleteHook(entryId) {
      if (hooks.delete(entryId)) return;
      for (const [hookId, registration] of hooks) {
        if (registration.entryId === entryId) hooks.delete(hookId);
      }
    },
    requestDrain(threadId) {
      autoExecuteCalls.push(threadId);
      return Promise.resolve();
    },
    getHooks: () => hooks,
    getAutoExecuteCalls: () => autoExecuteCalls,
    simulateComplete(hookId, status, responseText) {
      const registration = hooks.get(hookId);
      if (registration) {
        registration.hook(registration.entryId, status, responseText);
        hooks.delete(hookId);
      }
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('B6: multi_mention queue dispatch', () => {
  let app;
  let mockRegistry, mockSocket, mockMessageStore, mockInvocationRecordStore;
  let mockInvocationTracker, mockRouter;
  let invocationQueue, mockQueueProcessor;
  let actionAdmissionCalls, actionUnavailableCalls, actionReturnedDeliveredCalls, actionAdmissionResult;
  let actionSuccessorAdmissionService;
  let creds;

  beforeEach(async () => {
    resetMultiMentionOrchestrator();
    mockRegistry = createMockRegistry();
    mockSocket = createMockSocketManager();
    mockMessageStore = createMockMessageStore();
    mockInvocationRecordStore = createMockInvocationRecordStore();
    mockInvocationTracker = createMockInvocationTracker();
    mockRouter = createMockRouter();
    invocationQueue = adaptInvocationQueue(new InvocationQueue());
    mockQueueProcessor = createMockQueueProcessor();
    actionAdmissionCalls = [];
    actionUnavailableCalls = [];
    actionReturnedDeliveredCalls = [];
    actionAdmissionResult = {
      admit: true,
      outcome: 'claimed',
      lease: { leaseId: 'lease-action-1', generation: 1 },
      fence: { leaseId: 'lease-action-1', generation: 1, dispatchId: 'multi-mention:action-req-1' },
    };
    actionSuccessorAdmissionService = {
      async admit(input) {
        actionAdmissionCalls.push(input);
        return actionAdmissionResult;
      },
      async markUnavailable(input) {
        actionUnavailableCalls.push(input);
      },
      async markReturnedDelivered(input) {
        actionReturnedDeliveredCalls.push(input);
      },
    };
    creds = mockRegistry.register('opus', 'thread-1', 'user-1');
    appendTestLifecycleResponseSource(mockMessageStore, creds);

    app = Fastify({ logger: false });
    registerCallbackAuthHook(app, mockRegistry);
    const { registerMultiMentionRoutes } = await import('../dist/routes/callback-multi-mention-routes.js');
    registerMultiMentionRoutes(app, {
      registry: mockRegistry,
      messageStore: mockMessageStore,
      socketManager: mockSocket,
      router: mockRouter,
      invocationRecordStore: mockInvocationRecordStore,
      invocationTracker: mockInvocationTracker,
      invocationQueue,
      queueProcessor: mockQueueProcessor,
      actionSuccessorAdmissionService,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  test('enqueues targets via InvocationQueue instead of direct dispatch', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'What do you think?',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.ok(body.requestId);

    // Router should NOT have been called directly (queue path used)
    assert.equal(mockRouter.getExecutions().length, 0);

    // The thread drain should have been signaled.
    assert.ok(mockQueueProcessor.getAutoExecuteCalls().length > 0);

    // Completion hook should have been registered for the enqueued entry
    assert.ok(mockQueueProcessor.getHooks().size > 0);
    assert.equal(actionAdmissionCalls.length, 0, 'legacy unscoped request must remain backward compatible');
  });

  test('preserves exact cloud source provenance and target lineage in the source Queue carrier', async () => {
    const source = mockMessageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'Ask local and cloud cats to review this exact request',
      mentions: [],
      timestamp: 100,
      threadId: 'thread-1',
      // F117: append() delivery metadata is transition-owned; only 'queued' may be
      // initialized at append time (MessageStore.assertValidAppendDeliveryMetadata).
      // This fixture only needs the source message identity, so omit deliveryStatus.
    });
    creds = mockRegistry.register('opus', 'thread-1', 'user-1', {
      originTriggerMessageId: source.id,
    });
    const callerResponse = appendTestLifecycleResponseSource(mockMessageStore, creds);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex', 'gpt-pro'],
        question: 'Review the exact source',
        context: 'Preserve this original context',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 200, res.body);
    const entries = invocationQueue.list('thread-1', 'user-1');
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.deepEqual(queueEntryTargetCats(entry), ['codex', 'gpt-pro']);
    assert.equal(entry.execution.a2aParentInvocationId, creds.invocationId);
    const dispatchSource = mockMessageStore.getById(entry.payload.sourceRecordId);
    assert.ok(dispatchSource, 'Queue sourceRecordId must resolve to the public multi-mention source');
    assert.equal(dispatchSource.replyTo, callerResponse.id);
    assert.equal(dispatchSource.extra?.causal?.triggerMessageId, callerResponse.id);
    assert.equal(
      dispatchSource.content,
      '[Multi-Mention from opus]\n\nReview the exact source\n\n---\n\nPreserve this original context',
    );
    assert.equal(entry.execution.requiresExactCloudDispatchProvenance, true);
    assert.deepEqual(entry.execution.cloudDispatchProvenance, {
      sourceMessageId: source.id,
      sourceSender: { kind: 'user', id: 'user-1' },
      calledByCatId: 'opus',
      intent: 'Review the exact source\n\n---\n\nPreserve this original context',
    });
  });

  test('rejects caller-visible but cloud-ineligible Queue provenance while local sibling stays independent', async () => {
    const source = mockMessageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'Private source for opus only',
      mentions: [],
      timestamp: 101,
      threadId: 'thread-1',
      // F117: delivery metadata is transition-owned (see sibling fixture above);
      // append() rejects any non-'queued' initialization, so omit deliveryStatus.
      visibility: 'whisper',
      whisperTo: ['opus'],
    });
    creds = mockRegistry.register('opus', 'thread-1', 'user-1', {
      originTriggerMessageId: source.id,
    });
    // F117: seed the lifecycle response source for the re-registered invocation id
    // (same contract as the sibling test above).
    appendTestLifecycleResponseSource(mockMessageStore, creds);

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex', 'gpt-pro'],
        question: 'Do not leak the private source',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 200, res.body);
    const { requestId } = res.json();
    const entries = invocationQueue.list('thread-1', 'user-1');
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.deepEqual(queueEntryTargetCats(entry), ['codex', 'gpt-pro']);
    assert.equal(entry.execution.requiresExactCloudDispatchProvenance, true);
    assert.equal(entry.execution.cloudDispatchProvenance, undefined);
    assert.equal(entry.execution.a2aParentInvocationId, creds.invocationId);

    const orch = getMultiMentionOrchestrator();
    mockQueueProcessor.simulateComplete(
      `${entry.id}:gpt-pro`,
      'succeeded',
      '未发送给 @gpt-pro：精确来源不满足公开回程资格。',
    );
    assert.equal(orch.getStatus(requestId), 'partial');
    mockQueueProcessor.simulateComplete(`${entry.id}:codex`, 'succeeded', 'Local sibling completed');

    assert.equal(orch.getStatus(requestId), 'done');
    const flushMsg = mockMessageStore.getMessages().find((message) => message.content?.includes('Multi-Mention'));
    assert.ok(flushMsg.content.includes('Local sibling completed'));
    assert.ok(flushMsg.content.includes('未发送给 @gpt-pro'));
  });

  test('claims structured action before dispatch and carries the generation fence into QueueEntry', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Can you own merge review?',
        callbackTo: 'opus',
        idempotencyKey: 'action-req-1',
        action: {
          subjectRef: 'pr:owner/repo#2868',
          actionFamily: 'merge',
          successorSlot: 'reviewer',
          mode: 'single',
          terminalPredicate: { kind: 'pr_merged' },
        },
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(actionAdmissionCalls.length, 1);
    assert.equal(actionAdmissionCalls[0].dispatchId, 'multi-mention:action-req-1');
    assert.deepEqual(actionAdmissionCalls[0].holderCatIds, ['codex']);
    assert.deepEqual(res.json().actionLease, {
      leaseId: 'lease-action-1',
      generation: 1,
      outcome: 'claimed',
    });
    const [entry] = invocationQueue.list('thread-1', 'user-1');
    assert.deepEqual(entry.execution.actionSuccessorFence, actionAdmissionResult.fence);
    assert.equal(entry.payload.sourceRecordId, entry.payload.messageId);
  });

  test('confirms a returned generation only after its predecessor is enqueued', async () => {
    actionAdmissionResult = {
      admit: true,
      outcome: 'returned',
      lease: { leaseId: 'lease-action-1', generation: 2 },
      fence: { leaseId: 'lease-action-1', generation: 2, dispatchId: 'multi-mention:return-req-1' },
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Custody returns to you',
        callbackTo: 'opus',
        idempotencyKey: 'return-req-1',
        action: {
          subjectRef: 'pr:owner/repo#2868',
          actionFamily: 'merge',
          successorSlot: 'reviewer',
          mode: 'single',
          terminalPredicate: { kind: 'pr_merged' },
          returnToPredecessor: {
            leaseId: 'lease-action-1',
            expectedGeneration: 1,
            groundingEvidenceRef: 'grounding:mismatch',
          },
        },
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(actionUnavailableCalls.length, 0);
    assert.deepEqual(actionReturnedDeliveredCalls, [
      {
        fence: actionAdmissionResult.fence,
        evidenceRef: 'queue:multi-mention:return-req-1:return_enqueued',
        now: actionReturnedDeliveredCalls[0].now,
      },
    ]);
  });

  test('confirms a replayed return after its predecessor is enqueued', async () => {
    actionAdmissionResult = {
      admit: false,
      outcome: 'replayed',
      lease: { leaseId: 'lease-action-1', generation: 2 },
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Retry custody return',
        callbackTo: 'opus',
        idempotencyKey: 'return-replay-req-1',
        action: {
          subjectRef: 'pr:owner/repo#2868',
          actionFamily: 'merge',
          successorSlot: 'reviewer',
          mode: 'single',
          terminalPredicate: { kind: 'pr_merged' },
          returnToPredecessor: {
            leaseId: 'lease-action-1',
            expectedGeneration: 1,
            groundingEvidenceRef: 'grounding:mismatch',
          },
        },
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(actionUnavailableCalls.length, 0);
    assert.deepEqual(actionReturnedDeliveredCalls, [
      {
        fence: {
          leaseId: 'lease-action-1',
          generation: 2,
          dispatchId: 'multi-mention:return-replay-req-1',
        },
        evidenceRef: 'queue:multi-mention:return-replay-req-1:return_enqueued',
        now: actionReturnedDeliveredCalls[0].now,
      },
    ]);
  });

  test('idempotent replay confirms a return already accepted by the queue', async () => {
    actionAdmissionResult = {
      admit: true,
      outcome: 'returned',
      lease: { leaseId: 'lease-action-1', generation: 2 },
      fence: { leaseId: 'lease-action-1', generation: 2, dispatchId: 'multi-mention:return-idempotent-1' },
    };
    const request = {
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Retry the same custody return',
        callbackTo: 'opus',
        idempotencyKey: 'return-idempotent-1',
        action: {
          subjectRef: 'pr:owner/repo#2868',
          actionFamily: 'merge',
          successorSlot: 'reviewer',
          mode: 'single',
          terminalPredicate: { kind: 'pr_merged' },
          returnToPredecessor: {
            leaseId: 'lease-action-1',
            expectedGeneration: 1,
            groundingEvidenceRef: 'grounding:mismatch',
          },
        },
      },
    };
    const first = await app.inject(request);
    assert.equal(first.statusCode, 200);
    actionReturnedDeliveredCalls.length = 0;
    actionAdmissionResult = {
      admit: false,
      outcome: 'replayed',
      lease: { leaseId: 'lease-action-1', generation: 2 },
    };

    const replay = await app.inject(request);

    assert.equal(replay.statusCode, 200);
    assert.deepEqual(actionReturnedDeliveredCalls, [
      {
        fence: {
          leaseId: 'lease-action-1',
          generation: 2,
          dispatchId: 'multi-mention:return-idempotent-1',
        },
        evidenceRef: 'queue:multi-mention:return-idempotent-1:return_enqueued',
        now: actionReturnedDeliveredCalls[0].now,
      },
    ]);
  });

  test('safe_wait without durable carrier truth fails closed without creating work', async () => {
    actionAdmissionResult = {
      admit: false,
      outcome: 'safe_wait',
      lease: { leaseId: 'lease-existing', generation: 3, holderCatIds: ['codex-terra'] },
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Fallback now?',
        callbackTo: 'opus',
        idempotencyKey: 'action-req-2',
        action: {
          subjectRef: 'pr:owner/repo#2868',
          actionFamily: 'merge',
          successorSlot: 'reviewer',
          mode: 'single',
          terminalPredicate: { kind: 'pr_merged' },
        },
      },
    });

    assert.equal(res.statusCode, 409);
    assert.deepEqual(res.json(), {
      status: 'action_carrier_unavailable',
      reason: 'carrier_missing',
      actionLease: { leaseId: 'lease-existing', generation: 3, holderCatIds: ['codex-terra'] },
    });
    assert.deepEqual(invocationQueue.list('thread-1', 'user-1'), []);
    assert.equal(mockQueueProcessor.getHooks().size, 0);
    assert.equal(mockQueueProcessor.getAutoExecuteCalls().length, 0);
  });

  test('freshness rejection returns invalid_action without creating queue state', async () => {
    actionSuccessorAdmissionService.admit = async (input) => {
      actionAdmissionCalls.push(input);
      throw new Error('action successor freshness rejected: mismatch');
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Implement the current task',
        callbackTo: 'opus',
        idempotencyKey: 'action-stale-head',
        action: {
          subjectRef: 'subject:task:task-2868',
          actionFamily: 'implement',
          successorSlot: 'implementer',
          mode: 'single',
          terminalPredicate: { kind: 'task_done' },
        },
      },
    });

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.json(), {
      status: 'invalid_action',
      error: 'action successor freshness rejected: mismatch',
    });
    assert.equal(actionAdmissionCalls.length, 1);
    assert.deepEqual(invocationQueue.list('thread-1', 'user-1'), []);
    assert.equal(mockQueueProcessor.getHooks().size, 0);
    assert.equal(mockQueueProcessor.getAutoExecuteCalls().length, 0);
  });

  test('parallel rejected ownership records one holder terminal without fan-out', async () => {
    actionAdmissionResult = {
      admit: false,
      outcome: 'parallel_return_unsupported',
      lease: {
        leaseId: 'lease-action-1',
        generation: 1,
        holderCatIds: ['codex', 'opus'],
        holderOutcomes: {
          opus: { outcome: 'rejected_ownership', evidenceRef: 'grounding:mismatch', at: 100 },
        },
      },
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Record my rejection without returning the parallel lease.',
        callbackTo: 'opus',
        idempotencyKey: 'parallel-reject-1',
        action: {
          subjectRef: 'subject:task:task-2868',
          actionFamily: 'implement',
          successorSlot: 'implementer',
          mode: 'parallel',
          terminalPredicate: { kind: 'task_done' },
          parallelIntent: 'independent implementation',
          returnToPredecessor: {
            leaseId: 'lease-action-1',
            expectedGeneration: 1,
            groundingEvidenceRef: 'grounding:mismatch',
          },
        },
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json().status, 'parallel_return_unsupported');
    assert.equal(actionAdmissionCalls.length, 1);
    assert.deepEqual(invocationQueue.list('thread-1', 'user-1'), []);
    assert.equal(mockQueueProcessor.getHooks().size, 0);
  });

  test('action-scoped request requires an idempotency key before admission', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'No replay identity',
        callbackTo: 'opus',
        action: {
          subjectRef: 'pr:owner/repo#2868',
          actionFamily: 'merge',
          successorSlot: 'reviewer',
          mode: 'single',
          terminalPredicate: { kind: 'pr_merged' },
        },
      },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(actionAdmissionCalls.length, 0);
  });

  test('registers entryCompleteHook that records response in orchestrator', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Review this?',
        callbackTo: 'opus',
      },
    });

    const body = res.json();
    const requestId = body.requestId;
    const orch = getMultiMentionOrchestrator();

    // Initially status is running (no responses yet)
    assert.equal(orch.getStatus(requestId), 'running');

    // Simulate queue execution completing with response text
    const hooks = mockQueueProcessor.getHooks();
    assert.equal(hooks.size, 1);
    const [entryId] = hooks.keys();
    mockQueueProcessor.simulateComplete(entryId, 'succeeded', 'I reviewed it, looks good!');

    // After completion, orchestrator should be done (all 1 target responded)
    assert.equal(orch.getStatus(requestId), 'done');
    await new Promise((resolve) => setImmediate(resolve));

    // Result message should have been flushed to message store
    const stored = mockMessageStore.getMessages();
    assert.ok(stored.length > 0);
    const flushMsg = stored.find((m) => m.content?.includes('Multi-Mention'));
    assert.ok(flushMsg, 'Expected a flushed result message');
    assert.ok(flushMsg.content.includes('I reviewed it, looks good!'));
  });

  test('multi-target: hooks fire independently and aggregate', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex', 'gemini'],
        question: 'Thoughts?',
        callbackTo: 'opus',
      },
    });

    const body = res.json();
    const requestId = body.requestId;
    const orch = getMultiMentionOrchestrator();

    // Two hooks should be registered (one per target)
    const hooks = mockQueueProcessor.getHooks();
    assert.equal(hooks.size, 2);

    const entryIds = [...hooks.keys()];

    // Complete first target
    mockQueueProcessor.simulateComplete(entryIds[0], 'succeeded', 'Codex response');
    assert.equal(orch.getStatus(requestId), 'partial');

    // Complete second target
    mockQueueProcessor.simulateComplete(entryIds[1], 'succeeded', 'Gemini response');
    assert.equal(orch.getStatus(requestId), 'done');
    await new Promise((resolve) => setImmediate(resolve));

    // Both responses should be in the flush message
    const stored = mockMessageStore.getMessages();
    const flushMsg = stored.find((m) => m.content?.includes('Multi-Mention'));
    assert.ok(flushMsg);
    assert.ok(flushMsg.content.includes('Codex response'));
    assert.ok(flushMsg.content.includes('Gemini response'));
  });

  test('a cloud provenance failure remains visible while its local sibling settles independently', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex', 'gpt-pro'],
        question: 'Settle independently',
        callbackTo: 'opus',
      },
    });

    const { requestId } = res.json();
    const orch = getMultiMentionOrchestrator();
    const entryIds = [...mockQueueProcessor.getHooks().keys()];
    mockQueueProcessor.simulateComplete(entryIds[1], 'succeeded', '未发送给 @gpt-pro：投递来源或回程绑定不完整。');
    assert.equal(orch.getStatus(requestId), 'partial');
    mockQueueProcessor.simulateComplete(entryIds[0], 'succeeded', 'Local sibling completed');

    assert.equal(orch.getStatus(requestId), 'done');
    const flushMsg = mockMessageStore.getMessages().find((message) => message.content?.includes('Multi-Mention'));
    assert.ok(flushMsg.content.includes('Local sibling completed'));
    assert.ok(flushMsg.content.includes('未发送给 @gpt-pro'));
  });

  test('failed dispatch records failure response', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Something?',
        callbackTo: 'opus',
      },
    });

    const body = res.json();
    const requestId = body.requestId;
    const orch = getMultiMentionOrchestrator();

    const hooks = mockQueueProcessor.getHooks();
    const [entryId] = hooks.keys();
    mockQueueProcessor.simulateComplete(entryId, 'failed', '');

    assert.equal(orch.getStatus(requestId), 'done');
    const result = orch.getResult(requestId);
    assert.ok(result.responses[0].content.includes('[dispatch error]'));
  });

  test('enqueued entries have canonical agent From and autoExecute=true', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Test queue entry fields',
        callbackTo: 'opus',
      },
    });

    // Check the real InvocationQueue entries
    const entries = invocationQueue.listAutoExecute('thread-1');
    assert.ok(entries.length > 0);
    const entry = entries[0];
    assert.deepEqual(entry.from, { kind: 'agent', catId: 'opus' });
    assert.equal(entry.execution.autoExecute, true);
    assert.equal(entry.execution.ownerAuthProvenance, 'strict');
    assert.deepEqual(entry.targets, ['codex']);
    assert.ok(entry.payload.content.includes('[Multi-Mention from opus]'));
    assert.ok(entry.payload.content.includes('Test queue entry fields'));
  });

  test('depth limit prevents excessive enqueue', async () => {
    // Fill the queue with 10 agent entries (MAX_MM_DEPTH)
    for (let i = 0; i < 10; i++) {
      invocationQueue.enqueue(
        canonicalTestQueueInput({
          ownerAuthProvenance: 'unknown',
          threadId: 'thread-1',
          userId: 'user-1',
          kind: 'private_input',
          content: `fill-${i}`,
          source: 'agent',
          targetCats: [`cat-${i}`],
          intent: 'execute',
        }),
      );
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Should be blocked by depth',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 200);
    // No new hooks should be registered (depth limit hit)
    assert.equal(mockQueueProcessor.getHooks().size, 0);
  });

  test('action lease becomes replaceable when queue depth prevents dispatch', async () => {
    for (let i = 0; i < 10; i++) {
      invocationQueue.enqueue(
        canonicalTestQueueInput({
          ownerAuthProvenance: 'unknown',
          threadId: 'thread-1',
          userId: 'user-1',
          kind: 'private_input',
          content: `fill-${i}`,
          source: 'agent',
          targetCats: [`cat-${i}`],
          intent: 'execute',
        }),
      );
    }

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Dispatch must fail closed',
        callbackTo: 'opus',
        idempotencyKey: 'action-req-1',
        action: {
          subjectRef: 'pr:owner/repo#2868',
          actionFamily: 'merge',
          successorSlot: 'reviewer',
          mode: 'single',
          terminalPredicate: { kind: 'pr_merged' },
        },
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(actionUnavailableCalls.length, 1);
    assert.deepEqual(actionUnavailableCalls[0], {
      fence: actionAdmissionResult.fence,
      holderCatIds: ['codex'],
      evidenceRef: 'queue:multi-mention:action-req-1:not_enqueued',
      now: actionUnavailableCalls[0].now,
    });
  });

  test('keeps a failed return delivery pending for recovery instead of changing custody', async () => {
    for (let i = 0; i < 10; i++) {
      invocationQueue.enqueue(
        canonicalTestQueueInput({
          ownerAuthProvenance: 'unknown',
          threadId: 'thread-1',
          userId: 'user-1',
          kind: 'private_input',
          content: `fill-return-${i}`,
          source: 'agent',
          targetCats: [`cat-return-${i}`],
          intent: 'execute',
        }),
      );
    }
    actionAdmissionResult = {
      admit: true,
      outcome: 'returned',
      lease: { leaseId: 'lease-action-1', generation: 2 },
      fence: { leaseId: 'lease-action-1', generation: 2, dispatchId: 'multi-mention:return-req-1' },
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Custody return must retry',
        callbackTo: 'opus',
        idempotencyKey: 'return-req-1',
        action: {
          subjectRef: 'pr:owner/repo#2868',
          actionFamily: 'merge',
          successorSlot: 'reviewer',
          mode: 'single',
          terminalPredicate: { kind: 'pr_merged' },
          returnToPredecessor: {
            leaseId: 'lease-action-1',
            expectedGeneration: 1,
            groundingEvidenceRef: 'grounding:mismatch',
          },
        },
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(actionUnavailableCalls.length, 0);
    assert.equal(actionReturnedDeliveredCalls.length, 0);
  });

  test('keeps a failed replayed return pending for recovery instead of changing custody', async () => {
    for (let i = 0; i < 10; i++) {
      invocationQueue.enqueue(
        canonicalTestQueueInput({
          ownerAuthProvenance: 'unknown',
          threadId: 'thread-1',
          userId: 'user-1',
          kind: 'private_input',
          content: `fill-return-replay-${i}`,
          source: 'agent',
          targetCats: [`cat-return-replay-${i}`],
          intent: 'execute',
        }),
      );
    }
    actionAdmissionResult = {
      admit: false,
      outcome: 'replayed',
      lease: { leaseId: 'lease-action-1', generation: 2 },
    };

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Retry blocked custody return',
        callbackTo: 'opus',
        idempotencyKey: 'return-replay-blocked-1',
        action: {
          subjectRef: 'pr:owner/repo#2868',
          actionFamily: 'merge',
          successorSlot: 'reviewer',
          mode: 'single',
          terminalPredicate: { kind: 'pr_merged' },
          returnToPredecessor: {
            leaseId: 'lease-action-1',
            expectedGeneration: 1,
            groundingEvidenceRef: 'grounding:mismatch',
          },
        },
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(actionUnavailableCalls.length, 0);
    assert.equal(actionReturnedDeliveredCalls.length, 0);
  });

  test('action-scoped dispatch queues behind unrelated work for the same cat', async () => {
    invocationQueue.enqueue(
      canonicalTestQueueInput({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'user-1',
        kind: 'private_input',
        content: 'existing unrelated work',
        source: 'agent',
        targetCats: ['codex'],
        intent: 'execute',
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Queue this action after existing work',
        callbackTo: 'opus',
        idempotencyKey: 'action-req-1',
        action: {
          subjectRef: 'pr:owner/repo#2868',
          actionFamily: 'merge',
          successorSlot: 'reviewer',
          mode: 'single',
          terminalPredicate: { kind: 'pr_merged' },
        },
      },
    });

    assert.equal(res.statusCode, 200);
    assert.equal(invocationQueue.list('thread-1', 'user-1').length, 2);
    assert.equal(mockQueueProcessor.getHooks().size, 1);
    assert.equal(actionUnavailableCalls.length, 0);
  });

  test('action timeout records unavailable proof so fallback does not wait forever', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let fireTimeout;
    globalThis.setTimeout = (callback, delay) => {
      if (delay >= 3 * 60_000) fireTimeout = callback;
      return { unref() {} };
    };
    globalThis.clearTimeout = () => {};

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/multi-mention',
        headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
        payload: {
          targets: ['codex'],
          question: 'Timeout this action',
          callbackTo: 'opus',
          idempotencyKey: 'action-req-1',
          action: {
            subjectRef: 'pr:owner/repo#2868',
            actionFamily: 'merge',
            successorSlot: 'reviewer',
            mode: 'single',
            terminalPredicate: { kind: 'pr_merged' },
          },
        },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(typeof fireTimeout, 'function');

      fireTimeout();
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setImmediate(resolve));

      assert.equal(actionUnavailableCalls.length, 1);
      assert.deepEqual(actionUnavailableCalls[0], {
        fence: actionAdmissionResult.fence,
        holderCatIds: ['codex'],
        evidenceRef: 'timeout:multi-mention:action-req-1',
        now: actionUnavailableCalls[0].now,
      });
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  test('replayed return timeout keeps custody pending for delivery recovery', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    let fireTimeout;
    globalThis.setTimeout = (callback) => {
      fireTimeout = callback;
      return { unref() {} };
    };
    globalThis.clearTimeout = () => {};
    actionAdmissionResult = {
      admit: false,
      outcome: 'replayed',
      lease: { leaseId: 'lease-action-1', generation: 2 },
    };

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/multi-mention',
        headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
        payload: {
          targets: ['codex'],
          question: 'Retry return must not lose custody on timeout',
          callbackTo: 'opus',
          idempotencyKey: 'return-replay-timeout-1',
          action: {
            subjectRef: 'pr:owner/repo#2868',
            actionFamily: 'merge',
            successorSlot: 'reviewer',
            mode: 'single',
            terminalPredicate: { kind: 'pr_merged' },
            returnToPredecessor: {
              leaseId: 'lease-action-1',
              expectedGeneration: 1,
              groundingEvidenceRef: 'grounding:mismatch',
            },
          },
        },
      });
      assert.equal(res.statusCode, 200);
      assert.equal(typeof fireTimeout, 'function');

      fireTimeout();
      await Promise.resolve();
      await Promise.resolve();

      assert.equal(actionUnavailableCalls.length, 0);
    } finally {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  test('duplicate cat detection skips already-queued cats', async () => {
    // Pre-enqueue codex as agent
    invocationQueue.enqueue(
      canonicalTestQueueInput({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'user-1',
        kind: 'private_input',
        content: 'existing',
        source: 'agent',
        targetCats: ['codex'],
        intent: 'execute',
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Should be skipped',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 200);
    // No new hooks (codex already queued)
    assert.equal(mockQueueProcessor.getHooks().size, 0);
  });

  test('fails closed when canonical Queue deps are absent', async () => {
    const incompleteApp = Fastify({ logger: false });
    registerCallbackAuthHook(incompleteApp, mockRegistry);
    resetMultiMentionOrchestrator();
    const incompleteRouter = createMockRouter();
    const { registerMultiMentionRoutes } = await import('../dist/routes/callback-multi-mention-routes.js');
    const incompleteCreds = mockRegistry.register('opus', 'thread-2', 'user-2');

    registerMultiMentionRoutes(incompleteApp, {
      registry: mockRegistry,
      messageStore: mockMessageStore,
      socketManager: mockSocket,
      router: incompleteRouter,
      invocationRecordStore: mockInvocationRecordStore,
      invocationTracker: mockInvocationTracker,
    });
    await incompleteApp.ready();

    const res = await incompleteApp.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: {
        'x-invocation-id': incompleteCreds.invocationId,
        'x-callback-token': incompleteCreds.callbackToken,
      },
      payload: {
        targets: ['codex'],
        question: 'Canonical Queue required',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 503);
    assert.match(res.json().error, /InvocationQueue and QueueProcessor/);
    assert.equal(incompleteRouter.getExecutions().length, 0);

    await incompleteApp.close();
  });
});

describe('B6: QueueProcessor entryCompleteHook integration', () => {
  test('executeEntry fires registered hook with response text', async () => {
    const { InvocationQueue: IQ } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { QueueProcessor: QP } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

    const queue = adaptInvocationQueue(new IQ());
    let hookResult = null;

    const stubDeps = {
      queue,
      invocationTracker: {
        start: () => new AbortController(),
        startAll: () => new AbortController(),
        tryStartThreadAll: () => new AbortController(),
        complete: () => {},
        completeAll: () => {},
        has: () => false,
      },
      invocationRecordStore: {
        create: () => ({ outcome: 'created', invocationId: 'inv-test' }),
        update: () => {},
      },
      router: {
        resolveExplicitTargets: async (requestedCatIds) => [...requestedCatIds],
        resolveConversationTargetsAtAdmission: async (requestedCatIds) => [...requestedCatIds],
        async *routeExecution(_u, _c, _t, _m, targetCats) {
          yield { type: 'text', catId: targetCats[0], content: 'Hello from hook', timestamp: Date.now() };
          yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: Date.now() };
        },
        ackCollectedCursors: () => Promise.resolve(),
      },
      socketManager: {
        broadcastAgentMessage: () => {},
        broadcastToRoom: () => {},
        emitToUser: () => {},
      },
      messageStore: {
        markDelivered: () => null,
        getById: () => null,
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };

    const qp = new QP(stubDeps);

    const result = queue.enqueue(
      canonicalTestQueueInput({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'user-1',
        kind: 'private_input',
        content: 'test',
        source: 'agent',
        targetCats: ['codex'],
        intent: 'execute',
        autoExecute: true,
      }),
    );

    qp.registerEntryCompleteHook(result.entry.id, (entryId, status, responseText) => {
      hookResult = { entryId, status, responseText };
    });

    await qp.requestDrain('thread-1');

    // Wait for async execution to complete
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(hookResult, 'Hook should have been called');
    assert.equal(hookResult.status, 'succeeded');
    assert.equal(hookResult.responseText, 'Hello from hook');
  });

  test('executeEntry partitions one source row into target-specific completion hooks', async () => {
    const { InvocationQueue: IQ } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { QueueProcessor: QP } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

    const queue = adaptInvocationQueue(new IQ());
    const hookResults = new Map();
    const invocationKeys = [];
    const stubDeps = {
      queue,
      invocationTracker: {
        start: () => new AbortController(),
        startAll: () => new AbortController(),
        tryStartThreadAll: () => new AbortController(),
        complete: () => {},
        completeAll: () => {},
        has: () => false,
      },
      invocationRecordStore: {
        create: (input) => {
          invocationKeys.push(input.idempotencyKey);
          return { outcome: 'created', invocationId: `inv-${input.targetCats[0]}` };
        },
        update: () => {},
      },
      router: {
        resolveExplicitTargets: async (requestedCatIds) => [...requestedCatIds],
        resolveConversationTargetsAtAdmission: async (requestedCatIds) => [...requestedCatIds],
        async *routeExecution(_userId, _content, _threadId, _messageId, targetCats) {
          const [catId] = targetCats;
          yield { type: 'text', catId, content: `${catId} completed`, timestamp: Date.now() };
          yield { type: 'done', catId, isFinal: true, timestamp: Date.now() };
        },
        ackCollectedCursors: () => Promise.resolve(),
      },
      socketManager: {
        broadcastAgentMessage: () => {},
        broadcastToRoom: () => {},
        emitToUser: () => {},
      },
      messageStore: {
        markDelivered: () => null,
        getById: () => null,
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };
    const qp = new QP(stubDeps);
    const result = queue.enqueue(
      canonicalTestQueueInput({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'user-1',
        kind: 'private_input',
        content: 'test both targets',
        source: 'agent',
        targetCats: ['codex', 'gemini'],
        intent: 'execute',
        autoExecute: true,
      }),
    );

    for (const catId of ['codex', 'gemini']) {
      qp.registerEntryCompleteHook(
        result.entry.id,
        (_entryId, status, responseText) => hookResults.set(catId, { status, responseText }),
        catId,
      );
    }

    await qp.requestDrain('thread-1');
    await new Promise((resolve) => setTimeout(resolve, 500));

    assert.deepEqual(hookResults.get('codex'), { status: 'succeeded', responseText: 'codex completed' });
    assert.deepEqual(hookResults.get('gemini'), { status: 'succeeded', responseText: 'gemini completed' });
    assert.deepEqual(invocationKeys, [`queue-${result.entry.id}:codex`, `queue-${result.entry.id}:gemini`]);
  });

  test('dispatches one exact cloud child, returns its typed failure notice, and retires the Queue carrier', async () => {
    const { InvocationQueue: IQ } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { QueueProcessor: QP } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

    // F117: InvocationQueue dropped the legacy in-memory `enqueue`; use the
    // fixture adapter (canonical MessageFrom + durable ledger admission) like the
    // sibling tests below.
    const queue = adaptInvocationQueue(new IQ());
    // F117: message_wake rows must reference a real persisted History message —
    // production admits message+queue atomically (appendAndEnqueueDurable), and
    // the QueueProcessor fails a wake closed when the referenced message is absent.
    const messageStore = adaptMessageStore(new MessageStore());
    const recordsByIdempotencyKey = new Map();
    const recordsById = new Map();
    let invocationCounter = 0;
    const routeCalls = [];
    const hookResults = [];
    const stubDeps = {
      queue,
      invocationTracker: {
        start: () => new AbortController(),
        startAll: () => new AbortController(),
        tryStartThreadAll: () => new AbortController(),
        complete: () => {},
        completeAll: () => {},
        has: () => false,
        getController: () => undefined,
      },
      invocationRecordStore: {
        create(input) {
          const prior = recordsByIdempotencyKey.get(input.idempotencyKey);
          if (prior) return { outcome: 'duplicate', invocationId: prior.invocationId };
          const invocationId = `inv-cloud-${invocationCounter++}`;
          const record = { ...input, invocationId, status: 'queued' };
          recordsByIdempotencyKey.set(input.idempotencyKey, record);
          recordsById.set(invocationId, record);
          return { outcome: 'created', invocationId };
        },
        update(invocationId, patch) {
          Object.assign(recordsById.get(invocationId), patch);
        },
        get(invocationId) {
          return recordsById.get(invocationId) ?? null;
        },
      },
      router: {
        resolveExplicitTargets: async (requestedCatIds) => [...requestedCatIds],
        resolveConversationTargetsAtAdmission: async (requestedCatIds) => [...requestedCatIds],
        async *routeExecution(userId, message, threadId, sourceMessageId, targetCats, intent, options) {
          routeCalls.push({ userId, message, threadId, sourceMessageId, targetCats, intent, options });
          yield {
            type: 'system_info',
            catId: targetCats[0],
            content: JSON.stringify({
              type: 'cloud_bridge_status',
              status: 'unavailable',
              reason: 'incomplete-dispatch-provenance',
              message: '未发送给 @gpt-pro：投递来源或回程绑定不完整。',
            }),
            timestamp: Date.now(),
          };
          yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: Date.now() };
        },
        ackCollectedCursors: () => Promise.resolve(),
      },
      socketManager: {
        broadcastAgentMessage: () => {},
        broadcastToRoom: () => {},
        emitToUser: () => {},
      },
      messageStore,
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };

    const qp = new QP(stubDeps);
    // Persist the exact source message the wake references (atomic-admission contract).
    const sourceMessage = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'Original raw intent',
      mentions: [],
      timestamp: 100,
      threadId: 'thread-1',
    });
    const carrier = {
      sourceMessageId: sourceMessage.id,
      sourceSender: { kind: 'user', id: 'user-1' },
      calledByCatId: 'opus',
      intent: 'Original raw intent',
    };
    const enqueue = () =>
      queue.enqueue({
        // F117: durable Queue admission requires an explicit ledger kind
        // (same contract as production A2A fan-out: message_wake).
        kind: 'message_wake',
        ownerAuthProvenance: 'strict',
        threadId: 'thread-1',
        userId: 'user-1',
        content: '[Multi-Mention from opus]\n\nOriginal raw intent',
        source: 'agent',
        targetCats: ['gpt-pro'],
        intent: 'execute',
        autoExecute: true,
        callerCatId: 'opus',
        a2aParentInvocationId: 'inv-parent',
        // F117: message_wake admission requires a durable History message reference;
        // production A2A fan-out threads the source message id as payload.messageId.
        messageId: carrier.sourceMessageId,
        a2aTriggerMessageId: carrier.sourceMessageId,
        idempotencyKey: 'multi-mention:req-1:gpt-pro',
        cloudDispatchProvenance: carrier,
        requiresExactCloudDispatchProvenance: true,
      });

    const first = enqueue();
    qp.registerEntryCompleteHook(first.entry.id, (_entryId, status, responseText) => {
      hookResults.push({ status, responseText });
    });
    await qp.requestDrain('thread-1');
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(routeCalls.length, 1);
    assert.equal(routeCalls[0].sourceMessageId, carrier.sourceMessageId);
    assert.deepEqual(routeCalls[0].options.cloudDispatchProvenance, carrier);
    assert.equal(routeCalls[0].options.requiresExactCloudDispatchProvenance, true);
    assert.deepEqual(hookResults, [
      {
        status: 'succeeded',
        responseText: '未发送给 @gpt-pro：投递来源或回程绑定不完整。',
      },
    ]);

    assert.deepEqual(queue.list('thread-1', 'user-1'), [], 'delivered work must leave no Queue tombstone');
  });

  test('hook is auto-removed after firing (one-shot)', async () => {
    const { InvocationQueue: IQ } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { QueueProcessor: QP } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

    const queue = adaptInvocationQueue(new IQ());
    let hookCallCount = 0;

    const stubDeps = {
      queue,
      invocationTracker: {
        start: () => new AbortController(),
        startAll: () => new AbortController(),
        tryStartThreadAll: () => new AbortController(),
        complete: () => {},
        completeAll: () => {},
        has: () => false,
      },
      invocationRecordStore: {
        create: () => ({ outcome: 'created', invocationId: 'inv-test-2' }),
        update: () => {},
      },
      router: {
        resolveExplicitTargets: async (requestedCatIds) => [...requestedCatIds],
        resolveConversationTargetsAtAdmission: async (requestedCatIds) => [...requestedCatIds],
        async *routeExecution(_u, _c, _t, _m, targetCats) {
          yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: Date.now() };
        },
        ackCollectedCursors: () => Promise.resolve(),
      },
      socketManager: {
        broadcastAgentMessage: () => {},
        broadcastToRoom: () => {},
        emitToUser: () => {},
      },
      messageStore: {
        markDelivered: () => null,
        getById: () => null,
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };

    const qp = new QP(stubDeps);

    const result = queue.enqueue(
      canonicalTestQueueInput({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'user-1',
        kind: 'private_input',
        content: 'test',
        source: 'agent',
        targetCats: ['codex'],
        intent: 'execute',
        autoExecute: true,
      }),
    );

    qp.registerEntryCompleteHook(result.entry.id, () => {
      hookCallCount++;
    });

    await qp.requestDrain('thread-1');
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(hookCallCount, 1, 'Hook should fire exactly once');
  });

  test('P1: aborted entry fires hook with canceled status, not succeeded', async () => {
    const { InvocationQueue: IQ } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { QueueProcessor: QP } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

    const queue = adaptInvocationQueue(new IQ());
    let hookResult = null;
    const abortController = new AbortController();

    const stubDeps = {
      queue,
      invocationTracker: {
        start: () => abortController,
        startAll: () => abortController,
        tryStartThreadAll: () => new AbortController(),
        complete: () => {},
        completeAll: () => {},
        has: () => false,
      },
      invocationRecordStore: {
        create: () => ({ outcome: 'created', invocationId: 'inv-abort' }),
        update: () => {},
      },
      router: {
        resolveExplicitTargets: async (requestedCatIds) => [...requestedCatIds],
        resolveConversationTargetsAtAdmission: async (requestedCatIds) => [...requestedCatIds],
        async *routeExecution(_u, _c, _t, _m, targetCats) {
          yield { type: 'text', catId: targetCats[0], content: 'partial', timestamp: Date.now() };
          abortController.abort();
          yield { type: 'done', catId: targetCats[0], isFinal: true, timestamp: Date.now() };
        },
        ackCollectedCursors: () => Promise.resolve(),
      },
      socketManager: {
        broadcastAgentMessage: () => {},
        broadcastToRoom: () => {},
        emitToUser: () => {},
      },
      messageStore: {
        markDelivered: () => null,
        getById: () => null,
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };

    const qp = new QP(stubDeps);

    const result = queue.enqueue(
      canonicalTestQueueInput({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'user-1',
        kind: 'private_input',
        content: 'test',
        source: 'agent',
        targetCats: ['codex'],
        intent: 'execute',
        autoExecute: true,
      }),
    );

    qp.registerEntryCompleteHook(result.entry.id, (entryId, status, responseText) => {
      hookResult = { entryId, status, responseText };
    });

    await qp.requestDrain('thread-1');
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(hookResult, 'Hook should have been called');
    assert.equal(hookResult.status, 'canceled', 'Aborted entry should report canceled, not succeeded');
  });

  test('R4-P1: duplicate invocation fires hook with succeeded, not failed', async () => {
    const { InvocationQueue: IQ } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { QueueProcessor: QP } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

    const queue = adaptInvocationQueue(new IQ());
    let hookResult = null;

    const stubDeps = {
      queue,
      invocationTracker: {
        start: () => new AbortController(),
        startAll: () => new AbortController(),
        tryStartThreadAll: () => new AbortController(),
        complete: () => {},
        completeAll: () => {},
        has: () => false,
      },
      invocationRecordStore: {
        create: () => ({ outcome: 'duplicate', invocationId: 'inv-dup' }),
        update: () => {},
      },
      router: {
        resolveExplicitTargets: async (requestedCatIds) => [...requestedCatIds],
        resolveConversationTargetsAtAdmission: async (requestedCatIds) => [...requestedCatIds],
        async *routeExecution() {
          throw new Error('Should not be called for duplicate');
        },
        ackCollectedCursors: () => Promise.resolve(),
      },
      socketManager: {
        broadcastAgentMessage: () => {},
        broadcastToRoom: () => {},
        emitToUser: () => {},
      },
      messageStore: {
        markDelivered: () => null,
        getById: () => null,
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };

    const qp = new QP(stubDeps);

    const result = queue.enqueue(
      canonicalTestQueueInput({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'user-1',
        kind: 'private_input',
        content: 'test-dup',
        source: 'agent',
        targetCats: ['codex'],
        intent: 'execute',
        autoExecute: true,
      }),
    );

    qp.registerEntryCompleteHook(result.entry.id, (entryId, status, responseText) => {
      hookResult = { entryId, status, responseText };
    });

    await qp.requestDrain('thread-1');
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(hookResult, 'Hook should have been called for duplicate');
    assert.equal(hookResult.status, 'succeeded', 'Duplicate should report succeeded, not failed');
  });
});

describe('B6: canceled hook skips recordResponse in dispatchViaQueue', () => {
  let app;
  let mockRegistry, mockSocket, mockMessageStore, mockInvocationRecordStore;
  let mockInvocationTracker, mockRouter;
  let invocationQueue, mockQueueProcessor;
  let creds;

  beforeEach(async () => {
    resetMultiMentionOrchestrator();
    mockRegistry = createMockRegistry();
    mockSocket = createMockSocketManager();
    mockMessageStore = createMockMessageStore();
    mockInvocationRecordStore = createMockInvocationRecordStore();
    mockInvocationTracker = createMockInvocationTracker();
    mockRouter = createMockRouter();
    invocationQueue = adaptInvocationQueue(new InvocationQueue());
    mockQueueProcessor = createMockQueueProcessor();
    creds = mockRegistry.register('opus', 'thread-1', 'user-1');
    appendTestLifecycleResponseSource(mockMessageStore, creds);

    app = Fastify({ logger: false });
    registerCallbackAuthHook(app, mockRegistry);
    const { registerMultiMentionRoutes } = await import('../dist/routes/callback-multi-mention-routes.js');
    registerMultiMentionRoutes(app, {
      registry: mockRegistry,
      messageStore: mockMessageStore,
      socketManager: mockSocket,
      router: mockRouter,
      invocationRecordStore: mockInvocationRecordStore,
      invocationTracker: mockInvocationTracker,
      invocationQueue,
      queueProcessor: mockQueueProcessor,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  test('canceled hook does not record response in orchestrator', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Abort scenario?',
        callbackTo: 'opus',
      },
    });

    const body = res.json();
    const requestId = body.requestId;
    const orch = getMultiMentionOrchestrator();

    assert.equal(orch.getStatus(requestId), 'running');

    const hooks = mockQueueProcessor.getHooks();
    const [entryId] = hooks.keys();
    mockQueueProcessor.simulateComplete(entryId, 'canceled', '');

    // Orchestrator should still be running (canceled does NOT count as a response)
    assert.equal(orch.getStatus(requestId), 'running');
  });

  test('canceled_by_user hook does not record response in orchestrator', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'User canceled scenario?',
        callbackTo: 'opus',
      },
    });

    const body = res.json();
    const requestId = body.requestId;
    const orch = getMultiMentionOrchestrator();

    assert.equal(orch.getStatus(requestId), 'running');

    const hooks = mockQueueProcessor.getHooks();
    const [entryId] = hooks.keys();
    mockQueueProcessor.simulateComplete(entryId, 'canceled_by_user', '');

    assert.equal(orch.getStatus(requestId), 'running');
  });

  test('P2: unregisterEntryCompleteHook cleans up on entry removal', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': creds.invocationId, 'x-callback-token': creds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Will be removed',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 200);

    const hooks = mockQueueProcessor.getHooks();
    assert.equal(hooks.size, 1, 'Should have registered one hook');

    const [entryId] = hooks.keys();
    mockQueueProcessor.unregisterEntryCompleteHook(entryId);
    assert.equal(hooks.size, 0, 'Hook should be cleaned up after unregister');
  });
});
