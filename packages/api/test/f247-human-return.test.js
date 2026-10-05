import assert from 'node:assert/strict';
import { test } from 'node:test';
import Fastify from 'fastify';
import { MemoryCloudReturnGrantStore } from '../dist/domains/cats/services/cloud-bridge/cloud-return-grant.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

test('cloud replies to the human persist without routing to a cat, with optional human mention', async (t) => {
  const previousOwner = process.env.DEFAULT_OWNER_USER_ID;
  process.env.DEFAULT_OWNER_USER_ID = 'alice';
  t.after(() => {
    if (previousOwner === undefined) delete process.env.DEFAULT_OWNER_USER_ID;
    else process.env.DEFAULT_OWNER_USER_ID = previousOwner;
  });
  const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
  const { InvocationRegistry } = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
  const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
  const { AgentKeyRegistry } = await import('../dist/domains/cats/services/agents/agent-key/AgentKeyRegistry.js');
  const { ThreadStore } = await import('../dist/domains/cats/services/stores/ports/ThreadStore.js');
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const thread = await threadStore.create('alice', 'Human cloud reply');
  const agentKeyRegistry = new AgentKeyRegistry();
  const cloudReturnGrantStore = new MemoryCloudReturnGrantStore();
  const invocationQueue = new InvocationQueue();
  const broadcasts = [];
  const { secret } = await agentKeyRegistry.issue('gpt-pro', 'alice');
  const app = Fastify();
  t.after(() => app.close());
  await app.register(callbacksRoutes, {
    registry: new InvocationRegistry(),
    agentKeyRegistry,
    cloudReturnGrantStore,
    messageStore,
    threadStore,
    invocationQueue,
    socketManager: { broadcastAgentMessage: (message) => broadcasts.push(message), emitToUser() {} },
  });
  for (const content of ['在呢，You。', '@co-creator\n在呢。']) {
    const source = messageStore.append({
      userId: 'alice',
      catId: null,
      threadId: thread.id,
      content: '@gpt-pro 砚砚喵',
      mentions: ['gpt-pro'],
      timestamp: Date.now(),
    });
    await cloudReturnGrantStore.issue({
      threadId: thread.id,
      userId: 'alice',
      sourceMessageId: source.id,
      dispatchInvocationId: `dispatch-${source.id}`,
      targetCatId: 'gpt-pro',
    });
    const payload = { threadId: thread.id, replyTo: source.id, content };
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-agent-key-secret': secret },
        payload,
      });
    const response = await send();
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().status, 'ok');
    assert.deepEqual(response.json().routed, []);
    const stored = await messageStore.getById(response.json().messageId);
    assert.equal(stored.replyTo, source.id);
    assert.equal(stored.content, content);
    assert.deepEqual(stored.mentions, []);
    assert.equal(Boolean(stored.mentionsUser), content.startsWith('@co-creator'));
    const retry = await send();
    assert.equal(retry.json().status, 'duplicate');
    assert.equal(retry.json().messageId, stored.id);
  }
  assert.equal(broadcasts.length, 2);
  assert.deepEqual(invocationQueue.list(thread.id, 'alice'), []);
});
