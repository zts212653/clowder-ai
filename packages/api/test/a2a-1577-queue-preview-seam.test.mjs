import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.ts';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.ts';
import { enrichQueueEntries } from '../src/utils/queue-enrichment.ts';

test('real preview retains public connector identity and blocks without exposing the nested owner ledger', async () => {
  const messages = new MessageStore();
  const queue = new InvocationQueue();
  const message = {
    userId: 'preview-owner',
    threadId: 'preview-thread',
    from: { kind: 'external', connectorId: 'weixin' },
    content: 'queued preview',
    mentions: ['codex'],
    timestamp: 1,
    deliveryStatus: 'queued',
    source: { connector: 'weixin', label: 'owned preview' },
    replyTo: 'owned-reply',
    contentBlocks: [{ type: 'text', text: 'rich body' }],
  };
  const admitted = await queue.send(messages, message, {
    ...message,
    kind: 'conversation_input',
    ownerAuthProvenance: 'unknown',
    targetCats: ['codex'],
    intent: 'execute',
  });
  const [dto] = await enrichQueueEntries([admitted.entry], messages);
  assert.deepEqual(dto.messagePreview, {
    connector: 'weixin',
    replyTo: 'owned-reply',
    contentBlocks: message.contentBlocks,
  });
  assert.equal(dto.content, message.content);
  assert.deepEqual(dto.targetCats, ['codex']);
  for (const internal of ['payload', 'execution', 'owner', 'delivery', 'queueCustody', 'queueMessageReceipt'])
    assert.equal(Object.hasOwn(dto, internal), false, internal);
  assert.deepEqual(await queue.getDurableEntry(message.threadId, admitted.entry.id), admitted.entry);
});

test('connector-only preview is retained; private work and missing History cannot manufacture receipt state', async () => {
  const queue = new InvocationQueue();
  const base = {
    threadId: 'preview-thread',
    userId: 'preview-owner',
    from: { kind: 'external', connectorId: 'owned' },
    content: 'body',
    ownerAuthProvenance: 'unknown',
    targetCats: ['codex'],
    intent: 'execute',
  };
  const publicEntry = (
    await queue.enqueueDurable({ ...base, kind: 'conversation_input', messageId: 'preview-message' })
  ).entry;
  const privateEntry = (await queue.enqueueDurable({ ...base, kind: 'private_input', sourceId: 'preview-private' }))
    .entry;
  assert.equal(
    (
      await enrichQueueEntries([publicEntry, privateEntry], {
        getById: async () => ({ source: { connector: 'weixin' } }),
      })
    ).length,
    1,
  );
  assert.deepEqual(
    (await enrichQueueEntries([publicEntry], { getById: async () => ({ source: { connector: 'weixin' } }) }))[0]
      .messagePreview,
    { connector: 'weixin' },
  );
  assert.equal(
    Object.hasOwn((await enrichQueueEntries([publicEntry], { getById: async () => null }))[0], 'messagePreview'),
    false,
  );
});
