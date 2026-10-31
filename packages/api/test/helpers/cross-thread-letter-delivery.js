import assert from 'node:assert/strict';
import './setup-cat-registry.js';
import Fastify from 'fastify';
import { InvocationRegistry } from '../../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { MessageStore } from '../../dist/domains/cats/services/stores/ports/MessageStore.js';
import { ThreadStore } from '../../dist/domains/cats/services/stores/ports/ThreadStore.js';
import { callbacksRoutes } from '../../dist/routes/callbacks.js';
import { createPersistedQueueFixture } from './persisted-queue-fixture.ts';

/** Real callback ingress and owner stores, isolated in memory; no model, network or Redis execution. */
export async function deliverCrossThreadLetterProof() {
  const registry = new InvocationRegistry();
  const messageStore = new MessageStore();
  const threadStore = new ThreadStore();
  const source = threadStore.create('letter-proof-owner', '来源设计对话 · Design source', '/proof');
  const target = threadStore.create('letter-proof-owner', '来信收件箱', '/proof');
  const { invocationId, callbackToken } = await registry.create('letter-proof-owner', 'opus', source.id);
  const f = createPersistedQueueFixture(messageStore, { registry });
  await f.turns.createRunning({
    invocationId,
    parentInvocationId: invocationId,
    threadId: source.id,
    userId: 'letter-proof-owner',
    catId: 'opus',
    executionKind: 'ordinary',
    startedAt: Date.now(),
  });
  const app = Fastify();
  await app.register(callbacksRoutes, {
    registry,
    messageStore,
    threadStore,
    socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {} },
    invocationQueue: f.queue,
    queueProcessor: f.processor,
    invocationRecordStore: f.records,
    invocationTracker: f.tracker,
    turnExecutionStore: f.turns,
  });
  try {
    for (const [name, content, targetCats] of [
      ['cat', '@codex\n\n这封信来自另一条真实回调投递。', ['codex']],
      ['human', '@co-creator\n\n请你判断。\n\n' + '长信 · Long letter paragraph.\n\n'.repeat(80), undefined],
    ]) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/callbacks/post-message',
        headers: { 'x-invocation-id': invocationId, 'x-callback-token': callbackToken },
        payload: {
          threadId: target.id,
          content,
          ...(targetCats ? { targetCats } : {}),
          clientMessageId: `letter-${name}`,
        },
      });
      assert.equal(response.statusCode, 200, response.body);
    }
    const messages = messageStore
      .getByThread(target.id, 10, 'letter-proof-owner', { includeQueuedCatMessages: true })
      .filter((m) => m.extra?.crossPost);
    assert.equal(messages.length, 2);
    assert.deepEqual(messages[0].extra.targetCats, ['codex']);
    assert.equal(messages[1].mentionsUser, true, 'human letter uses the existing attention authority');
    for (const message of messages) {
      assert.equal(message.extra.crossPost.sourceThreadId, source.id);
      assert.equal(message.extra.crossPost.sourceInvocationId, invocationId);
    }
    return { source, target, invocationId, messages: messages.map((m) => ({ ...m, type: 'assistant' })) };
  } finally {
    await f.close();
    await app.close();
  }
}
