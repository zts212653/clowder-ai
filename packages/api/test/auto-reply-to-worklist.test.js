/**
 * F121: Auto-replyTo worklist path tests
 * Split from auto-reply-to.test.js to stay under 350-line cap.
 *
 * Tests the worklist path where a2aTriggerMessageId is set directly
 * on the InvocationRegistry record by route-serial.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, test } from 'node:test';
import Fastify from 'fastify';
import './helpers/setup-cat-registry.js';

function createMockSocketManager() {
  const messages = [];
  return {
    broadcastAgentMessage(msg) {
      messages.push(msg);
    },
    broadcastToRoom() {},
    getMessages() {
      return messages;
    },
  };
}

describe('auto-replyTo: worklist path (a2aTriggerMessageId)', () => {
  let registry;
  let messageStore;
  let invocationRecordStore;
  let socketManager;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const { InvocationRecordStore } = await import(
      '../dist/domains/cats/services/stores/ports/InvocationRecordStore.js'
    );

    registry = new InvocationRegistry();
    messageStore = new MessageStore();
    invocationRecordStore = new InvocationRecordStore();
    socketManager = createMockSocketManager();
  });

  async function createApp() {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager,
      invocationRecordStore,
      sharedBank: 'cat-cafe-shared',
    });
    return app;
  }

  test('auto-fills replyTo from a2aTriggerMessageId (not user message)', async () => {
    // 1. User's original message (what InvocationRecordStore.userMessageId points to)
    const userMsg = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '请三只猫讨论',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-1',
    });

    // 2. Cat A's message that @mentions Cat B (the actual A2A trigger)
    const catAMsg = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: '砚砚帮我看看\n@codex',
      mentions: ['codex'],
      timestamp: Date.now(),
      threadId: 'thread-1',
    });

    // 3. InvocationRecordStore has the USER message (top-level invocation)
    const createResult = invocationRecordStore.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['opus'],
      intent: 'execute',
      idempotencyKey: `top:${userMsg.id}`,
    });
    invocationRecordStore.update(createResult.invocationId, {
      userMessageId: userMsg.id,
    });

    // 4. InvocationRegistry with BOTH parentInvocationId AND a2aTriggerMessageId
    const { invocationId, callbackToken } = registry.create(
      'user-1',
      'codex',
      'thread-1',
      createResult.invocationId,
      catAMsg.id,
    );

    // 5. Cat B replies WITHOUT explicit replyTo
    const app = await createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: '收到，opus！我来看',
      },
    });

    assert.equal(response.statusCode, 200);

    const body = JSON.parse(response.body);
    assert.equal(body.replyTo, catAMsg.id, 'Should reply to Cat A @mention, not user message');

    const recent = messageStore.getRecent(10);
    const replyMsg = recent.find((m) => m.content === '收到，opus！我来看');
    assert.equal(replyMsg.replyTo, catAMsg.id, 'Stored replyTo should be Cat A @mention');
    assert.notEqual(replyMsg.replyTo, userMsg.id, 'Should NOT be user message');
  });

  test('re-mentioned pending cat gets latest triggerMessageId', async () => {
    const catAMsg = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: '帮我看看\n@sonnet',
      mentions: ['sonnet'],
      timestamp: Date.now(),
      threadId: 'thread-1',
    });

    const catBMsg = messageStore.append({
      userId: 'user-1',
      catId: 'codex',
      content: 'sonnet 你也看看\n@sonnet',
      mentions: ['sonnet'],
      timestamp: Date.now() + 100,
      threadId: 'thread-1',
    });

    const { invocationId, callbackToken } = registry.create('user-1', 'sonnet', 'thread-1', 'parent-inv-1', catBMsg.id);

    const app = await createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: '收到两位！',
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.replyTo, catBMsg.id, 'Should reply to latest @mention (Cat B)');
    assert.notEqual(body.replyTo, catAMsg.id, 'Should NOT reply to Cat A old message');

    const recent = messageStore.getRecent(10);
    const replyMsg = recent.find((m) => m.content === '收到两位！');
    assert.equal(replyMsg.replyTo, catBMsg.id);
  });
});
