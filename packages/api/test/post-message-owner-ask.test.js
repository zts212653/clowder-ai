/**
 * Dropped-ball guard on the post_message callback. Only an explicit mention reaches the
 * owner's mailbox (2026-10-10 decision), so a post that waits for the owner — or carries an
 * interactive card — without a line-start mention and without routing to a cat is sent back
 * to the cat before it is stored, and the cat fixes it in the same turn.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';

describe('post_message: an owner ask without a mention is sent back', () => {
  let registry;
  let messageStore;

  beforeEach(async () => {
    const { InvocationRegistry } = await import(
      '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js'
    );
    const { MessageStore } = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    registry = new InvocationRegistry();
    messageStore = new MessageStore();
  });

  async function post(threadId, content) {
    const { callbacksRoutes } = await import('../dist/routes/callbacks.js');
    const { DeliveryCursorStore } = await import('../dist/domains/cats/services/stores/ports/DeliveryCursorStore.js');
    const { InvocationQueue } = await import('../dist/domains/cats/services/agents/invocation/InvocationQueue.js');
    const app = Fastify();
    await app.register(callbacksRoutes, {
      registry,
      messageStore,
      socketManager: { broadcastAgentMessage() {}, emitToUser() {}, getMessages: () => [] },
      deliveryCursorStore: new DeliveryCursorStore(),
      invocationQueue: new InvocationQueue(),
      queueProcessor: { async requestDrain() {} },
      sharedBank: 'cat-cafe-shared',
    });
    const session = await registry.create('user-1', 'opus', threadId);
    const res = await app.inject({
      method: 'POST',
      url: '/api/callbacks/post-message',
      headers: { 'x-invocation-id': session.invocationId, 'x-callback-token': session.callbackToken },
      payload: { content },
    });
    return { status: res.statusCode, body: JSON.parse(res.body), stored: messageStore.getByThread(threadId) };
  }

  const card = JSON.stringify({
    v: 1,
    blocks: [
      {
        id: 'pick-1',
        kind: 'interactive',
        v: 1,
        interactiveType: 'select',
        title: '用哪一张？',
        options: [
          { id: 'a', label: '第一张' },
          { id: 'b', label: '第二张' },
        ],
      },
    ],
  });

  it('refuses a message that waits for the owner, before storing it', async () => {
    const { status, body, stored } = await post('thread-a', '样片已经导出。\n\n等你确认清晰度后我再批量处理。');
    assert.equal(status, 422);
    assert.equal(body.kind, 'owner_ask_without_mention');
    assert.equal(body.ownerAsk, 'wait');
    assert.match(body.message, /决策漏斗/);
    assert.deepEqual(stored, []);
  });

  it('refuses an interactive card that mentions nobody', async () => {
    const { status, body, stored } = await post('thread-b', `两张形象图在卡里。\n\n\`\`\`cc_rich\n${card}\n\`\`\``);
    assert.equal(status, 422);
    assert.equal(body.ownerAsk, 'card');
    assert.deepEqual(stored, []);
  });

  it('accepts the same ask once the cat mentions the owner, and the mailbox receives it', async () => {
    const { status } = await post('thread-c', '样片已经导出。\n\n@co-creator\n等你确认清晰度后我再批量处理。');
    assert.equal(status, 200);
    assert.equal(messageStore.listUserMentionRequests('user-1').length, 1);
  });

  it('accepts an ordinary update and a message routed to a cat', async () => {
    assert.equal((await post('thread-d', '测试全部通过，已经合入。')).status, 200);
    assert.equal((await post('thread-e', '@codex\n等co-creator点头之后，请把三样接进样机。')).status, 200);
    assert.deepEqual(messageStore.listUserMentionRequests('user-1'), []);
  });
});
