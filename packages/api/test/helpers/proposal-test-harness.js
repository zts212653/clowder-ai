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
  taskStoreOverride,
  routerOverride,
  invocationQueueOverride,
  queueProcessorOverride,
  fetchPrTrackingBoundaryOverride,
} = {}) {
  const { InvocationRegistry } = await import(
    '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
  );
  const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
  const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
  const { InMemoryProposalStore } = await import('../../dist/domains/cats/services/stores/ports/ProposalStore.js');
  const { TaskStore } = await import('../../dist/domains/cats/services/stores/ports/TaskStore.js');
  const { callbacksRoutes, proposalRoutes } = await import('../../dist/routes/index.js');

  const registry = new InvocationRegistry();
  const threadStore = new ThreadStore();
  const messageStore = messageStoreOverride ?? new MessageStore();
  const proposalStore = proposalStoreOverride ?? new InMemoryProposalStore();
  const taskStore = taskStoreOverride ?? new TaskStore();
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
    taskStore,
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
    taskStore,
    messageStore,
    socketManager,
    ...(routerOverride ? { router: routerOverride } : {}),
    ...(invocationQueueOverride ? { invocationQueue: invocationQueueOverride } : {}),
    ...(queueProcessorOverride ? { queueProcessor: queueProcessorOverride } : {}),
    ...(fetchPrTrackingBoundaryOverride ? { fetchPrTrackingBoundary: fetchPrTrackingBoundaryOverride } : {}),
  });

  const originByRequest = new Map();
  async function propose({ userId, catId = 'opus', threadId, body = {} }) {
    const dedupKey = body.clientRequestId ? `${userId}:${catId}:${threadId}:${body.clientRequestId}` : undefined;
    let origin = dedupKey ? originByRequest.get(dedupKey) : undefined;
    if (!origin) {
      origin = messageStore.append({
        userId,
        catId: null,
        content: 'Please propose a child thread',
        mentions: [],
        timestamp: Date.now(),
        threadId,
      });
      if (dedupKey) originByRequest.set(dedupKey, origin);
    }
    const { invocationId, callbackToken } = await registry.create(userId, catId, threadId, undefined, origin.id);
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

  async function withdraw({ userId, catId, threadId, proposalId }) {
    const origin = await messageStore.append({
      userId,
      catId: null,
      content: `Withdraw thread proposal ${proposalId}`,
      mentions: [],
      timestamp: Date.now(),
      threadId,
    });
    const { invocationId, callbackToken } = await registry.create(userId, catId, threadId, undefined, origin.id);
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/withdraw-thread-proposal',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: { proposalId },
    });
  }

  return {
    app,
    registry,
    threadStore,
    messageStore,
    proposalStore,
    taskStore,
    socketManager,
    socketEvents,
    router: routerOverride,
    invocationQueue: invocationQueueOverride,
    queueProcessor: queueProcessorOverride,
    propose,
    approve,
    reject,
    withdraw,
  };
}
