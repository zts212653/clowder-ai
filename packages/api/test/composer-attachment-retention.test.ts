import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ContextAttachment } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../src/domains/cats/services/stores/redis/RedisMessageStore.js';
import type { SocketManager } from '../src/infrastructure/websocket/index.js';
import { composerDraftRecallRoutes } from '../src/routes/composer-draft-recall.js';
import { sendMessageSchema } from '../src/routes/messages.schema.js';

function comments(count: number, text = 'source'): ContextAttachment[] {
  return Array.from({ length: count }, (_, index) => ({
    v: 1,
    id: `quote-${index}`,
    kind: 'quote',
    text,
    comment: `comment ${index + 1}`,
    source: { kind: 'message', threadId: 'source', messageId: `message-${index}` },
  }));
}

for (const [count, text, canSend] of [
  [15, 'source', true],
  [3, 'x'.repeat(17_000), false],
] as const) {
  test(`owner draft preserves ${count} comments; sending has its own budget`, async (t) => {
    const app = Fastify();
    t.after(() => app.close());
    app.addHook('onRequest', async (request) => {
      request.sessionUserId = 'owner';
    });
    await app.register(composerDraftRecallRoutes, {
      messageStore: new MessageStore(),
      socketManager: { broadcastAgentMessage() {}, broadcastToRoom() {}, emitToUser() {} } as unknown as SocketManager,
    });
    const attachments = comments(count, text);
    const contentBlocks = attachments.map((attachment) => ({ type: 'context_attachment' as const, attachment }));
    const url = '/api/threads/retained-comments/composer-draft';
    const put = await app.inject({
      method: 'PUT',
      url,
      payload: { expectedRevision: 0, text: 'keep my words', contentBlocks },
    });
    assert.equal(put.statusCode, 200, put.body);
    assert.deepEqual((await app.inject({ method: 'GET', url })).json().draft.contentBlocks, contentBlocks);
    assert.equal(
      sendMessageSchema.safeParse({ content: 'keep my words', contextAttachments: attachments }).success,
      canSend,
    );
    assert.deepEqual((await app.inject({ method: 'GET', url })).json().draft.contentBlocks, contentBlocks);
  });
}

test('Redis owner-draft hydration preserves attachments beyond the send budget', async () => {
  const contentBlocks = comments(3, 'x'.repeat(17_000)).map((attachment) => ({
    type: 'context_attachment' as const,
    attachment,
  }));
  const record = {
    ownerUserId: 'owner',
    threadId: 'retained-comments',
    version: '1',
    revision: '7',
    updatedAt: String(Date.now()),
    text: 'unfinished but durable',
    contentBlocks: JSON.stringify(contentBlocks),
  };
  const redis = { options: {}, hgetall: async () => record } as unknown as ConstructorParameters<
    typeof RedisMessageStore
  >[0];
  const store = new RedisMessageStore(redis);
  assert.deepEqual((await store.getOwnerComposerDraft('owner', 'retained-comments'))?.contentBlocks, contentBlocks);
});
