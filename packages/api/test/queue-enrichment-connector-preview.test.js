import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { enrichQueueEntries } from '../dist/utils/queue-enrichment.js';

async function enqueueConnectorMessage(source, plugin = false) {
  const from = plugin
    ? { kind: 'plugin', instanceId: 'pi_8e8bfc62-7545-4c31-a764-666d3284d138' }
    : { kind: 'external', connectorId: source?.connector ?? 'test-fixture' };
  const queue = new InvocationQueue();
  const store = new MessageStore();
  const result = await queue.send(
    store,
    {
      from,
      threadId: 'thread-1',
      userId: 'user-1',
      content: '[Host 作品修改请求：原任务续办] 人的明确请求已持久保存。',
      deliveryStatus: 'queued',
      mentions: ['gpt52'],
      timestamp: Date.now(),
      ...(plugin
        ? {
            extra: {
              pluginMessage: {
                instanceId: from.instanceId,
                revision: 1,
                provenance: { origin: from, epistemicStatus: 'inference' },
                elements: [],
                ...(source ? { presentation: source } : {}),
              },
            },
          }
        : source
          ? { source }
          : {}),
    },
    {
      ownerAuthProvenance: 'unknown',
      threadId: 'thread-1',
      userId: 'user-1',
      content: '[Host 作品修改请求：原任务续办] 人的明确请求已持久保存。',
      from,
      kind: 'conversation_input',
      targetCats: ['gpt52'],
      intent: 'execute',
      priority: 'normal',
    },
  );
  assert.equal(result.outcome, 'enqueued');
  return { queue, store };
}

describe('queue preview carries the stored connector identity', () => {
  test('a Host content-review return exposes its connector so the queue row can use the same headline', async () => {
    const { queue, store } = await enqueueConnectorMessage({
      connector: 'content-review',
      label: '产物审阅',
      icon: 'x',
    });
    const [entry] = await enrichQueueEntries(queue.list('thread-1', 'user-1'), store);
    assert.equal(entry.messagePreview?.connector, 'content-review');
  });

  test('a message without a connector source adds no connector field', async () => {
    const { queue, store } = await enqueueConnectorMessage(undefined);
    const [entry] = await enrichQueueEntries(queue.list('thread-1', 'user-1'), store);
    assert.equal(entry.messagePreview?.connector, undefined);
  });
});

describe('persisted plugin identity reaches the public Queue preview', () => {
  test('uses canonical presentation for both source and connector, with detached output', async () => {
    const presentation = {
      connector: 'custom-plugin',
      label: 'Room Connector',
      icon: '/plugin-icon.svg',
      themeColor: '#07c160',
    };
    const { queue, store } = await enqueueConnectorMessage(presentation, true);
    const entries = queue.list('thread-1', 'user-1');
    const stored = await store.getById(entries[0].payload.messageId);
    assert.equal(stored.source, undefined);
    assert.deepEqual(stored.extra.pluginMessage.presentation, presentation);
    const [entry] = await enrichQueueEntries(entries, store);
    assert.deepEqual(entry.from, stored.from);
    assert.deepEqual(entry.messagePreview.source, presentation);
    assert.equal(entry.messagePreview.connector, presentation.connector);
    entry.messagePreview.source.label = 'mutated client copy';
    assert.equal((await store.getById(stored.id)).extra.pluginMessage.presentation.label, presentation.label);
  });
  test('old plugin messages without presentation do not manufacture a source from instance IDs', async () => {
    const { queue, store } = await enqueueConnectorMessage(undefined, true);
    const [entry] = await enrichQueueEntries(queue.list('thread-1', 'user-1'), store);
    assert.equal(entry.messagePreview.source, undefined);
    assert.equal(entry.messagePreview.connector, undefined);
    assert.equal(entry.from.kind, 'plugin');
  });
});
