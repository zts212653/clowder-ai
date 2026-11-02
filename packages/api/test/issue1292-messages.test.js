import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import Fastify from 'fastify';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { messagesRoutes } from '../dist/routes/messages.js';
import { successorFixture } from './helpers/successor-routing-fixture.js';

async function appFor(t, h) {
  const app = Fastify();
  await app.register(messagesRoutes, {
    registry: new InvocationRegistry(),
    router: h.router,
    messageStore: h.messages,
    threadStore: h.threads,
    invocationQueue: h.queue,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
  });
  t.after(() => app.close());
  return app;
}

it('POST /api/messages retains disabled mention warning and drain never falls back', async (t) => {
  const h = successorFixture(t);
  const app = await appFor(t, h);
  const response = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { threadId: h.threadId, content: '@opus work', idempotencyKey: randomUUID() },
  });
  assert.equal(response.statusCode, 202, response.body);
  const source = await h.messages.getById(response.json().userMessageId);
  assert.deepEqual(source.mentions, []);
  assert.equal(source.extra.routingWarnings[0].kind, 'cat_disabled');
  assert.equal(source.extra.routingWarnings[0].alternatives[0].mention, '@opus-5');
  assert.deepEqual((await h.ledger.list(h.threadId))[0].targets, []);
  await h.processor.requestDrain(h.threadId);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.threads.get(h.threadId).participants, []);
});

it('POST /api/messages implicit default persists canonical Queue recipient and participant only', async (t) => {
  const h = successorFixture(t);
  const app = await appFor(t, h);
  const response = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { threadId: h.threadId, content: 'work', idempotencyKey: randomUUID() },
  });
  assert.equal(response.statusCode, 202, response.body);
  assert.deepEqual((await h.ledger.list(h.threadId))[0].targets, ['opus-5']);
  assert.deepEqual(h.threads.get(h.threadId).participants, ['opus-5']);
  assert.deepEqual((await h.messages.getById(response.json().userMessageId)).mentions, []);
});

it('POST /api/messages selected disabled recipient fails before storing a source', async (t) => {
  const h = successorFixture(t);
  const app = await appFor(t, h);
  const response = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { threadId: h.threadId, content: 'work', mentions: ['opus'] },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(response.json().code, 'INVALID_EXPLICIT_TARGETS');
  assert.deepEqual(await h.ledger.list(h.threadId), []);
  assert.deepEqual(await h.messages.getByThread(h.threadId), []);
});
