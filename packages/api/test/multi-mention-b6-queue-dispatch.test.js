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
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import {
  getMultiMentionOrchestrator,
  resetMultiMentionOrchestrator,
} from '../dist/routes/callback-multi-mention-routes.js';

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
    getMessages: () => messages,
    getRoomEvents: () => roomEvents,
  };
}

function createMockMessageStore() {
  const messages = [];
  return {
    append(msg) {
      const stored = { id: `msg-${messages.length}`, ...msg };
      messages.push(stored);
      return stored;
    },
    getById: (id) => messages.find((m) => m.id === id) ?? null,
    getMessages: () => messages,
  };
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
    registerEntryCompleteHook(entryId, hook) {
      hooks.set(entryId, hook);
    },
    unregisterEntryCompleteHook(entryId) {
      hooks.delete(entryId);
    },
    tryAutoExecute(threadId) {
      autoExecuteCalls.push(threadId);
      return Promise.resolve();
    },
    getHooks: () => hooks,
    getAutoExecuteCalls: () => autoExecuteCalls,
    simulateComplete(entryId, status, responseText) {
      const hook = hooks.get(entryId);
      if (hook) {
        hook(entryId, status, responseText);
        hooks.delete(entryId);
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
    invocationQueue = new InvocationQueue();
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

    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.ok(body.requestId);

    // Router should NOT have been called directly (queue path used)
    assert.equal(mockRouter.getExecutions().length, 0);

    // tryAutoExecute should have been called
    assert.ok(mockQueueProcessor.getAutoExecuteCalls().length > 0);

    // Completion hook should have been registered for the enqueued entry
    assert.ok(mockQueueProcessor.getHooks().size > 0);
    assert.equal(actionAdmissionCalls.length, 0, 'legacy unscoped request must remain backward compatible');
  });

  test('preserves exact cloud source provenance and per-target lineage in every Queue carrier', async () => {
    const source = mockMessageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'Ask local and cloud cats to review this exact request',
      mentions: [],
      timestamp: 100,
      threadId: 'thread-1',
      deliveryStatus: 'delivered',
    });
    creds = mockRegistry.register('opus', 'thread-1', 'user-1', {
      originTriggerMessageId: source.id,
    });

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

    assert.equal(res.statusCode, 200);
    const { requestId } = res.json();
    const entries = invocationQueue.list('thread-1', 'user-1');
    assert.equal(entries.length, 2);
    assert.deepEqual(
      entries.map((entry) => ({
        targetCatId: entry.targetCats[0],
        parentInvocationId: entry.a2aParentInvocationId,
        idempotencyKey: entry.idempotencyKey,
        requiresExactProvenance: entry.requiresExactCloudDispatchProvenance,
        provenance: entry.cloudDispatchProvenance,
      })),
      [
        {
          targetCatId: 'codex',
          parentInvocationId: creds.invocationId,
          idempotencyKey: `multi-mention:${requestId}:codex`,
          requiresExactProvenance: true,
          provenance: {
            sourceMessageId: source.id,
            sourceSender: { kind: 'user', id: 'user-1' },
            calledByCatId: 'opus',
            intent: 'Review the exact source\n\n---\n\nPreserve this original context',
          },
        },
        {
          targetCatId: 'gpt-pro',
          parentInvocationId: creds.invocationId,
          idempotencyKey: `multi-mention:${requestId}:gpt-pro`,
          requiresExactProvenance: true,
          provenance: {
            sourceMessageId: source.id,
            sourceSender: { kind: 'user', id: 'user-1' },
            calledByCatId: 'opus',
            intent: 'Review the exact source\n\n---\n\nPreserve this original context',
          },
        },
      ],
    );
  });

  test('rejects caller-visible but cloud-ineligible Queue provenance while local sibling stays independent', async () => {
    const source = mockMessageStore.append({
      userId: 'user-1',
      catId: null,
      content: 'Private source for opus only',
      mentions: [],
      timestamp: 101,
      threadId: 'thread-1',
      deliveryStatus: 'delivered',
      visibility: 'whisper',
      whisperTo: ['opus'],
    });
    creds = mockRegistry.register('opus', 'thread-1', 'user-1', {
      originTriggerMessageId: source.id,
    });

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

    assert.equal(res.statusCode, 200);
    const { requestId } = res.json();
    const entries = invocationQueue.list('thread-1', 'user-1');
    const localEntry = entries.find((entry) => entry.targetCats[0] === 'codex');
    const cloudEntry = entries.find((entry) => entry.targetCats[0] === 'gpt-pro');
    assert.ok(localEntry);
    assert.ok(cloudEntry);
    assert.equal(cloudEntry.requiresExactCloudDispatchProvenance, true);
    assert.equal(cloudEntry.cloudDispatchProvenance, undefined);

    const orch = getMultiMentionOrchestrator();
    mockQueueProcessor.simulateComplete(cloudEntry.id, 'succeeded', '未发送给 @gpt-pro：精确来源不满足公开回程资格。');
    assert.equal(orch.getStatus(requestId), 'partial');
    mockQueueProcessor.simulateComplete(localEntry.id, 'succeeded', 'Local sibling completed');

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
    assert.deepEqual(entry.actionSuccessorFence, actionAdmissionResult.fence);
    assert.equal(entry.idempotencyKey, 'action:lease-action-1:1:codex');
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
        question: 'Review the current head',
        callbackTo: 'opus',
        idempotencyKey: 'action-stale-head',
        action: {
          subjectRef: 'pr:owner/repo#2868',
          actionFamily: 'review',
          successorSlot: 'reviewer',
          mode: 'single',
          terminalPredicate: { kind: 'review_delivered', headSha: '1111111111111111111111111111111111111111' },
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
          subjectRef: 'pr:owner/repo#2868',
          actionFamily: 'review',
          successorSlot: 'reviewer',
          mode: 'parallel',
          terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
          parallelIntent: 'independent review',
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

  test('enqueued entries have source=agent and autoExecute=true', async () => {
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
    assert.equal(entry.source, 'agent');
    assert.equal(entry.autoExecute, true);
    assert.equal(entry.ownerAuthProvenance, 'strict');
    assert.deepEqual(entry.targetCats, ['codex']);
    assert.ok(entry.content.includes('[Multi-Mention from opus]'));
    assert.ok(entry.content.includes('Test queue entry fields'));
  });

  test('depth limit prevents excessive enqueue', async () => {
    // Fill the queue with 10 agent entries (MAX_MM_DEPTH)
    for (let i = 0; i < 10; i++) {
      invocationQueue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'user-1',
        content: `fill-${i}`,
        source: 'agent',
        targetCats: [`cat-${i}`],
        intent: 'execute',
      });
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
      invocationQueue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'user-1',
        content: `fill-${i}`,
        source: 'agent',
        targetCats: [`cat-${i}`],
        intent: 'execute',
      });
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
      invocationQueue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'user-1',
        content: `fill-return-${i}`,
        source: 'agent',
        targetCats: [`cat-return-${i}`],
        intent: 'execute',
      });
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
      invocationQueue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: 'thread-1',
        userId: 'user-1',
        content: `fill-return-replay-${i}`,
        source: 'agent',
        targetCats: [`cat-return-replay-${i}`],
        intent: 'execute',
      });
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
    invocationQueue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'existing unrelated work',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
    });

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
    globalThis.setTimeout = (callback) => {
      fireTimeout = callback;
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
    invocationQueue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'existing',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
    });

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

  test('falls back to direct dispatch when queue deps are absent', async () => {
    // Create a new app WITHOUT queue deps
    const fallbackApp = Fastify({ logger: false });
    registerCallbackAuthHook(fallbackApp, mockRegistry);
    resetMultiMentionOrchestrator();
    const fallbackRouter = createMockRouter();
    const { registerMultiMentionRoutes } = await import('../dist/routes/callback-multi-mention-routes.js');
    const source = mockMessageStore.append({
      userId: 'user-2',
      catId: null,
      content: 'Exact direct source',
      mentions: [],
      timestamp: 200,
      threadId: 'thread-2',
      deliveryStatus: 'delivered',
    });
    const fallbackCreds = mockRegistry.register('opus', 'thread-2', 'user-2', {
      originTriggerMessageId: source.id,
    });

    registerMultiMentionRoutes(fallbackApp, {
      registry: mockRegistry,
      messageStore: mockMessageStore,
      socketManager: mockSocket,
      router: fallbackRouter,
      invocationRecordStore: mockInvocationRecordStore,
      invocationTracker: mockInvocationTracker,
      // No invocationQueue or queueProcessor
    });
    await fallbackApp.ready();

    const res = await fallbackApp.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': fallbackCreds.invocationId, 'x-callback-token': fallbackCreds.callbackToken },
      payload: {
        targets: ['codex'],
        question: 'Fallback test',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 200);

    // Wait for async dispatch to complete
    await new Promise((r) => setTimeout(r, 100));

    // Direct dispatch should have been used (router called)
    assert.ok(fallbackRouter.getExecutions().length > 0);
    const [execution] = fallbackRouter.getExecutions();
    assert.equal(execution.userMessageId, source.id);
    assert.equal(execution.options.requiresExactCloudDispatchProvenance, true);
    assert.deepEqual(execution.options.cloudDispatchProvenance, {
      sourceMessageId: source.id,
      sourceSender: { kind: 'user', id: 'user-2' },
      calledByCatId: 'opus',
      intent: 'Fallback test',
    });

    await fallbackApp.close();
  });

  test('keeps a typed direct cloud provenance failure visible instead of recording empty success', async () => {
    const fallbackApp = Fastify({ logger: false });
    registerCallbackAuthHook(fallbackApp, mockRegistry);
    resetMultiMentionOrchestrator();
    const { registerMultiMentionRoutes } = await import('../dist/routes/callback-multi-mention-routes.js');
    const routeCalls = [];
    const fallbackRouter = {
      async *routeExecution(_userId, _message, _threadId, _sourceMessageId, targetCats, _intent, options) {
        routeCalls.push(options);
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
    };
    const fallbackCreds = mockRegistry.register('opus', 'thread-2', 'user-2');

    registerMultiMentionRoutes(fallbackApp, {
      registry: mockRegistry,
      messageStore: mockMessageStore,
      socketManager: mockSocket,
      router: fallbackRouter,
      invocationRecordStore: mockInvocationRecordStore,
      invocationTracker: mockInvocationTracker,
    });
    await fallbackApp.ready();

    const res = await fallbackApp.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': fallbackCreds.invocationId, 'x-callback-token': fallbackCreds.callbackToken },
      payload: {
        targets: ['gpt-pro'],
        question: 'Fail visibly',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 200);
    const { requestId } = res.json();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = getMultiMentionOrchestrator().getResult(requestId);
    assert.equal(routeCalls[0].requiresExactCloudDispatchProvenance, true);
    assert.equal(routeCalls[0].cloudDispatchProvenance, undefined);
    assert.equal(result.responses[0].status, 'received');
    assert.match(result.responses[0].content, /未发送给 @gpt-pro/);

    await fallbackApp.close();
  });

  test('does not direct-dispatch a caller-visible source that is ineligible for the cloud return boundary', async () => {
    const fallbackApp = Fastify({ logger: false });
    registerCallbackAuthHook(fallbackApp, mockRegistry);
    resetMultiMentionOrchestrator();
    const { registerMultiMentionRoutes } = await import('../dist/routes/callback-multi-mention-routes.js');
    const routeCalls = [];
    let bridgeDispatches = 0;
    const fallbackRouter = {
      async *routeExecution(_userId, _message, _threadId, _sourceMessageId, targetCats, _intent, options) {
        const targetCatId = targetCats[0];
        routeCalls.push({ targetCatId, options });
        if (targetCatId === 'gpt-pro') {
          if (options.cloudDispatchProvenance) {
            bridgeDispatches += 1;
            yield { type: 'text', catId: targetCatId, content: 'Cloud bridge dispatched', timestamp: Date.now() };
          } else {
            yield {
              type: 'system_info',
              catId: targetCatId,
              content: JSON.stringify({
                type: 'cloud_bridge_status',
                status: 'unavailable',
                reason: 'missing-source-message-id',
                message: '未发送给 @gpt-pro：精确来源不满足公开回程资格。',
              }),
              timestamp: Date.now(),
            };
          }
        } else {
          yield { type: 'text', catId: targetCatId, content: 'Local sibling completed', timestamp: Date.now() };
        }
        yield { type: 'done', catId: targetCatId, isFinal: true, timestamp: Date.now() };
      },
    };
    const source = mockMessageStore.append({
      userId: 'user-2',
      catId: null,
      content: 'Private source for opus only',
      mentions: [],
      timestamp: 201,
      threadId: 'thread-2',
      deliveryStatus: 'delivered',
      visibility: 'whisper',
      whisperTo: ['opus'],
    });
    const fallbackCreds = mockRegistry.register('opus', 'thread-2', 'user-2', {
      originTriggerMessageId: source.id,
    });

    registerMultiMentionRoutes(fallbackApp, {
      registry: mockRegistry,
      messageStore: mockMessageStore,
      socketManager: mockSocket,
      router: fallbackRouter,
      invocationRecordStore: mockInvocationRecordStore,
      invocationTracker: mockInvocationTracker,
    });
    await fallbackApp.ready();

    const res = await fallbackApp.inject({
      method: 'POST',
      url: '/api/callbacks/multi-mention',
      headers: { 'x-invocation-id': fallbackCreds.invocationId, 'x-callback-token': fallbackCreds.callbackToken },
      payload: {
        targets: ['codex', 'gpt-pro'],
        question: 'Do not leak the private source',
        callbackTo: 'opus',
      },
    });

    assert.equal(res.statusCode, 200);
    const { requestId } = res.json();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const cloudCall = routeCalls.find((call) => call.targetCatId === 'gpt-pro');
    assert.equal(bridgeDispatches, 0);
    assert.equal(cloudCall.options.requiresExactCloudDispatchProvenance, true);
    assert.equal(cloudCall.options.cloudDispatchProvenance, undefined);
    const result = getMultiMentionOrchestrator().getResult(requestId);
    assert.equal(result.request.status, 'done');
    assert.match(result.responses.find((response) => response.catId === 'codex').content, /Local sibling completed/);
    assert.match(result.responses.find((response) => response.catId === 'gpt-pro').content, /未发送给 @gpt-pro/);

    await fallbackApp.close();
  });
});

