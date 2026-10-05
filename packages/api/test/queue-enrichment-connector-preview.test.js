import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { enrichQueueEntries } from '../dist/utils/queue-enrichment.js';

function enqueueConnectorMessage(source) {
  const queue = new InvocationQueue();
  const store = new MessageStore();
  const result = queue.enqueue({
    ownerAuthProvenance: 'unknown',
    threadId: 'thread-1',
    userId: 'user-1',
    content: '[Host 作品修改请求：原任务续办] 人的明确请求已持久保存。',
    source: 'connector',
    targetCats: ['gpt52'],
    intent: 'execute',
    priority: 'normal',
  });
  assert.equal(result.outcome, 'enqueued');
  const message = store.append({
    threadId: 'thread-1',
    userId: 'user-1',
    catId: null,
    content: result.entry.content,
    mentions: ['gpt52'],
    timestamp: result.entry.createdAt,
    ...(source ? { source } : {}),
  });
  queue.backfillMessageId('thread-1', 'user-1', result.entry.id, message.id);
  return { queue, store };
}

describe('queue preview carries the stored connector identity', () => {
  test('a Host content-review return exposes its connector so the queue row can use the same headline', async () => {
    const { queue, store } = enqueueConnectorMessage({ connector: 'content-review', label: '产物审阅', icon: 'x' });
    const [entry] = await enrichQueueEntries(queue.list('thread-1', 'user-1'), store);
    assert.equal(entry.messagePreview?.connector, 'content-review');
  });

  test('a message without a connector source adds no connector field', async () => {
    const { queue, store } = enqueueConnectorMessage(undefined);
    const [entry] = await enrichQueueEntries(queue.list('thread-1', 'user-1'), store);
    assert.equal(entry.messagePreview?.connector, undefined);
  });
});
