/**
 * F121 Enhancement: Auto-replyTo for A2A-triggered invocations
 *
 * When a cat is invoked via @mention (A2A), the system should auto-fill
 * replyTo with the trigger message ID — the cat should NOT need to
 * explicitly pass it.
 *
 * RED → GREEN → REFACTOR
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

describe('auto-replyTo for A2A invocations', () => {
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

  test('auto-fills replyTo from trigger message when cat does not pass replyTo', async () => {
    // 1. Simulate the trigger message (cat A @mentions cat B)
    const triggerMsg = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: '请帮忙看一下\n@codex',
      mentions: ['codex'],
      timestamp: Date.now(),
      threadId: 'thread-1',
    });

    // 2. Create InvocationRecordStore record (as enqueueA2ATargets would)
    const createResult = invocationRecordStore.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['codex'],
      intent: 'execute',
      idempotencyKey: `a2a:${triggerMsg.id}:codex`,
    });
    // Set userMessageId (as callback-a2a-trigger.ts does)
    invocationRecordStore.update(createResult.invocationId, {
      userMessageId: triggerMsg.id,
    });

    // 3. Create InvocationRegistry record with parentInvocationId
    //    (as invokeSingleCat does for A2A-triggered cats)
    const { invocationId, callbackToken } = registry.create(
      'user-1',
      'codex',
      'thread-1',
      createResult.invocationId, // parentInvocationId
    );

    // 4. Cat B calls post_message WITHOUT replyTo
    const app = await createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: '收到！我来看看',
      },
    });

    assert.equal(response.statusCode, 200);

    // P3-1: Response body should echo the actual effective replyTo
    const body = JSON.parse(response.body);
    assert.equal(body.replyTo, triggerMsg.id, 'Response should echo auto-filled replyTo');

    // 5. The stored message should have replyTo auto-filled
    const recent = messageStore.getRecent(10);
    const replyMsg = recent.find((m) => m.content === '收到！我来看看');
    assert.ok(replyMsg, 'Reply message should be stored');
    assert.equal(replyMsg.replyTo, triggerMsg.id, 'replyTo should be auto-filled with trigger message ID');

    // 6. Broadcast should include replyTo and replyPreview
    const broadcasted = socketManager.getMessages();
    const broadcastMsg = broadcasted.find((m) => m.content === '收到！我来看看');
    assert.ok(broadcastMsg, 'Message should be broadcast');
    assert.equal(broadcastMsg.replyTo, triggerMsg.id, 'Broadcast should include replyTo');
    assert.ok(broadcastMsg.replyPreview, 'Broadcast should include replyPreview');
    assert.equal(broadcastMsg.replyPreview.senderCatId, 'opus');
  });

  // Worklist path tests → auto-reply-to-worklist.test.js (file size cap)

  test('explicit replyTo takes precedence over auto-fill', async () => {
    // Trigger message
    const triggerMsg = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: '请看一下\n@codex',
      mentions: ['codex'],
      timestamp: Date.now(),
      threadId: 'thread-1',
    });

    // A different message the cat wants to reply to explicitly
    const otherMsg = messageStore.append({
      userId: 'user-1',
      catId: null,
      content: '用户的另一条消息',
      mentions: [],
      timestamp: Date.now(),
      threadId: 'thread-1',
    });

    // InvocationRecordStore setup
    const createResult = invocationRecordStore.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['codex'],
      intent: 'execute',
      idempotencyKey: `a2a:${triggerMsg.id}:codex`,
    });
    invocationRecordStore.update(createResult.invocationId, {
      userMessageId: triggerMsg.id,
    });

    const { invocationId, callbackToken } = registry.create('user-1', 'codex', 'thread-1', createResult.invocationId);

    const app = await createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: '回复其他消息',
        replyTo: otherMsg.id, // Explicit replyTo
      },
    });

    assert.equal(response.statusCode, 200);

    // P3-1: Response should echo the validated explicit replyTo
    const body = JSON.parse(response.body);
    assert.equal(body.replyTo, otherMsg.id, 'Response should echo explicit replyTo');

    const recent = messageStore.getRecent(10);
    const replyMsg = recent.find((m) => m.content === '回复其他消息');
    assert.equal(replyMsg.replyTo, otherMsg.id, 'Explicit replyTo should take precedence');
  });

  test('no auto-fill when invocation has no parentInvocationId (direct user message)', async () => {
    // Direct user invocation — no parentInvocationId
    const { invocationId, callbackToken } = registry.create('user-1', 'opus', 'thread-1');

    const app = await createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: '直接用户请求的回复',
      },
    });

    assert.equal(response.statusCode, 200);

    // P3-1: Response should NOT contain replyTo when none applies
    const body = JSON.parse(response.body);
    assert.equal(body.replyTo, undefined, 'Response should omit replyTo when none applies');

    const recent = messageStore.getRecent(10);
    const msg = recent.find((m) => m.content === '直接用户请求的回复');
    assert.equal(msg.replyTo, undefined, 'Should not auto-fill replyTo for direct user invocations');
  });

  test('P3-2: no auto-fill when parentInvocationRecord threadId mismatches', async () => {
    // Trigger message exists in thread-1
    const triggerMsg = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: '请看\n@codex',
      mentions: ['codex'],
      timestamp: Date.now(),
      threadId: 'thread-1',
    });

    // InvocationRecord created for thread-1
    const createResult = invocationRecordStore.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['codex'],
      intent: 'execute',
      idempotencyKey: `a2a:${triggerMsg.id}:codex:p3`,
    });
    invocationRecordStore.update(createResult.invocationId, {
      userMessageId: triggerMsg.id,
    });

    // But the cat's invocation is registered in thread-2
    // (simulates a cross-thread A2A where parent record's threadId doesn't match)
    const { invocationId, callbackToken } = registry.create('user-1', 'codex', 'thread-2', createResult.invocationId);

    const app = await createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: 'P3-2 hardening test',
      },
    });

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.replyTo, undefined, 'Should not auto-fill when parentRecord threadId mismatches');

    const recent = messageStore.getRecent(10);
    const msg = recent.find((m) => m.content === 'P3-2 hardening test');
    assert.equal(msg.replyTo, undefined, 'Stored message should not have replyTo');
  });

  test('no auto-fill when trigger message is in different thread', async () => {
    // Trigger message in thread-1
    const triggerMsg = messageStore.append({
      userId: 'user-1',
      catId: 'opus',
      content: '请看\n@codex',
      mentions: ['codex'],
      timestamp: Date.now(),
      threadId: 'thread-1',
    });

    const createResult = invocationRecordStore.create({
      threadId: 'thread-1',
      userId: 'user-1',
      targetCats: ['codex'],
      intent: 'execute',
      idempotencyKey: `a2a:${triggerMsg.id}:codex`,
    });
    invocationRecordStore.update(createResult.invocationId, {
      userMessageId: triggerMsg.id,
    });

    // Cat posts in thread-2 (cross-thread scenario — trigger was in thread-1)
    const { invocationId, callbackToken } = registry.create('user-1', 'codex', 'thread-2', createResult.invocationId);

    const app = await createApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
      payload: {
        content: '跨 thread 回复',
      },
    });

    assert.equal(response.statusCode, 200);

    const recent = messageStore.getRecent(10);
    const msg = recent.find((m) => m.content === '跨 thread 回复');
    assert.equal(msg.replyTo, undefined, 'Should not auto-fill replyTo when trigger is in different thread');
  });
});
