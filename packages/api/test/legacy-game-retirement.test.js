import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { messagesRoutes } from '../dist/routes/messages.js';

test('old game threads remain readable conversations; /game is ordinary queued input', async () => {
  const app = Fastify();
  const threadStore = new ThreadStore();
  const thread = threadStore.create('legacy-owner', 'Historical werewolf', 'games/werewolf');
  const messageStore = new MessageStore();
  const socketEvents = [];
  const invocationQueue = new InvocationQueue(new InMemoryQueueLedgerStore());
  await app.register(messagesRoutes, {
    registry: { get: () => undefined },
    messageStore,
    threadStore,
    invocationQueue,
    queueProcessor: { async requestDrain() {} },
    socketManager: {
      broadcastToRoom: (_room, event) => socketEvents.push(event),
      broadcastAgentMessage() {},
      emitToUser() {},
    },
    router: {
      async resolveTargetsAndIntent() {
        return { targetCats: ['opus'], intent: { intent: 'execute', explicit: false, promptTags: [] } };
      },
      async ackCollectedCursors() {},
    },
  });
  const headers = { 'x-cat-cafe-user': 'legacy-owner' };
  try {
    for (const content of ['Continue this conversation', '/game werewolf god-view voice']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/messages',
        headers,
        payload: { threadId: thread.id, content },
      });
      assert.equal(response.statusCode, 202, response.body);
      assert.equal(response.json().status, 'queued');
      assert.equal(response.json().gameId, undefined);
      messageStore.markDelivered(response.json().userMessageId, Date.now());
      assert.equal(messageStore.getById(response.json().userMessageId).threadId, thread.id);
    }
    const history = await app.inject({ url: `/api/messages?threadId=${thread.id}`, headers });
    assert.equal(history.statusCode, 200, history.body);
    assert.deepEqual(
      history.json().messages.map((message) => message.content),
      ['Continue this conversation', '/game werewolf god-view voice'],
    );
    assert.equal(
      socketEvents.some((event) => event.startsWith('game:')),
      false,
    );
  } finally {
    await app.close();
  }
});
