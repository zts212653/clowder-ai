/**
 * F246 Phase J — Sol R6 regression: callbacks.ts dedup guard.
 *
 * When store.create() returns a proposal with a different proposalId than requested
 * (Lua DEDUP race — two concurrent requests both pass the pre-check but one wins
 * the CAS), callbacks.ts must return `proposal_exists` only after the winning
 * proposal is anchored, and must NOT emit a `proposal_created` socket event.
 *
 * This test uses a spy store that simulates the dedup race by making create() return
 * a pre-existing proposal instead of the requested one.
 */
import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { proposedReviewAction } from './helpers.js';

// Pre-existing proposal that "won" the race
const WINNER_PROPOSAL_ID = 'dp-winner-existing';

function createMockSocketManager() {
  const emitted = [];
  return {
    broadcastAgentMessage() {},
    broadcastToRoom() {},
    emitToUser(userId, event, data) {
      emitted.push({ userId, event, data });
    },
    getEmitted() {
      return emitted;
    },
  };
}

function createMockInvocationRecordStore() {
  return {
    create() {
      return { outcome: 'created', invocationId: 'inv-0' };
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

describe('F246 Phase J: callbacks.ts dedup guard (Sol R6 regression)', () => {
  let app;
  let socketManager;
  let ingressPublishCalls;
  let createCalls;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { InMemoryDispatchProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
    );
    const { callbacksRoutes } = await import('../../dist/routes/callbacks.js');

    const registry = new InvocationRegistry();
    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();

    // Create two threads so the cross-thread intercept triggers
    const source = await threadStore.create('user-1', 'Source');
    const target = await threadStore.create('user-1', 'Target');
    await threadStore.addParticipants(source.id, ['opus']);
    await threadStore.addParticipants(target.id, ['sonnet']);

    // Spy store: create() always returns the "winner" proposal with a different ID,
    // simulating the Lua DEDUP race condition.
    const realStore = new InMemoryDispatchProposalStore();
    const winnerProposal = {
      proposalId: WINNER_PROPOSAL_ID,
      sourceThreadId: source.id,
      targetThreadId: target.id,
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      content: 'Earlier version of this dispatch',
      targetCats: ['sonnet'],
      effectClass: 'assign_work',
      status: 'pending',
      createdAt: Date.now() - 1000,
      publication: {
        state: 'anchored',
        envelope: {
          canonicalProposalId: WINNER_PROPOSAL_ID,
          sourceFeatureId: 'F193',
          ownerUserId: 'user-1',
          requesterCatId: 'opus',
          originRef: { kind: 'thread', threadId: source.id },
          approvalCardRef: { threadId: source.id, messageId: 'msg-card-winner' },
          createdAt: Date.now() - 1000,
        },
      },
    };

    createCalls = 0;
    const spyStore = {
      ...realStore,
      // findByClientMessageId returns null — simulates both requests passing pre-check
      findByClientMessageId: async () => null,
      // create() returns the winner proposal (different ID than requested)
      create: async (_input) => {
        createCalls += 1;
        return {
          proposal: { ...winnerProposal },
          supersededProposals: [],
        };
      },
      // Delegate other methods to realStore
      get: (id) => realStore.get(id),
      listPendingByUser: (uid) => realStore.listPendingByUser(uid),
      approve: (id, uid) => realStore.approve(id, uid),
      reject: (id, uid) => realStore.reject(id, uid),
      revertToPending: (id) => realStore.revertToPending(id),
      recordDelivery: (id, mid) => realStore.recordDelivery(id, mid),
      listSettledByUser: (uid, lim) => realStore.listSettledByUser(uid, lim),
    };

    socketManager = createMockSocketManager();
    ingressPublishCalls = [];

    app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      threadStore,
      socketManager,
      router: createMockRouter(),
      invocationRecordStore: createMockInvocationRecordStore(),
      dispatchProposalStore: spyStore,
      approvalIngress: {
        async publish(draft) {
          ingressPublishCalls.push(draft);
        },
      },
    });
    await app.ready();

    // Register an invocation for the "opus" cat in source thread
    const auth = await registry.create('user-1', 'opus', source.id);

    // Store auth + thread IDs for use in tests
    app._testCtx = { auth, sourceId: source.id, targetId: target.id };
  });

  it('returns proposal_exists (not proposal_created) when store.create() returns an anchored different proposalId', async () => {
    const { auth, targetId } = app._testCtx;

    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: {
        'x-invocation-id': auth.invocationId,
        'x-callback-token': auth.callbackToken,
      },
      payload: {
        threadId: targetId,
        content: '@sonnet\nPlease fix the bug',
        targetCats: ['sonnet'],
        effectClass: 'assign_work',
        proposedAction: proposedReviewAction(),
        clientMessageId: 'dedup-race-test',
      },
    });

    assert.equal(res.statusCode, 200);
    const body = res.json();

    // Must return proposal_exists, not proposal_created
    assert.equal(body.status, 'proposal_exists', 'anchored dedup race must return proposal_exists');

    // Must return the winner proposal's ID, not the locally generated one
    assert.equal(body.proposalId, WINNER_PROPOSAL_ID, 'must return the existing proposal ID');

    // Must include clientMessageId in response
    assert.equal(body.clientMessageId, 'dedup-race-test');
    assert.equal(ingressPublishCalls.length, 1, 'anchored dedup hit must replay fanout through ingress');
  });

  it('does NOT emit proposal_created socket event on dedup hit', async () => {
    const { auth, targetId } = app._testCtx;

    await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: {
        'x-invocation-id': auth.invocationId,
        'x-callback-token': auth.callbackToken,
      },
      payload: {
        threadId: targetId,
        content: '@sonnet\nPlease fix the bug',
        targetCats: ['sonnet'],
        effectClass: 'assign_work',
        proposedAction: proposedReviewAction(),
        clientMessageId: 'dedup-no-emit',
      },
    });

    const proposalCreatedEvents = socketManager.getEmitted().filter((e) => e.event === 'proposal_created');

    assert.equal(
      proposalCreatedEvents.length,
      0,
      'dedup hit must NOT emit proposal_created — the proposal already exists',
    );
  });

  it('rejects an unsupported action family/predicate before proposal or card publication', async () => {
    const { auth, targetId } = app._testCtx;
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: {
        'x-invocation-id': auth.invocationId,
        'x-callback-token': auth.callbackToken,
      },
      payload: {
        threadId: targetId,
        content: '@sonnet\nPlease implement this change',
        targetCats: ['sonnet'],
        effectClass: 'assign_work',
        proposedAction: {
          subjectRef: 'subject:feature:F999',
          actionFamily: 'implement',
          successorSlot: 'implementer',
          mode: 'single',
          terminalPredicate: {
            kind: 'test_passed',
            commandDigest: 'sha256:test-command',
            revisionSha: 'revision-1',
          },
        },
        clientMessageId: 'unsupported-action',
      },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().kind, 'proposed_action_unsupported');
    assert.equal(createCalls, 0);
    assert.equal(ingressPublishCalls.length, 0);
  });

  it('rejects assign_work without a proposed action before proposal or card publication', async () => {
    const { auth, targetId } = app._testCtx;
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: {
        'x-invocation-id': auth.invocationId,
        'x-callback-token': auth.callbackToken,
      },
      payload: {
        threadId: targetId,
        content: '@sonnet\nPlease fix the bug',
        targetCats: ['sonnet'],
        effectClass: 'assign_work',
        clientMessageId: 'missing-proposed-action',
      },
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json().kind, 'proposed_action_required');
    assert.equal(createCalls, 0);
    assert.equal(ingressPublishCalls.length, 0);
  });
});
