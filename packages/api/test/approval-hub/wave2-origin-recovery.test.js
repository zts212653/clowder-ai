import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { proposedReviewAction } from './helpers.js';

function createSucceedingIngress() {
  return {
    async publish(draft, store) {
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

describe('staged recovery origin preservation', () => {
  let ApprovalCardCommittedError;
  let ApprovalIngress;
  let InvocationRegistry;
  let MessageStore;
  let ThreadStore;
  let callbacksRoutes;
  let InMemoryDispatchProposalStore;
  let InMemoryEntityProposalStore;
  let InMemoryTasteProposalStore;
  let callbackProposeEntityRoutes;
  let callbackProposeTasteRoutes;
  const apps = [];

  beforeEach(async () => {
    ({ ApprovalCardCommittedError, ApprovalIngress } = await import(
      '../../dist/domains/approval-hub/ApprovalIngress.js'
    ));
    ({ InvocationRegistry } = await import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'));
    ({ MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js'));
    ({ ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js'));
    ({ callbacksRoutes } = await import('../../dist/routes/callbacks.js'));
    ({ InMemoryDispatchProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
    ));
    ({ InMemoryEntityProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IEntityProposalStore.js'
    ));
    ({ InMemoryTasteProposalStore } = await import('../../dist/domains/taste/stores/InMemoryTasteProposalStore.js'));
    ({ callbackProposeEntityRoutes } = await import('../../dist/routes/callback-propose-entity-routes.js'));
    ({ callbackProposeTasteRoutes } = await import('../../dist/routes/callback-propose-taste-routes.js'));
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function buildCapturingIngress(drafts) {
    return {
      async publish(draft, store) {
        drafts.push(draft);
        if (drafts.length === 1) {
          throw new ApprovalCardCommittedError(new Error('commit unavailable'), 'msg-card-original');
        }
        return createSucceedingIngress().publish(draft, store);
      },
    };
  }

  it('F193 keeps the original originRef when a same-thread retry arrives from a later invocation', async () => {
    const store = new InMemoryDispatchProposalStore();
    const envelopes = [];
    const registry = new InvocationRegistry();
    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();
    const source = await threadStore.create('user-1', 'Source');
    const target = await threadStore.create('user-1', 'Target');
    await threadStore.addParticipants(source.id, ['opus']);
    await threadStore.addParticipants(target.id, ['sonnet']);
    const originA = await messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      threadId: source.id,
      content: 'Origin A',
      mentions: [],
      timestamp: Date.now() - 2000,
    });
    const originB = await messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      threadId: source.id,
      content: 'Origin B',
      mentions: [],
      timestamp: Date.now() - 1000,
    });

    const app = Fastify();
    apps.push(app);
    let commitCount = 0;
    const originalCommit = store.commitEnvelope.bind(store);
    store.commitEnvelope = (proposalId, envelope) => {
      envelopes.push(envelope);
      commitCount++;
      if (commitCount === 1) {
        throw new Error('simulated commitEnvelope failure');
      }
      return originalCommit(proposalId, envelope);
    };

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
      approvalIngress: new ApprovalIngress({
        messageStore,
        socketManager: { broadcastToRoom() {}, emitToUser() {} },
      }),
    });
    await app.ready();

    const firstAuth = await registry.create('user-1', 'opus', source.id, undefined, undefined, undefined, originA.id);
    const payload = {
      threadId: target.id,
      content: '@sonnet\nPlease fix the bug',
      targetCats: ['sonnet'],
      effectClass: 'assign_work',
      proposedAction: proposedReviewAction(),
      clientMessageId: 'dispatch-origin-preserve',
    };

    await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: {
        'x-invocation-id': firstAuth.invocationId,
        'x-callback-token': firstAuth.callbackToken,
      },
      payload,
    });
    const pending = await store.listPendingByUser('user-1');
    assert.equal(pending.length, 1, 'first attempt must leave exactly one staged proposal');
    const publication = await store.getPublication(pending[0].proposalId);
    assert.equal(publication?.state, 'staged', 'first attempt must leave the proposal staged');
    const retryAuth = await registry.create('user-1', 'opus', source.id, undefined, undefined, undefined, originB.id);

    const retry = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: {
        'x-invocation-id': retryAuth.invocationId,
        'x-callback-token': retryAuth.callbackToken,
      },
      payload,
    });
    assert.equal(retry.statusCode, 200);
    assert.deepEqual(envelopes[0].originRef, {
      kind: 'message',
      threadId: source.id,
      messageId: originA.id,
    });
    assert.deepEqual(envelopes[1].originRef, envelopes[0].originRef);
  });

  it('F260 keeps the original originRef when a same-thread retry arrives from a later invocation', async () => {
    const store = new InMemoryEntityProposalStore();
    const drafts = [];
    let currentAuth = {
      invocationId: 'inv-entity-original',
      originTriggerMessageId: 'msg-origin-a',
      a2aTriggerMessageId: undefined,
    };
    const app = Fastify();
    apps.push(app);
    app.addHook('preHandler', (request, _reply, done) => {
      request.callbackAuth = {
        invocationId: currentAuth.invocationId,
        callbackToken: 'tok',
        catId: 'opus',
        threadId: 'thread-original',
        userId: 'user-1',
        clientMessageIds: new Set(),
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        originTriggerMessageId: currentAuth.originTriggerMessageId,
        a2aTriggerMessageId: currentAuth.a2aTriggerMessageId,
      };
      done();
    });
    await app.register(callbackProposeEntityRoutes, {
      registry: { isLatest: async () => true },
      entityProposalStore: store,
      socketManager: { emitToUser() {} },
      approvalIngress: buildCapturingIngress(drafts),
    });
    await app.ready();

    const payload = {
      entityId: 'concept:origin-preserve',
      entityType: 'concept',
      canonicalName: 'Origin Preserve',
      aliases: ['origin-preserve'],
      stance: 'endorsed',
      visibilityScope: 'workspace',
      provenance: [{ source: 'test' }],
      rationale: 'Preserve the original invocation provenance',
      clientRequestId: 'entity-origin-preserve',
    };

    const first = await app.inject({ method: 'POST', url: '/api/callbacks/propose-entity', payload });
    assert.ok(first.statusCode >= 500);
    currentAuth = {
      invocationId: 'inv-entity-retry',
      originTriggerMessageId: 'msg-origin-b',
      a2aTriggerMessageId: undefined,
    };
    const retry = await app.inject({ method: 'POST', url: '/api/callbacks/propose-entity', payload });
    assert.equal(retry.statusCode, 200);
    assert.deepEqual(drafts[0].originRef, { kind: 'message', threadId: 'thread-original', messageId: 'msg-origin-a' });
    assert.deepEqual(drafts[1].originRef, drafts[0].originRef);
  });

  it('F221 keeps the original event origin when sourceMessageId was omitted', async () => {
    const store = new InMemoryTasteProposalStore();
    const drafts = [];
    let currentAuth = {
      invocationId: 'inv-taste-original',
      originTriggerMessageId: undefined,
      a2aTriggerMessageId: undefined,
    };
    const app = Fastify();
    apps.push(app);
    app.addHook('preHandler', (request, _reply, done) => {
      request.callbackAuth = {
        invocationId: currentAuth.invocationId,
        callbackToken: 'tok',
        catId: 'opus',
        threadId: 'thread-original',
        userId: 'user-1',
        clientMessageIds: new Set(),
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
        originTriggerMessageId: currentAuth.originTriggerMessageId,
        a2aTriggerMessageId: currentAuth.a2aTriggerMessageId,
      };
      done();
    });
    await app.register(callbackProposeTasteRoutes, {
      registry: { isLatest: async () => true },
      tasteProposalStore: store,
      socketManager: { emitToUser() {} },
      approvalIngress: buildCapturingIngress(drafts),
    });
    await app.ready();

    const payload = {
      scene: 'A stable taste signal',
      quote: 'Keep the original provenance',
      tags: ['authentic-expression'],
      dimension: 'authentic-expression',
      privacy: 'public',
      clientRequestId: 'taste-origin-preserve',
    };

    const first = await app.inject({ method: 'POST', url: '/api/callbacks/propose-taste', payload });
    assert.ok(first.statusCode >= 500);
    currentAuth = {
      invocationId: 'inv-taste-retry',
      originTriggerMessageId: 'msg-origin-b',
      a2aTriggerMessageId: undefined,
    };
    const retry = await app.inject({ method: 'POST', url: '/api/callbacks/propose-taste', payload });
    assert.equal(retry.statusCode, 200);
    assert.deepEqual(drafts[0].originRef, {
      kind: 'event',
      anchor: 'invocation:inv-taste-original',
      summary: 'Taste proposal from opus',
      threadId: 'thread-original',
    });
    assert.deepEqual(drafts[1].originRef, drafts[0].originRef);
  });
});
