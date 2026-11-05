import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { AddressedPluginQueueDelivery } from '../src/domains/plugin/manager/addressing/addressed-plugin-queue-delivery.js';

test('published agent speech can wake a plugin without changing its publication or manufacturing a response', async () => {
  const queue = new InvocationQueue();
  const store = new MessageStore();
  const source = store.append({
    userId: 'owner',
    threadId: 'thread',
    from: { kind: 'agent', catId: 'opus' as never },
    content: '@dot please receive this',
    mentions: ['pi_dot' as never],
    timestamp: 1,
  });
  let calls = 0;
  const delivery = new AddressedPluginQueueDelivery({
    targets: { isInstanceId: async () => true } as never,
    manager: {
      deliverAddressed: async (_id, input) => {
        calls++;
        assert.equal(
          input.envelope.payload.elements.some((element) => element.kind === 'text'),
          true,
        );
        return { deliveryId: input.deliveryId };
      },
    },
    queue,
    messageStore: store,
  });
  const result = queue.enqueueDurableNow({
    userId: 'owner',
    threadId: 'thread',
    from: source.from,
    kind: 'message_wake',
    content: source.content,
    messageId: source.id,
    targetCats: ['pi_dot'],
    ownerAuthProvenance: 'unknown',
    intent: 'execute',
  });
  assert.equal(result.outcome, 'enqueued');
  const entry = await queue.markProcessingByIdDurable('thread', result.entries![0]!.id, 'pi_dot');
  await delivery.deliver(entry!, 'pi_dot');
  const published = store.getById(source.id)!;
  assert.equal(calls, 1);
  assert.equal(published.deliveryStatus, undefined);
  assert.equal(published.visibilitySeq, source.visibilitySeq);
  assert.equal(published.lifecycle?.dispatchRefs?.[0]?.phase, 'settled');
  assert.equal((await queue.listAllDurable('thread')).length, 0);
});

test('ordinary queue input is delivered by stable identity and records acceptance without a fake cat response', async () => {
  const queue = new InvocationQueue();
  const store = new MessageStore();
  const calls: unknown[][] = [];
  const delivery = new AddressedPluginQueueDelivery({
    targets: { isInstanceId: async (id: string) => id === 'pi_original' } as never,
    manager: {
      deliverAddressed: async (id, input) => {
        calls.push([id, input]);
        return { deliveryId: input.deliveryId };
      },
    },
    queue,
    messageStore: store,
  });
  const sent = await queue.send(
    store,
    {
      userId: 'owner',
      threadId: 'thread',
      from: { kind: 'user', userId: 'owner' },
      deliveryStatus: 'queued',
      content: '@old-alias do work',
      mentions: ['pi_original' as never],
      timestamp: 1,
    },
    {
      userId: 'owner',
      threadId: 'thread',
      from: { kind: 'user', userId: 'owner' },
      kind: 'conversation_input',
      content: '@old-alias do work',
      targetCats: ['pi_original'],
      ownerAuthProvenance: 'strict',
      intent: 'execute',
    },
  );
  assert.equal(sent.outcome, 'enqueued');
  if (sent.outcome !== 'enqueued') throw new Error('not admitted');
  const claimed = await queue.markProcessingByIdDurable('thread', sent.entries[0]!.id, 'pi_original');
  assert.ok(claimed);
  await delivery.deliver(claimed, 'pi_original');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], 'pi_original');
  const source = await store.getById(sent.message.id);
  assert.equal(source?.deliveryStatus, 'delivered');
  const ref = source?.lifecycle?.dispatchRefs?.find((r) => r.targetId === 'pi_original');
  assert.ok(ref);
  const receipt = await store.getById(ref.statusMessageId);
  assert.equal(receipt?.from.kind, 'system');
  assert.match(receipt!.content, /接收|accepted/i);
  assert.equal(receipt?.lifecycle?.kind === 'response', false);
  assert.equal((await queue.listAllDurable('thread')).length, 0);
  await delivery.deliver(claimed, 'pi_original');
  assert.equal(calls.length, 1, 'durable acceptance suppresses redelivery after queue restart');
});

test('a rejected or mismatched plugin receipt settles honestly without automatic replay or member fallback', async () => {
  const queue = new InvocationQueue();
  const store = new MessageStore();
  let calls = 0;
  const delivery = new AddressedPluginQueueDelivery({
    targets: { isInstanceId: async () => true } as never,
    manager: {
      deliverAddressed: async () => {
        calls++;
        throw new Error('Plugin is disabled or receipt mismatched');
      },
    },
    queue,
    messageStore: store,
  });
  const sent = await queue.send(
    store,
    {
      userId: 'owner',
      threadId: 'thread',
      from: { kind: 'user', userId: 'owner' },
      deliveryStatus: 'queued',
      content: '@dot work',
      mentions: ['pi_old' as never],
      timestamp: 1,
    },
    {
      userId: 'owner',
      threadId: 'thread',
      from: { kind: 'user', userId: 'owner' },
      kind: 'conversation_input',
      content: '@dot work',
      targetCats: ['pi_old'],
      ownerAuthProvenance: 'strict',
      intent: 'execute',
    },
  );
  assert.equal(sent.outcome, 'enqueued');
  if (sent.outcome !== 'enqueued') throw new Error('not admitted');
  const claimed = await queue.markProcessingByIdDurable('thread', sent.entries[0]!.id, 'pi_old');
  const receipt = await delivery.deliver(claimed!, 'pi_old');
  assert.equal(receipt.extra?.pluginAddressedReceipt?.accepted, false);
  assert.equal(receipt.lifecycle?.kind === 'response', false);
  assert.equal((await queue.listAllDurable('thread')).length, 0);
  await delivery.deliver(claimed!, 'pi_old');
  assert.equal(calls, 1);
});
