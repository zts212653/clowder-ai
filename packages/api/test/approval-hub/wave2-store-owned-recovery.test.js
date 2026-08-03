import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { proposedReviewAction } from './helpers.js';

function succeedingIngress() {
  return {
    async publish(draft, store) {
      const envelope = {
        canonicalProposalId: draft.canonicalProposalId,
        sourceFeatureId: draft.producerId,
        ownerUserId: draft.ownerUserId,
        requesterCatId: draft.requesterCatId,
        originRef: draft.originRef,
        approvalCardRef: { threadId: draft.cardThreadId, messageId: `card-${draft.canonicalProposalId}` },
        createdAt: draft.createdAt,
      };
      await store.commitEnvelope(draft.canonicalProposalId, envelope);
      return envelope;
    },
  };
}

function installCallbackAuth(app, threadId = 'thread-source') {
  app.addHook('preHandler', (request, _reply, done) => {
    request.callbackAuth = {
      invocationId: 'inv-store-owned-recovery',
      callbackToken: 'tok',
      catId: 'opus',
      threadId,
      userId: 'user-1',
      clientMessageIds: new Set(),
      createdAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    };
    done();
  });
}

describe('Wave 2 store-owned recovery boundaries', () => {
  it('keeps a staged dispatch holder authoritative across a different-key lineage race', async () => {
    const [{ InvocationRegistry }, { MessageStore }, { ThreadStore }, { InMemoryDispatchProposalStore }, callbacks] =
      await Promise.all([
        import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'),
        import('../../dist/domains/cats/services/stores/ports/MessageStore.js'),
        import('../../dist/domains/cats/services/stores/ports/ThreadStore.js'),
        import('../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'),
        import('../../dist/routes/callbacks.js'),
      ]);
    const registry = new InvocationRegistry();
    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();
    const source = await threadStore.create('user-1', 'Source');
    const target = await threadStore.create('user-1', 'Target');
    await threadStore.addParticipants(source.id, ['opus']);
    await threadStore.addParticipants(target.id, ['sonnet']);
    const store = new InMemoryDispatchProposalStore();

    let markPublishStarted;
    const publishStarted = new Promise((resolve) => {
      markPublishStarted = resolve;
    });
    let releaseFirstPublish;
    const firstPublishReleased = new Promise((resolve) => {
      releaseFirstPublish = resolve;
    });
    let publishCount = 0;
    const ingress = {
      async publish(draft, publicationStore) {
        publishCount++;
        if (publishCount === 1) {
          markPublishStarted();
          await firstPublishReleased;
        }
        return succeedingIngress().publish(draft, publicationStore);
      },
    };

    const app = Fastify();
    await app.register(callbacks.callbacksRoutes, {
      registry,
      messageStore,
      threadStore,
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      router: { async *routeExecution() {}, getExecutions: () => [] },
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
    const request = (clientMessageId) => ({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: {
        threadId: target.id,
        content: '@sonnet\nPlease fix the bug',
        targetCats: ['sonnet'],
        effectClass: 'assign_work',
        proposedAction: proposedReviewAction(),
        clientMessageId,
      },
    });

    try {
      const firstPromise = app.inject(request('dispatch-lineage-a'));
      await publishStarted;
      const overlapping = await app.inject(request('dispatch-lineage-b'));
      assert.equal(overlapping.statusCode, 503);
      assert.equal(overlapping.json().status, 'retryable');
      assert.equal(publishCount, 1, 'overlapping successor must not enter ingress');

      releaseFirstPublish();
      const first = await firstPromise;
      assert.equal(first.statusCode, 200);

      const retry = await app.inject(request('dispatch-lineage-b'));
      assert.equal(retry.statusCode, 200);
      assert.notEqual(retry.json().proposalId, first.json().proposalId);
      assert.equal((await store.get(first.json().proposalId)).status, 'superseded');
    } finally {
      releaseFirstPublish();
      await app.close();
    }
  });

  it('recovers an F260 proposal after create persisted but its acknowledgement was lost', async () => {
    const [{ InMemoryEntityProposalStore }, { callbackProposeEntityRoutes }] = await Promise.all([
      import('../../dist/domains/approval-hub/stores/ports/IEntityProposalStore.js'),
      import('../../dist/routes/callback-propose-entity-routes.js'),
    ]);
    class AmbiguousEntityStore extends InMemoryEntityProposalStore {
      failOnce = true;
      create(input) {
        const proposal = super.create(input);
        if (this.failOnce) {
          this.failOnce = false;
          throw new Error('entity create acknowledgement lost');
        }
        return proposal;
      }
    }
    const store = new AmbiguousEntityStore();
    const app = Fastify();
    installCallbackAuth(app);
    await app.register(callbackProposeEntityRoutes, {
      registry: { isLatest: async () => true },
      entityProposalStore: store,
      socketManager: { emitToUser() {} },
      approvalIngress: succeedingIngress(),
    });
    await app.ready();
    const payload = {
      entityId: 'concept:ambiguous-create',
      entityType: 'concept',
      canonicalName: 'Ambiguous create',
      aliases: ['ambiguous-create'],
      stance: 'endorsed',
      visibilityScope: 'workspace',
      provenance: [{ source: 'test' }],
      rationale: 'Recover the materialized canonical proposal',
      clientRequestId: 'entity-ambiguous-create',
    };
    try {
      const first = await app.inject({ method: 'POST', url: '/api/callbacks/propose-entity', payload });
      assert.ok(first.statusCode >= 500);
      const retry = await app.inject({ method: 'POST', url: '/api/callbacks/propose-entity', payload });
      assert.equal(retry.statusCode, 200);
      assert.equal(retry.json().recovered, true);
      assert.equal(store.listPending('user-1').length, 1);
    } finally {
      await app.close();
    }
  });

  it('recovers an F221 proposal after create persisted but its acknowledgement was lost', async () => {
    const [{ InMemoryTasteProposalStore }, { callbackProposeTasteRoutes }] = await Promise.all([
      import('../../dist/domains/taste/stores/InMemoryTasteProposalStore.js'),
      import('../../dist/routes/callback-propose-taste-routes.js'),
    ]);
    class AmbiguousTasteStore extends InMemoryTasteProposalStore {
      failOnce = true;
      create(input) {
        const proposal = super.create(input);
        if (this.failOnce) {
          this.failOnce = false;
          throw new Error('taste create acknowledgement lost');
        }
        return proposal;
      }
    }
    const store = new AmbiguousTasteStore();
    const app = Fastify();
    installCallbackAuth(app);
    await app.register(callbackProposeTasteRoutes, {
      registry: { isLatest: async () => true },
      tasteProposalStore: store,
      socketManager: { emitToUser() {} },
      approvalIngress: succeedingIngress(),
    });
    await app.ready();
    const payload = {
      scene: 'A materialized proposal survives an ambiguous create response',
      quote: 'Keep one canonical record',
      tags: ['cognitive-honesty'],
      dimension: 'cognitive-honesty',
      privacy: 'public',
      clientRequestId: 'taste-ambiguous-create',
    };
    try {
      const first = await app.inject({ method: 'POST', url: '/api/callbacks/propose-taste', payload });
      assert.ok(first.statusCode >= 500);
      const retry = await app.inject({ method: 'POST', url: '/api/callbacks/propose-taste', payload });
      assert.equal(retry.statusCode, 200);
      assert.equal(retry.json().recovered, true);
      assert.equal(store.listPending('user-1').length, 1);
    } finally {
      await app.close();
    }
  });
});
