/**
 * F167 Phase S — action successor single-flight on cross-thread carrier.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';
import './helpers/setup-cat-registry.js';
import Fastify from 'fastify';

function createMockSocketManager() {
  return {
    broadcastAgentMessage() {},
    broadcastToRoom() {},
    emitToUser() {},
  };
}

function createMockInvocationRecordStore() {
  return {
    create() {
      return { outcome: 'created', invocationId: 'child-invocation' };
    },
    update() {},
    get() {
      return null;
    },
  };
}

function createMockRouter() {
  return {
    async *routeExecution() {
      yield* [];
    },
    getExecutions() {
      return [];
    },
  };
}

function createMockAgentKeyRegistry() {
  return {
    async verify(secret) {
      if (secret !== 'agent-key-secret') return { ok: false, reason: 'agent_key_unknown' };
      return {
        ok: true,
        record: {
          agentKeyId: 'ak-opus',
          catId: 'opus',
          userId: 'user-1',
          secretHash: 'hash',
          salt: 'salt',
          scope: 'user-bound',
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
        },
      };
    },
    async claimClientMessageId() {
      return true;
    },
  };
}

function activeLease(holderCatIds, overrides = {}) {
  return {
    leaseId: 'lease-review-1',
    key: 'user-1|github:pr:2868|review|reviewer',
    tenantScope: 'user-1',
    subjectRef: 'github:pr:2868',
    actionFamily: 'review',
    successorSlot: 'reviewer',
    mode: holderCatIds.length > 1 ? 'parallel' : 'single',
    holderCatIds,
    generation: 1,
    dispatchId: 'cross-post:review-2868',
    evidenceRefs: ['callback:source-invocation:review-2868'],
    status: 'active',
    holderOutcomes: {},
    createdAt: 100,
    updatedAt: 100,
    ...overrides,
  };
}

describe('F167 Phase S: cross-thread action successor admission', () => {
  let app;
  let registry;
  let messageStore;
  let threadStore;
  let invocationQueue;
  let actionService;
  let source;
  let target;
  let auth;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');

    registry = new InvocationRegistry();
    invocationQueue = new InvocationQueue();
    messageStore = new MessageStore();
    threadStore = new ThreadStore();
    source = await threadStore.create('user-1', 'Source');
    target = await threadStore.create('user-1', 'Target');
    auth = await registry.create('user-1', 'opus', source.id);

    const calls = [];
    const unavailable = [];
    const returnedDelivered = [];
    actionService = {
      calls,
      unavailable,
      returnedDelivered,
      async admit(input) {
        calls.push(input);
        const lease = activeLease(input.holderCatIds, {
          mode: input.action.mode,
          dispatchId: input.dispatchId,
          ...(input.action.parallelIntent ? { parallelIntent: input.action.parallelIntent } : {}),
        });
        return {
          admit: true,
          outcome: 'claimed',
          lease,
          fence: { leaseId: lease.leaseId, generation: lease.generation, dispatchId: input.dispatchId },
        };
      },
      async markUnavailable(input) {
        unavailable.push(input);
      },
      async markReturnedDelivered(input) {
        returnedDelivered.push(input);
      },
    };

    app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      threadStore,
      socketManager: createMockSocketManager(),
      router: createMockRouter(),
      invocationRecordStore: createMockInvocationRecordStore(),
      invocationQueue,
      queueProcessor: { async tryAutoExecute() {} },
      actionSuccessorAdmissionService: actionService,
    });
  });

  afterEach(async () => {
    await app.close();
  });

  function post(payload) {
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: {
        'x-invocation-id': auth.invocationId,
        'x-callback-token': auth.callbackToken,
      },
      payload: { threadId: target.id, content: 'Review PR 2868', ...payload },
    });
  }

  function postSameThread(payload) {
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: {
        'x-invocation-id': auth.invocationId,
        'x-callback-token': auth.callbackToken,
      },
      payload: { content: 'Review PR 2915', ...payload },
    });
  }

  test('same-thread post_message admits one successor and carries a post fence into InvocationQueue', async () => {
    const response = await postSameThread({
      targetCats: ['codex'],
      clientMessageId: 'review-2915',
      action: {
        subjectRef: 'github:pr:2915',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(actionService.calls.length, 1);
    assert.equal(actionService.calls[0].dispatchId, 'post:review-2915');
    const entries = invocationQueue.list(source.id, 'user-1');
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].actionSuccessorFence, {
      leaseId: 'lease-review-1',
      generation: 1,
      dispatchId: 'post:review-2915',
    });
  });

  test('same-thread post_message rejects parallel action and leaves admission untouched', async () => {
    const response = await postSameThread({
      targetCats: ['codex', 'gpt52'],
      clientMessageId: 'parallel-review-2915',
      action: {
        subjectRef: 'github:pr:2915',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'parallel',
        terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
        parallelIntent: 'independent reviews',
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().kind, 'action_same_thread_parallel');
    assert.equal(actionService.calls.length, 0);
    assert.equal(invocationQueue.list(source.id, 'user-1').length, 0);
  });

  test('same-thread post_message lets one parallel holder record rejection without enqueueing a return', async () => {
    actionService.admit = async (input) => {
      actionService.calls.push(input);
      return {
        admit: false,
        outcome: 'parallel_return_unsupported',
        lease: activeLease(['opus', 'codex'], {
          holderOutcomes: {
            opus: { outcome: 'rejected_ownership', evidenceRef: 'grounding:mismatch', at: 100 },
          },
        }),
      };
    };
    const response = await postSameThread({
      targetCats: ['opus'],
      clientMessageId: 'parallel-reject-2915',
      action: {
        subjectRef: 'github:pr:2915',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'parallel',
        terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
        parallelIntent: 'independent reviews',
        returnToPredecessor: {
          leaseId: 'lease-review-1',
          expectedGeneration: 1,
          groundingEvidenceRef: 'grounding:mismatch',
        },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'parallel_return_unsupported');
    assert.equal(actionService.calls.length, 1);
    assert.equal(invocationQueue.list(source.id, 'user-1').length, 0);
  });

  test('admits a single successor and carries its generation fence into InvocationQueue', async () => {
    const response = await post({
      targetCats: ['codex'],
      clientMessageId: 'review-2868',
      action: {
        subjectRef: 'github:pr:2868',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().actionLease, {
      leaseId: 'lease-review-1',
      generation: 1,
      outcome: 'claimed',
    });
    assert.equal(actionService.calls.length, 1);
    assert.deepEqual(actionService.calls[0].holderCatIds, ['codex']);
    assert.equal(actionService.calls[0].dispatchId, 'cross-post:review-2868');

    const entries = invocationQueue.list(target.id, 'user-1');
    assert.equal(entries.length, 1);
    assert.deepEqual(entries[0].actionSuccessorFence, {
      leaseId: 'lease-review-1',
      generation: 1,
      dispatchId: 'cross-post:review-2868',
    });
  });

  test('returns custody through the same carrier and confirms delivery only after enqueue', async () => {
    actionService.admit = async (input) => {
      actionService.calls.push(input);
      const lease = activeLease(input.holderCatIds, { generation: 2, dispatchId: input.dispatchId });
      return {
        admit: true,
        outcome: 'returned',
        lease,
        fence: { leaseId: lease.leaseId, generation: 2, dispatchId: input.dispatchId },
      };
    };

    const response = await post({
      targetCats: ['codex'],
      clientMessageId: 'return-review-2868',
      action: {
        subjectRef: 'github:pr:2868',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
        returnToPredecessor: {
          leaseId: 'lease-review-1',
          expectedGeneration: 1,
          groundingEvidenceRef: 'grounding:mismatch',
        },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json().actionLease, {
      leaseId: 'lease-review-1',
      generation: 2,
      outcome: 'returned',
    });
    const [entry] = invocationQueue.list(target.id, 'user-1');
    assert.deepEqual(entry.actionSuccessorFence, {
      leaseId: 'lease-review-1',
      generation: 2,
      dispatchId: 'cross-post:return-review-2868',
    });
    assert.equal(actionService.unavailable.length, 0);
    assert.deepEqual(actionService.returnedDelivered, [
      {
        fence: entry.actionSuccessorFence,
        evidenceRef: 'queue:cross-post:return-review-2868:return_enqueued',
        now: actionService.returnedDelivered[0].now,
      },
    ]);
  });

  test('replayed custody return confirms delivery after enqueue', async () => {
    actionService.admit = async (input) => {
      actionService.calls.push(input);
      return {
        admit: false,
        outcome: 'replayed',
        lease: activeLease(['codex'], { generation: 2, dispatchId: input.dispatchId }),
      };
    };

    const response = await post({
      targetCats: ['codex'],
      clientMessageId: 'return-replay-review-2868',
      action: {
        subjectRef: 'github:pr:2868',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
        returnToPredecessor: {
          leaseId: 'lease-review-1',
          expectedGeneration: 1,
          groundingEvidenceRef: 'grounding:mismatch',
        },
      },
    });

    assert.equal(response.statusCode, 200);
    const [entry] = invocationQueue.list(target.id, 'user-1');
    assert.ok(entry);
    assert.equal(actionService.unavailable.length, 0);
    assert.deepEqual(actionService.returnedDelivered, [
      {
        fence: entry.actionSuccessorFence,
        evidenceRef: 'queue:cross-post:return-replay-review-2868:return_enqueued',
        now: actionService.returnedDelivered[0].now,
      },
    ]);
  });

  test('replayed custody return stays pending when queue depth prevents delivery', async () => {
    for (let i = 0; i < 10; i++) {
      invocationQueue.enqueue({
        ownerAuthProvenance: 'unknown',
        threadId: target.id,
        userId: 'user-1',
        content: `fill-return-replay-${i}`,
        source: 'agent',
        targetCats: [`cat-${i}`],
        intent: 'execute',
      });
    }
    actionService.admit = async (input) => {
      actionService.calls.push(input);
      return {
        admit: false,
        outcome: 'replayed',
        lease: activeLease(['codex'], { generation: 2, dispatchId: input.dispatchId }),
      };
    };

    const response = await post({
      targetCats: ['codex'],
      clientMessageId: 'return-replay-blocked-2868',
      action: {
        subjectRef: 'github:pr:2868',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
        returnToPredecessor: {
          leaseId: 'lease-review-1',
          expectedGeneration: 1,
          groundingEvidenceRef: 'grounding:mismatch',
        },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(actionService.unavailable.length, 0);
    assert.equal(actionService.returnedDelivered.length, 0);
  });

  test('same-client replay confirms a return already accepted by the queue', async () => {
    actionService.admit = async (input) => {
      actionService.calls.push(input);
      const lease = activeLease(['codex'], { generation: 2, dispatchId: input.dispatchId });
      return {
        admit: true,
        outcome: 'returned',
        lease,
        fence: { leaseId: lease.leaseId, generation: lease.generation, dispatchId: input.dispatchId },
      };
    };
    const payload = {
      targetCats: ['codex'],
      clientMessageId: 'return-same-client-2868',
      action: {
        subjectRef: 'github:pr:2868',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
        returnToPredecessor: {
          leaseId: 'lease-review-1',
          expectedGeneration: 1,
          groundingEvidenceRef: 'grounding:mismatch',
        },
      },
    };
    const first = await post(payload);
    assert.equal(first.statusCode, 200);
    actionService.returnedDelivered.length = 0;
    actionService.admit = async (input) => {
      actionService.calls.push(input);
      return {
        admit: false,
        outcome: 'replayed',
        lease: activeLease(['codex'], { generation: 2, dispatchId: input.dispatchId }),
      };
    };

    const replay = await post(payload);

    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().status, 'duplicate');
    const [entry] = invocationQueue.list(target.id, 'user-1');
    assert.deepEqual(actionService.returnedDelivered, [
      {
        fence: entry.actionSuccessorFence,
        evidenceRef: 'queue:cross-post:return-same-client-2868:return_enqueued',
        now: actionService.returnedDelivered[0].now,
      },
    ]);
  });

  test('safe_wait creates neither message nor queue entry', async () => {
    actionService.admit = async (input) => {
      actionService.calls.push(input);
      return { admit: false, outcome: 'safe_wait', lease: activeLease(['codex']) };
    };

    const response = await post({
      targetCats: ['codex'],
      clientMessageId: 'review-2868',
      action: {
        subjectRef: 'github:pr:2868',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, 'safe_wait');
    assert.equal(invocationQueue.list(target.id, 'user-1').length, 0);
    assert.equal(messageStore.getByThread(target.id, 20, 'user-1').length, 0);
  });

  test('action-scoped work queues behind unrelated same-cat work instead of coalescing into it', async () => {
    invocationQueue.enqueue({
      ownerAuthProvenance: 'unknown',
      threadId: target.id,
      userId: 'user-1',
      content: 'Unrelated earlier handoff',
      source: 'agent',
      sourceCategory: 'a2a',
      targetCats: ['codex'],
      intent: 'execute',
      autoExecute: true,
      callerCatId: 'opus',
    });

    const response = await post({
      targetCats: ['codex'],
      clientMessageId: 'review-2868',
      action: {
        subjectRef: 'github:pr:2868',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
      },
    });

    assert.equal(response.statusCode, 200);
    const entries = invocationQueue.list(target.id, 'user-1');
    assert.equal(entries.length, 2);
    assert.equal(entries[0].actionSuccessorFence, undefined);
    assert.equal(entries[1].actionSuccessorFence.leaseId, 'lease-review-1');
  });

  test('releases a newly claimed action lease when exact-message dedupe reuses an existing message', async () => {
    threadStore.addParticipants(target.id, ['codex']);
    const first = await post({
      targetCats: ['codex'],
      clientMessageId: 'legacy-review-2868',
    });
    assert.equal(first.statusCode, 200);

    const duplicate = await post({
      targetCats: ['codex'],
      clientMessageId: 'action-review-2868',
      action: {
        subjectRef: 'github:pr:2868',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
      },
    });

    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().status, 'duplicate');
    assert.equal(actionService.unavailable.length, 1);
    assert.equal(actionService.unavailable[0].fence.leaseId, 'lease-review-1');
    assert.deepEqual(actionService.unavailable[0].holderCatIds, ['codex']);
    assert.match(actionService.unavailable[0].evidenceRef, /exact_duplicate$/);
  });

  test('queued duplicate recovery preserves the replayed return fence and confirms delivery', async () => {
    threadStore.addParticipants(target.id, ['codex']);
    const first = await post({
      targetCats: ['codex'],
      clientMessageId: 'recover-review-2868',
      action: {
        subjectRef: 'github:pr:2868',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
      },
    });
    assert.equal(first.statusCode, 200);
    const [storedCarrier] = messageStore.getByThreadIncludingQueued(target.id, 20, 'user-1');
    assert.equal(storedCarrier.extra.callbackDedup.coordinationKey, 'action-active-root');
    const [lostEntry] = invocationQueue.list(target.id, 'user-1');
    assert.ok(lostEntry);
    invocationQueue.remove(target.id, 'user-1', lostEntry.id);

    actionService.admit = async (input) => {
      actionService.calls.push(input);
      return {
        admit: false,
        outcome: 'replayed',
        lease: activeLease(['codex'], { generation: 2, dispatchId: input.dispatchId }),
      };
    };
    auth = await registry.create('user-1', 'opus', source.id);
    const replay = await post({
      targetCats: ['codex'],
      clientMessageId: 'recover-review-2868',
      action: {
        subjectRef: 'github:pr:2868',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
        returnToPredecessor: {
          leaseId: 'lease-review-1',
          expectedGeneration: 1,
          groundingEvidenceRef: 'grounding:mismatch',
        },
      },
    });

    assert.equal(replay.statusCode, 200);
    assert.equal(replay.json().status, 'duplicate');
    const [recovered] = invocationQueue.list(target.id, 'user-1');
    assert.deepEqual(recovered.actionSuccessorFence, {
      leaseId: 'lease-review-1',
      generation: 2,
      dispatchId: 'cross-post:recover-review-2868',
    });
    assert.equal(actionService.unavailable.length, 0);
    assert.deepEqual(actionService.returnedDelivered, [
      {
        fence: recovered.actionSuccessorFence,
        evidenceRef: 'queue:cross-post:recover-review-2868:return_enqueued',
        now: actionService.returnedDelivered[0].now,
      },
    ]);
  });

  test('action carrier rejects ambiguous identity and preserves explicit parallel intent', async () => {
    const missingKey = await post({
      targetCats: ['codex'],
      action: {
        subjectRef: 'github:pr:2868',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'single',
        terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
      },
    });
    assert.equal(missingKey.statusCode, 400);
    assert.equal(missingKey.json().kind, 'action_client_message_id_required');

    const parallel = await post({
      targetCats: ['codex', 'gpt52'],
      clientMessageId: 'parallel-review-2868',
      action: {
        subjectRef: 'github:pr:2868',
        actionFamily: 'review',
        successorSlot: 'reviewer',
        mode: 'parallel',
        terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
        parallelIntent: 'independent security and architecture reviews',
      },
    });
    assert.equal(parallel.statusCode, 200);
    assert.deepEqual(actionService.calls.at(-1).holderCatIds, ['codex', 'gpt52']);
    const entries = invocationQueue.list(target.id, 'user-1');
    assert.equal(entries.length, 2);
    assert.ok(entries.every((entry) => entry.actionSuccessorFence?.leaseId === 'lease-review-1'));
  });

  test('agent-key action fails closed instead of posting or enqueueing an unfenced successor', async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');

    const agentApp = Fastify();
    const agentRegistry = new InvocationRegistry();
    const agentQueue = new InvocationQueue();
    const agentMessages = new MessageStore();
    const agentThreads = new ThreadStore();
    const agentThread = await agentThreads.create('user-1', 'Agent-key target');
    const agentAdmission = {
      calls: [],
      async admit(input) {
        this.calls.push(input);
      },
    };
    await agentApp.register(callbacksRoutes, {
      registry: agentRegistry,
      agentKeyRegistry: createMockAgentKeyRegistry(),
      messageStore: agentMessages,
      threadStore: agentThreads,
      socketManager: createMockSocketManager(),
      router: createMockRouter(),
      invocationRecordStore: createMockInvocationRecordStore(),
      invocationQueue: agentQueue,
      queueProcessor: { async tryAutoExecute() {} },
      actionSuccessorAdmissionService: agentAdmission,
    });

    try {
      const response = await agentApp.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-agent-key-secret': 'agent-key-secret' },
        payload: {
          threadId: agentThread.id,
          content: 'Review PR 2915',
          targetCats: ['codex'],
          clientMessageId: 'agent-review-2915',
          action: {
            subjectRef: 'github:pr:2915',
            actionFamily: 'review',
            successorSlot: 'reviewer',
            mode: 'single',
            terminalPredicate: { kind: 'review_delivered', headSha: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' },
          },
        },
      });

      assert.equal(response.statusCode, 400);
      assert.equal(response.json().status, 'action_agent_key_unsupported');
      assert.equal(agentAdmission.calls.length, 0);
      assert.equal(agentQueue.list(agentThread.id, 'user-1').length, 0);
      assert.equal(agentMessages.getByThread(agentThread.id, 20, 'user-1').length, 0);
    } finally {
      await agentApp.close();
    }
  });
});
