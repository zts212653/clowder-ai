import '../helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { proposedReviewAction } from './helpers.js';

describe('Wave 2 producer retry identity gate', () => {
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

  it('F260 and F221 reject missing clientRequestId before create or publish', async () => {
    const cases = [
      {
        route: callbackProposeEntityRoutes,
        storeName: 'entityProposalStore',
        store: new InMemoryEntityProposalStore(),
        registry: {},
        url: '/api/callbacks/propose-entity',
        body: {
          entityId: 'concept:retry-key',
          entityType: 'concept',
          canonicalName: 'Retry Key',
          aliases: ['retry-key'],
          stance: 'endorsed',
          visibilityScope: 'workspace',
          provenance: [{ source: 'test' }],
          rationale: 'Publication must be recoverable',
        },
        list: (store) => store.listPending('user-1'),
      },
      {
        route: callbackProposeTasteRoutes,
        storeName: 'tasteProposalStore',
        store: new InMemoryTasteProposalStore(),
        registry: { isLatest: async () => true },
        url: '/api/callbacks/propose-taste',
        body: {
          scene: 'Retry identity matters',
          quote: 'Do not retain an unreachable staged proposal',
          tags: ['cognitive-honesty'],
          dimension: 'cognitive-honesty',
          privacy: 'public',
        },
        list: (store) => store.listPending('user-1'),
      },
    ];

    for (const fixture of cases) {
      let publishCalls = 0;
      const app = Fastify();
      apps.push(app);
      addCallbackAuth(app, `inv-${fixture.storeName}`, 'thread-source');
      await app.register(fixture.route, {
        registry: fixture.registry,
        [fixture.storeName]: fixture.store,
        socketManager: { emitToUser() {}, broadcastToRoom() {} },
        approvalIngress: { publish: async () => publishCalls++ },
      });
      await app.ready();

      const response = await app.inject({ method: 'POST', url: fixture.url, payload: fixture.body });

      assert.equal(response.statusCode, 400, `${fixture.url} must require a retry identity`);
      assert.equal((await fixture.list(fixture.store)).length, 0, 'no proposal may be persisted');
      assert.equal(publishCalls, 0, 'ingress must not run without a recoverable identity');
    }
  });

  it('F193 assign_work rejects missing clientMessageId before dispatch store mutation', async () => {
    const registry = new InvocationRegistry();
    const messageStore = new MessageStore();
    const threadStore = new ThreadStore();
    const source = await threadStore.create('user-1', 'Source');
    const target = await threadStore.create('user-1', 'Target');
    await threadStore.addParticipants(source.id, ['opus']);
    await threadStore.addParticipants(target.id, ['sonnet']);
    const auth = await registry.create('user-1', 'opus', source.id);
    const store = new InMemoryDispatchProposalStore();
    let publishCalls = 0;
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
      approvalIngress: { publish: async () => publishCalls++ },
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
      },
    });

    assert.equal(response.statusCode, 400);
    assert.equal((await store.listPendingByUser('user-1')).length, 0);
    assert.equal(publishCalls, 0);
  });
});
