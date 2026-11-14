import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { messagesRoutes } from '../dist/routes/messages.js';

let app;
afterEach(async () => app?.close());
test('owner can read an acceptance receipt without publishing or resubmitting queued input', async () => {
  const store = new MessageStore();
  const message = await store.append({
    from: { kind: 'user', userId: 'owner' },
    userId: 'owner',
    threadId: 'thread-a',
    content: 'private input',
    mentions: ['opus'],
    deliveryStatus: 'queued',
    idempotencyKey: 'attempt-a',
    timestamp: 123,
  });
  app = Fastify();
  await app.register(messagesRoutes, { messageStore: store, router: {}, registry: {}, socketManager: {} });
  const read = (thread = 'thread-a', owner = 'owner') =>
    app.inject({
      method: 'GET',
      url: `/api/threads/${thread}/message-attempts/attempt-a`,
      headers: { 'x-cat-cafe-user': owner },
    });
  const result = await read();
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.deepEqual(result.json(), { status: 'accepted', userMessage: { id: message.id, timestamp: 123 } });
  assert.equal((await store.getById(message.id)).deliveryStatus, 'queued');
  assert.deepEqual((await read('thread-b')).json(), { status: 'unknown' });
  assert.deepEqual((await read('thread-a', 'other-owner')).json(), { status: 'unknown' });
  const browser = await app.inject({
    method: 'GET',
    url: '/api/threads/thread-a/message-attempts/attempt-a',
    headers: { origin: 'https://untrusted.test', 'x-cat-cafe-user': 'owner' },
  });
  assert.equal(browser.statusCode, 401);
  await store.markDelivered(message.id, 456);
  assert.equal((await read()).json().status, 'delivered');
});

test('HTTP admission retains browser correlation for owner recovery without adding it to message extra', async () => {
  const key = '4e7dbe16-a8cf-4c1c-a314-6c978d685f03';
  const store = new MessageStore();
  const queue = new InvocationQueue();
  app = Fastify();
  await app.register(messagesRoutes, {
    messageStore: store,
    invocationQueue: queue,
    registry: {},
    socketManager: { emitToUser() {} },
    router: {
      previewTargets: async () => ({ targetCats: ['opus'], reason: { kind: 'default_cat' } }),
      resolveTargetsAndIntent: async () => ({
        targetCats: ['opus'],
        intent: { intent: 'execute' },
        routing_warnings: [],
      }),
    },
  });
  const admitted = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { content: 'ordinary input', threadId: 'thread-a', idempotencyKey: key },
  });
  assert.equal(admitted.statusCode, 202, admitted.body);
  const stored = await store.getById(admitted.json().userMessageId);
  assert.equal(stored.clientMessageId, key);
  assert.equal(stored.extra?.clientMessageId, undefined);
  assert.equal(stored.idempotencyKey, undefined, 'transport idempotency remains an index input');
  await store.markDelivered(stored.id, 456);
  const history = await app.inject({
    method: 'GET',
    url: '/api/messages?threadId=thread-a',
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  assert.equal(history.json().messages.find((message) => message.id === stored.id)?.clientMessageId, key);
  const another = await store.append({
    from: { kind: 'user', userId: 'other' },
    userId: 'other',
    threadId: 'thread-a',
    content: 'another owner',
    mentions: [],
    clientMessageId: 'other-key',
    timestamp: 500,
  });
  const cat = await store.append({
    from: { kind: 'agent', catId: 'opus' },
    userId: 'owner',
    threadId: 'thread-a',
    content: 'cat reply',
    mentions: [],
    clientMessageId: 'must-not-project',
    timestamp: 600,
  });
  const privateHistory = await app.inject({
    method: 'GET',
    url: '/api/messages?threadId=thread-a',
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  for (const id of [another.id, cat.id])
    assert.equal(privateHistory.json().messages.find((message) => message.id === id)?.clientMessageId, undefined);
});

test('an unavailable receipt store returns 503 rather than claiming the attempt is absent', async () => {
  const store = new MessageStore();
  store.getByIdempotencyKey = async () => {
    throw new Error('isolated read failure');
  };
  app = Fastify();
  await app.register(messagesRoutes, { messageStore: store, router: {}, registry: {}, socketManager: {} });
  const result = await app.inject({
    method: 'GET',
    url: '/api/threads/thread/message-attempts/key',
    headers: { 'x-cat-cafe-user': 'owner' },
  });
  assert.equal(result.statusCode, 503);
  assert.equal(result.headers['cache-control'], 'no-store');
  assert.equal(result.json().status, undefined);
});
