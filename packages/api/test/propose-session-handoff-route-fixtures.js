import Fastify from 'fastify';

export const ACTIVE = {
  id: 'sess_active',
  status: 'active',
  catId: 'opus',
  threadId: 'thread_1',
  userId: 'user_1',
};

export async function createMessageStore() {
  const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
  return new MessageStore();
}

export async function createHandoffStore() {
  const { InMemorySessionHandoffProposalStore } = await import(
    '../dist/domains/cats/services/stores/ports/SessionHandoffProposalStore.js'
  );
  return new InMemorySessionHandoffProposalStore();
}

export async function buildCtx({ messageStoreOverride, sessionChainStoreOverride, handoffStoreOverride } = {}) {
  const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
  const { callbacksRoutes } = await import('../dist/routes/index.js');

  const registry = new InvocationRegistry();
  const messageStore = messageStoreOverride ?? (await createMessageStore());
  const handoffStore = handoffStoreOverride ?? (await createHandoffStore());
  const sessionChainStore = sessionChainStoreOverride ?? {
    getActive: async (catId, threadId) => (catId === ACTIVE.catId && threadId === ACTIVE.threadId ? ACTIVE : null),
  };
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
    handoffProposalStore: handoffStore,
    sessionChainStore,
    evidenceStore: {
      ingestRaw() {},
      search() {
        return [];
      },
    },
    markerQueue: { enqueue() {} },
    reflectionService: { reflect() {} },
  });

  const originByRequest = new Map();
  async function propose({ userId = 'user_1', catId = 'opus', threadId = 'thread_1', body } = {}) {
    const payload = body ?? { done: 'wrote A1 store', nextSteps: 'wire route' };
    const key = payload.clientRequestId ? `${userId}:${catId}:${threadId}:${payload.clientRequestId}` : undefined;
    let origin = key ? originByRequest.get(key) : undefined;
    if (!origin) {
      origin = await messageStore.append({
        userId,
        catId: null,
        content: 'Please hand off this session',
        mentions: [],
        timestamp: Date.now(),
        threadId,
      });
      if (key) originByRequest.set(key, origin);
    }
    const { invocationId, callbackToken } = await registry.create(userId, catId, threadId, undefined, origin.id);
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/propose-session-handoff',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload,
    });
  }

  return { app, registry, messageStore, handoffStore, socketEvents, propose };
}