describe('B6: QueueProcessor entryCompleteHook integration', () => {
  test('executeEntry fires registered hook with response text', async () => {
    const { InvocationQueue: IQ } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { QueueProcessor: QP } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

    const queue = new IQ();
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

    const result = queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'test',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
    });

    qp.registerEntryCompleteHook(result.entry.id, (entryId, status, responseText) => {
      hookResult = { entryId, status, responseText };
    });

    // Trigger execution via tryAutoExecute
    await qp.tryAutoExecute('thread-1');

    // Wait for async execution to complete
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(hookResult, 'Hook should have been called');
    assert.equal(hookResult.status, 'succeeded');
    assert.equal(hookResult.responseText, 'Hello from hook');
  });

  test('dispatches one exact cloud child on Queue replay and returns its typed failure notice', async () => {
    const { InvocationQueue: IQ } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { QueueProcessor: QP } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

    const queue = new IQ();
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
      messageStore: {
        markDelivered: () => null,
        getById: () => null,
      },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    };

    const qp = new QP(stubDeps);
    const carrier = {
      sourceMessageId: 'msg-exact-source',
      sourceSender: { kind: 'user', id: 'user-1' },
      calledByCatId: 'opus',
      intent: 'Original raw intent',
    };
    const enqueue = () =>
      queue.enqueue({
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
        idempotencyKey: 'multi-mention:req-1:gpt-pro',
        cloudDispatchProvenance: carrier,
        requiresExactCloudDispatchProvenance: true,
      });

    const first = enqueue();
    qp.registerEntryCompleteHook(first.entry.id, (_entryId, status, responseText) => {
      hookResults.push({ status, responseText });
    });
    await qp.tryAutoExecute('thread-1');
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

    const replay = enqueue();
    qp.registerEntryCompleteHook(replay.entry.id, (_entryId, status, responseText) => {
      hookResults.push({ status, responseText });
    });
    await qp.tryAutoExecute('thread-1');
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(routeCalls.length, 1, 'stable replay must not dispatch the exact child twice');
    assert.equal(hookResults.length, 2);
    assert.equal(hookResults[1].status, 'succeeded');
  });

  test('hook is auto-removed after firing (one-shot)', async () => {
    const { InvocationQueue: IQ } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { QueueProcessor: QP } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

    const queue = new IQ();
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

    const result = queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'test',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
    });

    qp.registerEntryCompleteHook(result.entry.id, () => {
      hookCallCount++;
    });

    await qp.tryAutoExecute('thread-1');
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(hookCallCount, 1, 'Hook should fire exactly once');
  });

  test('P1: aborted entry fires hook with canceled status, not succeeded', async () => {
    const { InvocationQueue: IQ } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { QueueProcessor: QP } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

    const queue = new IQ();
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

    const result = queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'test',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
    });

    qp.registerEntryCompleteHook(result.entry.id, (entryId, status, responseText) => {
      hookResult = { entryId, status, responseText };
    });

    await qp.tryAutoExecute('thread-1');
    await new Promise((r) => setTimeout(r, 200));

    assert.ok(hookResult, 'Hook should have been called');
    assert.equal(hookResult.status, 'canceled', 'Aborted entry should report canceled, not succeeded');
  });

  test('R4-P1: duplicate invocation fires hook with succeeded, not failed', async () => {
    const { InvocationQueue: IQ } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { QueueProcessor: QP } = await import('../dist/domains/cats/services/agents/invocation/QueueProcessor.js');

    const queue = new IQ();
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

    const result = queue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-1',
      content: 'test-dup',
      source: 'agent',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
    });

    qp.registerEntryCompleteHook(result.entry.id, (entryId, status, responseText) => {
      hookResult = { entryId, status, responseText };
    });

    await qp.tryAutoExecute('thread-1');
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
    invocationQueue = new InvocationQueue();
    mockQueueProcessor = createMockQueueProcessor();
    creds = mockRegistry.register('opus', 'thread-1', 'user-1');

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
