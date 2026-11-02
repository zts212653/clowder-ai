import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { it } from 'node:test';
import Fastify from 'fastify';
import { getRoster, isCatAvailable } from '../dist/config/cat-config-loader.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { messagesRoutes } from '../dist/routes/messages.js';
import { queueRoutes } from '../dist/routes/queue.js';
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

it('POST /api/messages rejects disabled mention before storage and never drains a fallback', async (t) => {
  const h = successorFixture(t);
  const app = await appFor(t, h);
  const response = await app.inject({
    method: 'POST',
    url: '/api/messages',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { threadId: h.threadId, content: '@opus work', idempotencyKey: randomUUID() },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().routingWarnings[0].kind, 'cat_disabled');
  assert.equal(response.json().routingWarnings[0].alternatives[0].mention, '@opus-5');
  assert.deepEqual(await h.messages.getByThread(h.threadId), []);
  assert.deepEqual(await h.ledger.list(h.threadId), []);
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

it('same prose request replays its committed target even when availability changes', async (t) => {
  const h = successorFixture(t);
  const app = await appFor(t, h);
  const request = {
    method: 'POST',
    url: '/api/messages',
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: { threadId: h.threadId, content: '@opus work', idempotencyKey: randomUUID() },
  };
  getRoster().opus = { ...getRoster().opus, available: true };
  const first = await app.inject(request);
  assert.equal(first.statusCode, 202, first.body);
  getRoster().opus = { ...getRoster().opus, available: false };
  const replay = await app.inject(request);
  assert.equal(replay.statusCode, 202, replay.body);
  assert.equal(replay.json().userMessageId, first.json().userMessageId);
  const rows = await h.ledger.list(h.threadId);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].targets, ['opus']);
  assert.equal(rows[0].payload.routingWarnings, undefined);
});

it('Steer cannot persist unknown/sentinel Queue recipients or thread participants', async (t) => {
  const h = successorFixture(t);
  const from = { kind: 'user', userId: 'owner' };
  const admitted = await h.queue.send(
    h.messages,
    {
      threadId: h.threadId,
      userId: 'owner',
      from,
      content: 'work',
      mentions: ['codex'],
      timestamp: 1,
      deliveryStatus: 'queued',
      idempotencyKey: randomUUID(),
    },
    {
      threadId: h.threadId,
      userId: 'owner',
      from,
      kind: 'conversation_input',
      ownerAuthProvenance: 'strict',
      content: 'work',
      targetCats: ['codex'],
      intent: 'execute',
    },
  );
  const app = Fastify();
  await app.register(queueRoutes, {
    threadStore: h.threads,
    invocationQueue: h.queue,
    messageStore: h.messages,
    queueProcessor: { registerCallerDispatchSteerChanges() {}, async requestDrain() {} },
    invocationTracker: { has: () => false, getUserId: () => null, getActiveSlots: () => [] },
    isCatAvailable,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} },
  });
  t.after(() => app.close());
  const response = await app.inject({
    method: 'POST',
    url: `/api/threads/${h.threadId}/queue/${admitted.entry.id}/targets`,
    headers: { 'x-cat-cafe-user': 'owner' },
    payload: {
      sourceRecordId: admitted.message.id,
      observedPendingTargetIds: ['codex'],
      targets: ['__none__', 'ghost'].map((targetCatId) => ({
        targetCatId,
        strategy: 'guide_reply',
        membershipAtOpen: 'admit',
      })),
    },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.ok(
    (await h.ledger.list(h.threadId)).every((entry) =>
      entry.targets.every((id) => !['__none__', 'ghost'].includes(id)),
    ),
  );
  assert.deepEqual(h.threads.get(h.threadId).participants, []);
});
