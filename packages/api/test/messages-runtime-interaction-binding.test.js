import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runtimeInteractionRequestSchema } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { InMemoryQueueLedgerStore } from '../dist/domains/cats/services/agents/invocation/queue-ledger/InMemoryQueueLedgerStore.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { MessageRuntimeInteractionCardPublisher } from '../dist/domains/runtime-interaction/RuntimeInteractionCardPublisher.js';
import { messagesRoutes } from '../dist/routes/messages.js';

async function fixture(t) {
  const messageStore = new MessageStore();
  const app = Fastify();
  t.after(() => app.close());
  await app.register(messagesRoutes, {
    registry: new InvocationRegistry(),
    messageStore,
    socketManager: { broadcastAgentMessage() {} },
    invocationQueue: new InvocationQueue(new InMemoryQueueLedgerStore()),
  });
  await app.ready();
  const publisher = new MessageRuntimeInteractionCardPublisher({
    messageStore,
    socketManager: { broadcastToRoom() {} },
  });
  async function publish(kind, userId = 'default-user') {
    const base = {
      version: 1,
      interactionId: `history-${kind}-${userId}`,
      kind,
      owner: { userId, threadId: 'history-thread', catId: 'codex61-sol', invocationId: 'history-invocation' },
      createdAt: 1000,
      title: 'Keep 原文',
    };
    const provider = { providerId: 'openai', method: 'item/tool/requestUserInput', requestId: 'history-request' };
    const decisions = [{ id: 'accept', label: 'Allow once', outcome: 'accept' }];
    const presentations = {
      approval: { provider, decisions },
      question: {
        provider,
        questions: [{ id: 'environment', header: 'Environment', question: 'Where should it run?' }],
      },
      elicitation: {
        provider,
        mode: 'form',
        message: 'Provide details',
        requestedSchema: { type: 'object', properties: {}, additionalProperties: false },
        decisions,
      },
      conversation_decision: {
        presentation: {
          id: 'conversation-block',
          kind: 'interactive',
          v: 1,
          interactiveType: 'select',
          options: [{ id: 'alpha', label: 'Alpha' }],
        },
        allowTextResponse: false,
      },
    };
    const request = runtimeInteractionRequestSchema.parse({ ...base, ...presentations[kind] });
    const ref = await publisher.prepare(request);
    return messageStore.getById(ref.messageId);
  }
  return { app, messageStore, publish };
}

for (const kind of ['approval', 'question', 'elicitation', 'conversation_decision']) {
  test(`history retains the original publisher's ${kind} binding and presentation`, async (t) => {
    const { app, publish } = await fixture(t);
    const stored = await publish(kind);
    const original = JSON.stringify(stored);
    const response = await app.inject({ method: 'GET', url: '/api/messages?threadId=history-thread' });
    assert.equal(response.statusCode, 200);
    const visible = response.json().messages.find((message) => message.id === stored.id);
    assert.deepEqual(visible?.extra?.runtimeInteractionCard, stored.extra.runtimeInteractionCard);
    assert.deepEqual(visible.extra.rich, stored.extra.rich);
    assert.equal(visible.content, stored.content);
    assert.equal(JSON.stringify(stored), original, 'History projection leaves the stored original intact');
  });
}

test('a runtime binding survives independently of other extra carriers', async (t) => {
  const { app, messageStore } = await fixture(t);
  const binding = { version: 1, interactionId: 'binding-only', blockId: 'unavailable', requestKind: 'question' };
  messageStore.append({
    userId: 'default-user',
    threadId: 'history-thread',
    from: { kind: 'agent', catId: 'codex61-sol' },
    content: 'A binding alone does not authorize title translation.',
    mentions: [],
    timestamp: 1000,
    extra: { runtimeInteractionCard: binding },
  });
  const response = await app.inject({ method: 'GET', url: '/api/messages?threadId=history-thread' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().messages[0].extra, { runtimeInteractionCard: binding });
});

test('history keeps another owner’s interaction binding outside the visible message set', async (t) => {
  const { app, publish } = await fixture(t);
  const mine = await publish('question');
  await publish('approval', 'another-owner');
  const response = await app.inject({ method: 'GET', url: '/api/messages?threadId=history-thread' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(
    response.json().messages.map((message) => message.id),
    [mine.id],
  );
});
