import assert from 'node:assert/strict';
import test from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { createPluginConversationDelivery } from '../src/domains/plugin/host-surface/plugin-conversation-delivery.js';

test('an explicit plugin recipient is resolved exactly and never falls back when unavailable', async () => {
  const enqueued: unknown[] = [];
  let available = true;
  const delivery = createPluginConversationDelivery({
    messageStore: {
      getById: async () => ({
        id: 'message',
        threadId: 'thread',
        userId: 'owner',
        content: 'game request',
        from: { kind: 'plugin', id: 'installed' },
      }),
    } as never,
    queue: {
      getDurableEntriesForMessages: async () => new Map(),
      enqueueExistingMessageDurable: async (...args: unknown[]) => {
        enqueued.push(args);
        return { outcome: 'enqueued' };
      },
    } as never,
    router: {
      resolveConversationTargetsAtAdmission: async () => (available ? ['chosen-cat'] : ['fallback-cat']),
      resolveSendTargets: async () => ['automatic-cat'],
    } as never,
  });
  assert.equal(
    await delivery.trigger('thread', 'chosen-cat' as never, 'owner', 'game request', 'message', undefined, {
      exactTarget: true,
    }),
    'enqueued',
  );
  assert.deepEqual((enqueued[0] as unknown[])[2], {
    threadId: 'thread',
    userId: 'owner',
    content: 'game request',
    from: { kind: 'plugin', id: 'installed' },
    sourceId: 'message',
    idempotencyKey: 'plugin-ingress:message',
    kind: 'conversation_input',
    intent: 'execute',
    targetCats: ['chosen-cat'],
    ownerAuthProvenance: 'unknown',
  });
  available = false;
  await assert.rejects(
    () =>
      delivery.trigger('thread', 'chosen-cat' as never, 'owner', 'game request', 'message', undefined, {
        exactTarget: true,
      }),
    /explicit plugin recipient/,
  );
  assert.equal(enqueued.length, 1);
});

test('atomic adoption retains the resolved recipient without selecting another fallback', async () => {
  const messages = new MessageStore();
  let routeSelections = 0;
  const queue = new InvocationQueue(undefined, {
    resolveTargets: async () => {
      routeSelections++;
      return ['substitute-cat'];
    },
  });
  const stored = await messages.append({
    userId: 'owner',
    threadId: 'thread',
    timestamp: Date.now(),
    from: { kind: 'plugin', instanceId: 'installed' },
    content: 'same admitted request',
    deliveryStatus: 'queued',
    extra: { pluginMessage: { instanceId: 'installed', revision: 1, provenance: {}, elements: [], appendOps: [] } },
  });
  const delivery = createPluginConversationDelivery({
    messageStore: messages,
    queue,
    router: { resolveConversationTargetsAtAdmission: async () => ['chosen-cat'] } as never,
  });
  await delivery.trigger('thread', 'chosen-cat' as never, 'owner', stored.content, stored.id, undefined, {
    exactTarget: true,
  });
  assert.deepEqual(queue.list('thread', 'owner')[0]?.targets, ['chosen-cat']);
  assert.equal(routeSelections, 0, 'adoption must retain its already-resolved recipient');
});
