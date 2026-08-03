import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { proposedReviewAction } from './helpers.js';

function createSucceedingIngress() {
  return {
    publish: async (draft, store) => {
      const envelope = {
        canonicalProposalId: draft.canonicalProposalId,
        sourceFeatureId: draft.producerId,
        ownerUserId: draft.ownerUserId,
        requesterCatId: draft.requesterCatId,
        originRef: draft.originRef,
        approvalCardRef: { threadId: draft.cardThreadId, messageId: 'msg-card-ok' },
        createdAt: draft.createdAt,
      };
      await store.commitEnvelope(draft.canonicalProposalId, envelope);
      return envelope;
    },
  };
}

// ── F193: Dispatch Proposal Ingress Failure + Supersede Rollback ─────────────

describe('P1-1/P1-4: F193 dispatch proposal ingress failure', () => {
  let ApprovalIngress;
  let InMemoryDispatchProposalStore;
  let F193ApprovalAdapter;

  beforeEach(async () => {
    ({ ApprovalIngress } = await import('../../dist/domains/approval-hub/ApprovalIngress.js'));
    ({ InMemoryDispatchProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
    ));
    ({ F193ApprovalAdapter } = await import('../../dist/domains/approval-hub/adapters/F193ApprovalAdapter.js'));
  });

  function createCardAppendFailingIngress(failOnCardNumber) {
    return ({ messageStore, socketManager }) => {
      let cardAppendCount = 0;
      const append = messageStore.append.bind(messageStore);
      messageStore.append = (input) => {
        if (input.idempotencyKey && ++cardAppendCount === failOnCardNumber) {
          throw new Error('simulated ingress failure: card append failed');
        }
        return append(input);
      };
      return new ApprovalIngress({ messageStore, socketManager });
    };
  }

  /** Create a Fastify app with callbacks registered, using the given ingress or factory. */
  async function buildApp(ingressOrFactory) {
    const { InvocationRegistry } = await import(
      '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { callbacksRoutes } = await import('../../dist/routes/callbacks.js');

    const registry = new InvocationRegistry();
    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();

    const source = await threadStore.create('user-1', 'Source');
    const target = await threadStore.create('user-1', 'Target');
    await threadStore.addParticipants(source.id, ['opus']);
    await threadStore.addParticipants(target.id, ['sonnet']);
    const origin = await messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: 'Dispatch origin',
      mentions: [],
      timestamp: Date.now(),
      threadId: source.id,
    });

    const store = new InMemoryDispatchProposalStore();
    const socketManager = { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} };
    const approvalIngress =
      typeof ingressOrFactory === 'function' ? ingressOrFactory({ messageStore, socketManager }) : ingressOrFactory;

    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      threadStore,
      socketManager,
      router: {
        async *routeExecution() {
          yield* [];
        },
        getExecutions: () => [],
      },
      invocationRecordStore: {
        create: () => ({ outcome: 'created', invocationId: 'inv-0' }),
        update() {},
        get: () => null,
      },
      dispatchProposalStore: store,
      approvalIngress,
    });
    await app.ready();

    const auth = await registry.create('user-1', 'opus', source.id, undefined, undefined, undefined, origin.id);
    return { app, auth, sourceId: source.id, targetId: target.id, store };
  }

  const createPayload = (targetId, clientMessageId = 'dispatch-ingress-failure') => ({
    threadId: targetId,
    content: '@sonnet\nPlease fix the bug',
    targetCats: ['sonnet'],
    effectClass: 'assign_work',
    proposedAction: proposedReviewAction(),
    clientMessageId,
  });

  it('returns non-2xx when ingress.publish throws on dispatch create (P1-1)', async () => {
    const { app, auth, targetId } = await buildApp(createCardAppendFailingIngress(1));
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
        payload: createPayload(targetId, 'dispatch-ingress-a'),
      });
      assert.ok(res.statusCode >= 500, `Expected 5xx but got ${res.statusCode}: ingress failure must propagate`);
    } finally {
      await app.close();
    }
  });

  it('existing pending A → create B (same lineage) → B ingress fails → A still pending (P1-4)', async () => {
    const { app, auth, targetId, store } = await buildApp(createCardAppendFailingIngress(2));
    try {
      // Create proposal A via route — ingress succeeds → A is anchored
      const r1 = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
        payload: createPayload(targetId),
      });
      assert.equal(r1.statusCode, 200, 'A creation must succeed');
      const proposalAId = r1.json().proposalId;
      assert.ok(proposalAId, 'A must have proposalId');

      const aBefore = await store.get(proposalAId);
      assert.equal(aBefore.status, 'pending', 'A must be pending after successful creation');

      // Create proposal B via route (same lineage) — ingress fails → rollback
      const r2 = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
        payload: {
          ...createPayload(targetId, 'dispatch-ingress-b'),
          content: '@sonnet\nUpdated dispatch',
        },
      });
      assert.ok(r2.statusCode >= 500, 'B creation must fail (ingress error)');

      // After rollback, A must be pending (not superseded) and actionable
      const aAfter = await store.get(proposalAId);
      assert.equal(
        aAfter.status,
        'pending',
        `A must be restored to pending after B's ingress failure, but got status=${aAfter.status}`,
      );

      // A must still be visible in Hub
      const adapter = new F193ApprovalAdapter(store);
      const pending = await adapter.listPending('user-1');
      const aInHub = pending.find((p) => p.proposalId === proposalAId);
      assert.ok(aInHub, 'A must be visible in Hub pending list after B ingress failure rollback');
    } finally {
      await app.close();
    }
  });

  it('fails before mutating the store when approvalIngress is absent', async () => {
    const { InvocationRegistry } = await import(
      '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { callbacksRoutes } = await import('../../dist/routes/callbacks.js');

    const registry = new InvocationRegistry();
    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();
    const source = await threadStore.create('user-1', 'Source');
    const target = await threadStore.create('user-1', 'Target');
    await threadStore.addParticipants(source.id, ['opus']);
    await threadStore.addParticipants(target.id, ['sonnet']);

    const store = new InMemoryDispatchProposalStore();
    const auth = await registry.create('user-1', 'opus', source.id);
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      threadStore,
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      router: {
        async *routeExecution() {
          yield* [];
        },
        getExecutions: () => [],
      },
      invocationRecordStore: {
        create: () => ({ outcome: 'created', invocationId: 'inv-0' }),
        update() {},
        get: () => null,
      },
      dispatchProposalStore: store,
      approvalIngress: createSucceedingIngress(),
    });
    await app.ready();

    const payloadA = {
      threadId: target.id,
      content: '@sonnet\nPlease fix the original bug',
      targetCats: ['sonnet'],
      effectClass: 'assign_work',
      proposedAction: proposedReviewAction(),
      clientMessageId: 'dispatch-with-ingress-a',
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: payloadA,
    });
    assert.equal(first.statusCode, 200);
    const proposalAId = first.json().proposalId;
    const proposalABefore = await store.get(proposalAId);
    assert.equal(proposalABefore?.status, 'pending');

    const brokenApp = Fastify();
    await brokenApp.register(callbacksRoutes, {
      registry,
      messageStore,
      threadStore,
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      router: {
        async *routeExecution() {
          yield* [];
        },
        getExecutions: () => [],
      },
      invocationRecordStore: {
        create: () => ({ outcome: 'created', invocationId: 'inv-0' }),
        update() {},
        get: () => null,
      },
      dispatchProposalStore: store,
    });
    await brokenApp.ready();

    try {
      const payloadB = {
        threadId: target.id,
        content: '@sonnet\nPlease fix the updated bug',
        targetCats: ['sonnet'],
        effectClass: 'assign_work',
        proposedAction: proposedReviewAction(),
        clientMessageId: 'dispatch-no-ingress-b',
      };
      const res = await brokenApp.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
        payload: payloadB,
      });
      assert.ok(res.statusCode >= 500, 'misconfigured ingress-less create must fail');

      const proposalAAfter = await store.get(proposalAId);
      assert.equal(proposalAAfter?.status, 'pending', 'existing pending proposal must not be superseded');

      const pending = await store.listPendingByUser('user-1');
      assert.equal(pending.length, 1, 'no staged successor may be created when ingress is missing');
      assert.equal(pending[0].proposalId, proposalAId, 'the original proposal must remain the sole pending record');

      const retry = await brokenApp.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
        payload: payloadB,
      });
      assert.ok(retry.statusCode >= 500, 'same-key retry must stay non-2xx while ingress is absent');
    } finally {
      await brokenApp.close();
      await app.close();
    }
  });
});
