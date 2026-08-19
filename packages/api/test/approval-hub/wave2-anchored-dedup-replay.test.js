import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { anchorApproval, proposedReviewAction } from './helpers.js';

describe('Wave 2 anchored dedup fanout replay', () => {
  let callbackProposeEntityRoutes;
  let callbackProposeTasteRoutes;
  let callbacksRoutes;
  let InMemoryDispatchProposalStore;
  let InMemoryEntityProposalStore;
  let InMemoryTasteProposalStore;
  let InvocationRegistry;
  let MessageStore;
  let ThreadStore;
  const apps = [];

  beforeEach(async () => {
    ({ callbackProposeEntityRoutes } = await import('../../dist/routes/callback-propose-entity-routes.js'));
    ({ callbackProposeTasteRoutes } = await import('../../dist/routes/callback-propose-taste-routes.js'));
    ({ callbacksRoutes } = await import('../../dist/routes/callbacks.js'));
    ({ InMemoryDispatchProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
    ));
    ({ InMemoryEntityProposalStore } = await import(
      '../../dist/domains/approval-hub/stores/ports/IEntityProposalStore.js'
    ));
    ({ InMemoryTasteProposalStore } = await import('../../dist/domains/taste/stores/InMemoryTasteProposalStore.js'));
    ({ InvocationRegistry } = await import('../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'));
    ({ MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js'));
    ({ ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js'));
  });

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function addCallbackAuth(app, invocationId, threadId) {
    app.addHook('preHandler', (request, _reply, done) => {
      request.callbackAuth = {
        invocationId,
        callbackToken: 'token',
        catId: 'opus',
        threadId,
        userId: 'user-1',
        clientMessageIds: new Set(),
        createdAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      };
      done();
    });
  }

  it('F260 and F221 route anchored dedup hits back through ApprovalIngress', async () => {
    const entityStore = new InMemoryEntityProposalStore();
    await entityStore.reserveDedup('user-1', 'entity-replay', 'entity-proposal');
    const entity = await entityStore.create({
      proposalId: 'entity-proposal',
      entityId: 'concept:replay',
      entityType: 'concept',
      canonicalName: 'Replay',
      aliases: ['replay'],
      stance: 'endorsed',
      visibilityScope: 'workspace',
      provenance: [{ source: 'test' }],
      rationale: 'Replay fanout after uncertain commit acknowledgement',
      sourceThreadId: 'thread-source',
      sourceCatId: 'opus',
      ownerUserId: 'user-1',
      clientRequestId: 'entity-replay',
      approvalOriginRef: { kind: 'event', threadId: 'thread-source', anchor: 'entity:first', summary: 'entity' },
    });
    await anchorApproval(entityStore, {
      proposalId: entity.proposalId,
      sourceFeatureId: 'F260',
      ownerUserId: 'user-1',
      requesterCatId: 'opus',
      threadId: 'thread-source',
      createdAt: entity.createdAt,
    });

    const tasteStore = new InMemoryTasteProposalStore();
    await tasteStore.reserveDedup('user-1', 'taste-replay', 'taste-proposal');
    const taste = await tasteStore.create({
      proposalId: 'taste-proposal',
      userId: 'user-1',
      catId: 'opus',
      threadId: 'thread-source',
      scene: 'Replay fanout',
      quote: 'Anchored retries still traverse ingress',
      tags: ['cognitive-honesty'],
      dimension: 'cognitive-honesty',
      privacy: 'public',
      clientRequestId: 'taste-replay',
      approvalOriginRef: { kind: 'event', threadId: 'thread-source', anchor: 'taste:first', summary: 'taste' },
    });
    await anchorApproval(tasteStore, {
      proposalId: taste.id,
      sourceFeatureId: 'F221',
      ownerUserId: 'user-1',
      requesterCatId: 'opus',
      threadId: 'thread-source',
      createdAt: taste.createdAt,
    });

    const fixtures = [
      {
        route: callbackProposeEntityRoutes,
        deps: { registry: {}, entityProposalStore: entityStore },
        url: '/api/callbacks/propose-entity',
        body: {
          entityId: 'concept:replay',
          entityType: 'concept',
          canonicalName: 'Replay',
          aliases: ['replay'],
          stance: 'endorsed',
          visibilityScope: 'workspace',
          provenance: [{ source: 'test' }],
          rationale: 'Replay fanout after uncertain commit acknowledgement',
          clientRequestId: 'entity-replay',
        },
        expectedId: entity.proposalId,
      },
      {
        route: callbackProposeTasteRoutes,
        deps: { registry: { isLatest: async () => true }, tasteProposalStore: tasteStore },
        url: '/api/callbacks/propose-taste',
        body: {
          scene: 'Replay fanout',
          quote: 'Anchored retries still traverse ingress',
          tags: ['cognitive-honesty'],
          dimension: 'cognitive-honesty',
          privacy: 'public',
          clientRequestId: 'taste-replay',
        },
        expectedId: taste.id,
      },
    ];

    for (const fixture of fixtures) {
      const drafts = [];
      const app = Fastify();
      apps.push(app);
      addCallbackAuth(app, `inv-${fixture.expectedId}`, 'thread-source');
      await app.register(fixture.route, {
        ...fixture.deps,
        socketManager: { emitToUser() {}, broadcastToRoom() {} },
        approvalIngress: { publish: async (draft) => drafts.push(draft) },
      });
      await app.ready();

      const response = await app.inject({ method: 'POST', url: fixture.url, payload: fixture.body });

      assert.equal(response.statusCode, 200);
      assert.equal(response.json().proposalId, fixture.expectedId);
      assert.equal(drafts.length, 1, 'anchored dedup retry must traverse ingress replay');
      assert.equal(drafts[0].canonicalProposalId, fixture.expectedId);
    }
  });

  it('F193 routes an anchored clientMessageId hit back through ApprovalIngress', async () => {
    const registry = new InvocationRegistry();
    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();
    const source = await threadStore.create('user-1', 'Source');
    const target = await threadStore.create('user-1', 'Target');
    await threadStore.addParticipants(source.id, ['opus']);
    await threadStore.addParticipants(target.id, ['sonnet']);
    const auth = await registry.create('user-1', 'opus', source.id);
    const store = new InMemoryDispatchProposalStore();
    const created = await store.create({
      proposalId: 'dispatch-proposal',
      sourceThreadId: source.id,
      targetThreadId: target.id,
      senderCatId: 'opus',
      ownerUserId: 'user-1',
      content: '@sonnet\nPlease take this work',
      targetCats: ['sonnet'],
      clientMessageId: 'dispatch-replay',
      approvalOriginRef: { kind: 'event', threadId: source.id, anchor: 'dispatch:first', summary: 'dispatch' },
      createdAt: Date.now(),
    });
    await anchorApproval(store, {
      proposalId: created.proposal.proposalId,
      sourceFeatureId: 'F193',
      ownerUserId: 'user-1',
      requesterCatId: 'opus',
      threadId: source.id,
      createdAt: created.proposal.createdAt,
    });
    const drafts = [];
    const app = Fastify();
    apps.push(app);
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      threadStore,
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
      router: { async *routeExecution() {}, getExecutions: () => [] },
      invocationRecordStore: { create: () => ({ outcome: 'created' }), update() {}, get: () => null },
      dispatchProposalStore: store,
      approvalIngress: { publish: async (draft) => drafts.push(draft) },
    });
    await app.ready();

    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': auth.invocationId, 'x-callback-token': auth.callbackToken },
      payload: {
        threadId: target.id,
        content: '@sonnet\nPlease take this work',
        targetCats: ['sonnet'],
        effectClass: 'assign_work',
        proposedAction: proposedReviewAction(),
        clientMessageId: 'dispatch-replay',
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().proposalId, created.proposal.proposalId);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0].canonicalProposalId, created.proposal.proposalId);
  });

  it('replays both fanout channels when commit persisted but acknowledgement was lost', async () => {
    const { ApprovalIngress } = await import('../../dist/domains/approval-hub/ApprovalIngress.js');
    const store = new InMemoryEntityProposalStore();
    const messageStore = new MessageStore();
    const broadcasts = [];
    const userEvents = [];
    const ingress = new ApprovalIngress({
      messageStore,
      socketManager: {
        broadcastToRoom: (...args) => broadcasts.push(args),
        emitToUser: (...args) => userEvents.push(args),
      },
    });
    const originalCommit = store.commitEnvelope.bind(store);
    let firstCommit = true;
    store.commitEnvelope = async (...args) => {
      await originalCommit(...args);
      if (firstCommit) {
        firstCommit = false;
        throw new Error('simulated lost commit acknowledgement');
      }
    };

    const app = Fastify();
    apps.push(app);
    addCallbackAuth(app, 'inv-uncertain-commit', 'thread-source');
    await app.register(callbackProposeEntityRoutes, {
      registry: {},
      entityProposalStore: store,
      socketManager: { emitToUser() {}, broadcastToRoom() {} },
      approvalIngress: ingress,
    });
    await app.ready();
    const payload = {
      entityId: 'concept:uncertain-commit',
      entityType: 'concept',
      canonicalName: 'Uncertain Commit',
      aliases: ['uncertain-commit'],
      stance: 'endorsed',
      visibilityScope: 'workspace',
      provenance: [{ source: 'test' }],
      rationale: 'Replay fanout after the durable commit acknowledgement is lost',
      clientRequestId: 'entity-uncertain-commit',
    };

    const first = await app.inject({ method: 'POST', url: '/api/callbacks/propose-entity', payload });
    assert.ok(first.statusCode >= 500);
    const proposalId = await store.getDedupProposalId('user-1', payload.clientRequestId);
    assert.equal((await store.getPublication(proposalId))?.state, 'anchored');
    assert.equal(broadcasts.length, 0);
    assert.equal(userEvents.length, 0);

    const retry = await app.inject({ method: 'POST', url: '/api/callbacks/propose-entity', payload });
    assert.equal(retry.statusCode, 200);
    assert.equal(retry.json().proposalId, proposalId);
    assert.equal(broadcasts.length, 1, 'thread card fanout must be replayed');
    assert.equal(userEvents.length, 1, 'Hub proposal_created fanout must be replayed');
    assert.equal(messageStore.getByThread('thread-source', 100).length, 1, 'retry must not append a second card');
  });
});
