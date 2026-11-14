import Fastify from 'fastify';

export async function createCoordinationCallbackHarness() {
  const { InvocationRegistry } = await import(
    '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
  );
  const { MessageStore } = await import('../../dist/domains/cats/services/stores/ports/MessageStore.js');
  const { ThreadStore } = await import('../../dist/domains/cats/services/stores/ports/ThreadStore.js');
  const { InMemoryDispatchProposalStore } = await import(
    '../../dist/domains/approval-hub/stores/ports/IDispatchProposalStore.js'
  );
  const { InvocationQueue } = await import('../../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
  const { buildCallbackPostMessageIdempotencyKey } = await import(
    '../../dist/domains/cats/services/agents/routing/callback-message-idempotency.js'
  );
  const { callbacksRoutes } = await import('../../dist/routes/callbacks.js');

  const broadcasts = [];
  const socketManager = {
    broadcastAgentMessage(...args) {
      broadcasts.push({ kind: 'agent', args });
    },
    broadcastToRoom(...args) {
      broadcasts.push({ kind: 'room', args });
    },
    emitToUser(...args) {
      broadcasts.push({ kind: 'user', args });
    },
    getBroadcasts() {
      return broadcasts;
    },
  };

  const records = [];
  const invocationRecordStore = {
    create(input) {
      const id = `inv-${records.length}`;
      records.push({ id, ...input });
      return { outcome: 'created', invocationId: id };
    },
    update() {},
    get() {
      return null;
    },
    getRecords() {
      return records;
    },
  };

  const registry = new InvocationRegistry();
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const dispatchProposalStore = new InMemoryDispatchProposalStore();
  const invocationQueue = new InvocationQueue();
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
      getExecutions() {
        return [];
      },
    },
    invocationRecordStore,
    dispatchProposalStore,
    invocationQueue,
    queueProcessor: { requestDrain() {} },
  });

  async function post({ auth, threadId, content, targetCat, replyTo, coordination, clientMessageId }) {
    return app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: {
        'x-invocation-id': auth.invocationId,
        'x-callback-token': auth.callbackToken,
      },
      payload: {
        ...(threadId ? { threadId } : {}),
        content,
        ...(targetCat ? { targetCats: [targetCat] } : {}),
        ...(replyTo ? { replyTo } : {}),
        ...(clientMessageId ? { clientMessageId } : {}),
        ...(coordination ? { coordination } : {}),
      },
    });
  }

  function threadMessages(threadId, userId = 'user-1') {
    return messageStore.getByThreadIncludingQueued(threadId, 100, userId);
  }

  return {
    app,
    registry,
    messageStore,
    threadStore,
    invocationQueue,
    socketManager,
    buildCallbackPostMessageIdempotencyKey,
    post,
    threadMessages,
  };
}
