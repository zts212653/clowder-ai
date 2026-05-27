/**
 * F128 proposal test harness — shared setup so each proposal test file stays under the
 * 350-line hard limit (AC-X1). Returns a fresh context object per test setup; tests then
 * pull `app`, `threadStore`, `proposalStore`, `registry`, `messageStore`, `socketEvents`,
 * and the http helpers (`propose`, `approve`, `reject`) from there.
 */

import Fastify from 'fastify';

export async function createProposalTestContext({
  proposalStoreOverride,
  messageStoreOverride,
  routerOverride,
  invocationQueueOverride,
  queueProcessorOverride,
} = {}) {
  const { InvocationRegistry } = await import(
    '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
  );
  const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
  const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
  const { InMemoryProposalStore } = await import('../../dist/domains/cats/services/stores/ports/ProposalStore.js');
  const { callbacksRoutes, proposalRoutes } = await import('../../dist/routes/index.js');

  const registry = new InvocationRegistry();
  const threadStore = new ThreadStore();
  const messageStore = messageStoreOverride ?? new MessageStore();
  const proposalStore = proposalStoreOverride ?? new InMemoryProposalStore();
  const socketEvents = [];
  const socketManager = {
    emitToUser(userId, event, data) {
      socketEvents.push({ kind: 'user', userId, event, data });
    },
    broadcastToRoom(room, event, data) {
      socketEvents.push({ kind: 'room', room, event, data });
    },
  };

  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore,
    socketManager,
    threadStore,
    proposalStore,
    evidenceStore: {
      ingestRaw() {},
      search() {
        return [];
      },
    },
    markerQueue: { enqueue() {} },
    reflectionService: { reflect() {} },
  });
  await app.register(proposalRoutes, {
    proposalStore,
    threadStore,
    messageStore,
    socketManager,
    ...(routerOverride ? { router: routerOverride } : {}),
    ...(invocationQueueOverride ? { invocationQueue: invocationQueueOverride } : {}),
    ...(queueProcessorOverride ? { queueProcessor: queueProcessorOverride } : {}),
  });

  async function propose({ userId, catId = 'opus', threadId, body = {} }) {
    const { invocationId, callbackToken } = await registry.create(userId, catId, threadId);
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-thread',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { title: 'New thread', reason: 'Because', ...body },
    });
  }

  async function approve(userId, proposalId, body = {}) {
    return app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/approve`,
      headers: { 'x-cat-cafe-user': userId, 'content-type': 'application/json' },
      payload: body,
    });
  }

  async function reject(userId, proposalId, body = {}) {
    return app.inject({
      method: 'POST',
      url: `/api/proposals/${proposalId}/reject`,
      headers: { 'x-cat-cafe-user': userId, 'content-type': 'application/json' },
      payload: body,
    });
  }

  return {
    app,
    registry,
    threadStore,
    messageStore,
    proposalStore,
    socketManager,
    socketEvents,
    router: routerOverride,
    invocationQueue: invocationQueueOverride,
    queueProcessor: queueProcessorOverride,
    propose,
    approve,
    reject,
  };
}
