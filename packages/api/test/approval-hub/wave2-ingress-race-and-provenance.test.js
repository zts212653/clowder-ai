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

describe('F193 concurrent dispatch publication', () => {
  it('keeps the post-create dedup loser retryable until the winner is anchored', async () => {
    const { InvocationRegistry } = await import(
      '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
    const { InMemoryDispatchProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
    );
    const { callbacksRoutes } = await import('../../dist/routes/callbacks.js');

    class ConcurrentDispatchStore extends InMemoryDispatchProposalStore {
      winningResult;

      async findByClientMessageId() {
        return null;
      }

      async create(input) {
        if (this.winningResult) {
          return {
            proposal: await this.get(this.winningResult.proposal.proposalId),
            supersededProposals: [],
          };
        }
        this.winningResult = await super.create(input);
        return this.winningResult;
      }
    }

    const registry = new InvocationRegistry();
    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();
    const source = await threadStore.create('user-1', 'Source');
    const target = await threadStore.create('user-1', 'Target');
    await threadStore.addParticipants(source.id, ['opus']);
    await threadStore.addParticipants(target.id, ['sonnet']);
    const store = new ConcurrentDispatchStore();

    let publishStarted;
    const started = new Promise((resolve) => {
      publishStarted = resolve;
    });
    let releasePublish;
    const canPublish = new Promise((resolve) => {
      releasePublish = resolve;
    });
    const ingress = {
      async publish(draft, publicationStore) {
        publishStarted();
        await canPublish;
        return createSucceedingIngress().publish(draft, publicationStore);
      },
    };

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
      approvalIngress: ingress,
    });
    await app.ready();
    const auth = await registry.create('user-1', 'opus', source.id);
    const request = {
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: {
        threadId: target.id,
        content: '@sonnet\nPlease fix the bug',
        targetCats: ['sonnet'],
        effectClass: 'assign_work',
        proposedAction: proposedReviewAction(),
        clientMessageId: 'dispatch-concurrent-staged',
      },
    };

    try {
      const winnerPromise = app.inject(request);
      await started;

      const loser = await app.inject(request);
      assert.equal(loser.statusCode, 503, 'staged winner must not be returned as proposal_exists');
      assert.equal(loser.json().status, 'retryable');
      assert.equal(loser.headers['retry-after'], '1');

      releasePublish();
      const winner = await winnerPromise;
      assert.equal(winner.statusCode, 200);

      const anchoredRetry = await app.inject(request);
      assert.equal(anchoredRetry.statusCode, 200);
      assert.equal(anchoredRetry.json().status, 'proposal_exists');
      assert.equal(anchoredRetry.json().proposalId, winner.json().proposalId);
    } finally {
      await app.close();
    }
  });
});

describe('staged recovery provenance', () => {
  let ApprovalCardCommittedError;
  let InMemoryEntityProposalStore;
  let InMemoryTasteProposalStore;
  let callbackProposeEntityRoutes;
  let callbackProposeTasteRoutes;
  const apps = [];

  beforeEach(async () => {
    ({ ApprovalCardCommittedError } = await import('../../dist/domains/approval-hub/ApprovalIngress.js'));
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

  it('F260 retries a staged proposal in its persisted source thread', async () => {
    const store = new InMemoryEntityProposalStore();
    const drafts = [];
    let currentThreadId = 'thread-original';
    const app = Fastify();
    apps.push(app);
    app.addHook('preHandler', (request, _reply, done) => {
      request.callbackAuth = {
        invocationId: 'inv-entity-recovery',
        callbackToken: 'tok',
        catId: 'opus',
        threadId: currentThreadId,
        userId: 'user-1',
        clientMessageIds: new Set(),
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
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
      entityId: 'concept:recovery-thread',
      entityType: 'concept',
      canonicalName: 'Recovery Thread',
      aliases: ['recovery-thread'],
      stance: 'endorsed',
      visibilityScope: 'workspace',
      provenance: [{ source: 'test' }],
      rationale: 'Prove recovery stays with the original card',
      clientRequestId: 'entity-original-thread',
    };

    const first = await app.inject({ method: 'POST', url: '/api/callbacks/propose-entity', payload });
    assert.ok(first.statusCode >= 500);
    currentThreadId = 'thread-retry';
    const wrongThreadRetry = await app.inject({ method: 'POST', url: '/api/callbacks/propose-entity', payload });
    assert.equal(wrongThreadRetry.statusCode, 409);
    assert.equal(wrongThreadRetry.json().status, 'origin_thread_required');
    assert.equal(drafts.length, 1, 'wrong-thread retry must not append or reuse a card there');

    currentThreadId = 'thread-original';
    const retry = await app.inject({ method: 'POST', url: '/api/callbacks/propose-entity', payload });
    assert.equal(retry.statusCode, 200);
    assert.equal(drafts[1].cardThreadId, 'thread-original');
    assert.equal(drafts[1].originRef.threadId, 'thread-original');
  });

  it('F221 retries a staged proposal in its persisted source thread', async () => {
    const store = new InMemoryTasteProposalStore();
    const drafts = [];
    let currentThreadId = 'thread-original';
    const app = Fastify();
    apps.push(app);
    app.addHook('preHandler', (request, _reply, done) => {
      request.callbackAuth = {
        invocationId: 'inv-taste-recovery',
        callbackToken: 'tok',
        catId: 'opus',
        threadId: currentThreadId,
        userId: 'user-1',
        clientMessageIds: new Set(),
        createdAt: Date.now(),
        expiresAt: Date.now() + 3600000,
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
      quote: 'Keep the original thread',
      tags: ['authentic-expression'],
      dimension: 'authentic-expression',
      privacy: 'public',
      sourceMessageId: 'msg-original',
      clientRequestId: 'taste-original-thread',
    };

    const first = await app.inject({ method: 'POST', url: '/api/callbacks/propose-taste', payload });
    assert.ok(first.statusCode >= 500);
    currentThreadId = 'thread-retry';
    const wrongThreadRetry = await app.inject({ method: 'POST', url: '/api/callbacks/propose-taste', payload });
    assert.equal(wrongThreadRetry.statusCode, 409);
    assert.equal(wrongThreadRetry.json().status, 'origin_thread_required');
    assert.equal(drafts.length, 1, 'wrong-thread retry must not append or reuse a card there');

    currentThreadId = 'thread-original';
    const retry = await app.inject({ method: 'POST', url: '/api/callbacks/propose-taste', payload });
    assert.equal(retry.statusCode, 200);
    assert.equal(drafts[1].cardThreadId, 'thread-original');
    assert.equal(drafts[1].originRef.threadId, 'thread-original');
  });
});
