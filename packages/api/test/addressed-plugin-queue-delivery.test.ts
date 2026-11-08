import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { InvocationQueue } from '../src/domains/cats/services/agents/invocation/InvocationQueue.js';
import { MessageStore } from '../src/domains/cats/services/stores/ports/MessageStore.js';
import { AddressedPluginQueueDelivery } from '../src/domains/plugin/manager/addressing/addressed-plugin-queue-delivery.js';

test('publishes a durable plugin dispatch while delivery is still awaiting acknowledgement', async () => {
  const queue = new InvocationQueue();
  const store = new MessageStore();
  let finish!: () => void;
  const blocked = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let calls = 0;
  const delivery = new AddressedPluginQueueDelivery({
    targets: { isInstanceId: async () => true } as never,
    manager: {
      deliverAddressed: async (_id, input) => {
        calls++;
        entered();
        await blocked;
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
      content: '@helper hi',
      mentions: ['pi_original' as never],
      timestamp: Date.now(),
    },
    {
      userId: 'owner',
      threadId: 'thread',
      from: { kind: 'user', userId: 'owner' },
      kind: 'conversation_input',
      content: '@helper hi',
      targetCats: ['pi_original'],
      ownerAuthProvenance: 'strict',
      intent: 'execute',
    },
  );
  if (sent.outcome !== 'enqueued') throw new Error('not admitted');
  const claimed = (await queue.markProcessingByIdDurable('thread', sent.entries[0]!.id, 'pi_original'))!;
  const updates: unknown[] = [];
  const pending = delivery.deliver(claimed, 'pi_original', (message) => {
    updates.push(message);
  });
  await started;
  try {
    const source = (await store.getById(sent.message.id))!;
    const ref = source.lifecycle?.dispatchRefs?.[0];
    assert.ok(ref, 'slow plugin must have a persisted dispatch before its acknowledgement');
    assert.equal(ref.phase, 'dispatched');
    const receipt = (await store.getById(ref.statusMessageId))!;
    assert.equal((receipt.extra?.pluginAddressedReceipt as { phase?: string })?.phase, 'sending');
    assert.equal(receipt.lifecycle?.kind === 'response', false);
    assert.ok(updates.length >= 2, 'both source and receipt reach the live client');
  } finally {
    finish();
    await pending;
  }
  const source = (await store.getById(sent.message.id))!;
  const receipt = (await store.getById(source.lifecycle!.dispatchRefs![0]!.statusMessageId))!;
  assert.equal(receipt.extra?.pluginAddressedReceipt?.accepted, true);
  assert.equal(source.lifecycle!.dispatchRefs![0]!.phase, 'settled');
  await delivery.deliver(claimed, 'pi_original');
  assert.equal(calls, 1);
});

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

test('restart retains an unfinished attempt as unconfirmed instead of sending it twice', async () => {
  const queue = new InvocationQueue(),
    store = new MessageStore();
  const sent = await queue.send(
    store,
    {
      userId: 'owner',
      threadId: 'thread',
      from: { kind: 'user', userId: 'owner' },
      deliveryStatus: 'queued',
      content: 'hello',
      mentions: ['pi_helper' as never],
      timestamp: 1,
    },
    {
      userId: 'owner',
      threadId: 'thread',
      from: { kind: 'user', userId: 'owner' },
      kind: 'conversation_input',
      content: 'hello',
      targetCats: ['pi_helper'],
      ownerAuthProvenance: 'strict',
      intent: 'execute',
    },
  );
  if (sent.outcome !== 'enqueued') throw new Error('not admitted');
  const id = 'ad_' + createHash('sha256').update('pi_helper').update('\0').update(sent.message.id).digest('hex');
  // Crash after the intent was persisted but before its outcome was saved.
  store.append({
    userId: 'system',
    threadId: 'thread',
    from: { kind: 'system', service: 'plugin_delivery' },
    content: '插件投递与接收状态。',
    timestamp: 2,
    mentions: [],
    idempotencyKey: `plugin-addressed:${id}`,
    extra: {
      pluginAddressedReceipt: {
        inputMessageId: sent.message.id,
        targetId: 'pi_helper',
        accepted: false,
        phase: 'sending',
      },
    },
  });
  let calls = 0;
  const delivery = new AddressedPluginQueueDelivery({
    targets: { isInstanceId: async () => true } as never,
    queue,
    messageStore: store,
    manager: {
      deliverAddressed: async (_id, input) => {
        calls++;
        return { deliveryId: input.deliveryId };
      },
    },
  });
  const claimed = (await queue.markProcessingByIdDurable('thread', sent.entries[0]!.id, 'pi_helper'))!;
  const receipt = await delivery.deliver(claimed, 'pi_helper');
  assert.equal(calls, 0);
  assert.equal(receipt.extra?.pluginAddressedReceipt?.phase, 'unconfirmed');
  assert.equal((await queue.listAllDurable('thread')).length, 0);
});

test('new delivery phases survive Redis serialization; old acceptance receipts remain readable', async () => {
  const { serializeExtra, safeParseExtra } = await import(
    '../src/domains/cats/services/stores/redis/redis-message-parsers.js'
  );
  for (const phase of ['sending', 'accepted', 'unconfirmed'] as const) {
    const receipt = { inputMessageId: 'source', targetId: 'pi_helper', accepted: phase === 'accepted', phase };
    assert.deepEqual(
      safeParseExtra(serializeExtra({ pluginAddressedReceipt: receipt }))?.pluginAddressedReceipt,
      receipt,
    );
  }
  const legacy = { inputMessageId: 'source', targetId: 'pi_helper', accepted: true };
  assert.deepEqual(safeParseExtra(serializeExtra({ pluginAddressedReceipt: legacy }))?.pluginAddressedReceipt, legacy);
});

test('a late acknowledgement after timeout does not rewrite the uncertain receipt or replay delivery', async () => {
  const queue = new InvocationQueue(),
    store = new MessageStore();
  const source = store.append({
    userId: 'owner',
    threadId: 'thread',
    from: { kind: 'user', userId: 'owner' },
    content: 'hello',
    mentions: ['pi_helper' as never],
    timestamp: 1,
    deliveryStatus: 'queued',
  });
  const sent = queue.enqueueDurableNow({
    userId: 'owner',
    threadId: 'thread',
    from: source.from,
    kind: 'message_wake',
    content: 'hello',
    messageId: source.id,
    targetCats: ['pi_helper'],
    ownerAuthProvenance: 'strict',
    intent: 'execute',
  });
  const claimed = (await queue.markProcessingByIdDurable('thread', sent.entries![0]!.id, 'pi_helper'))!;
  let finish!: () => void,
    calls = 0;
  const delivery = new AddressedPluginQueueDelivery({
    targets: { isInstanceId: async () => true } as never,
    queue,
    messageStore: store,
    timeoutMs: 1,
    manager: {
      deliverAddressed: async (_id, input) => {
        calls++;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { deliveryId: input.deliveryId };
      },
    },
  });
  const uncertain = await delivery.deliver(claimed, 'pi_helper');
  assert.equal(uncertain.extra?.pluginAddressedReceipt?.phase, 'unconfirmed');
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = await delivery.deliver(claimed, 'pi_helper');
  assert.equal(recovered.extra?.pluginAddressedReceipt?.accepted, false);
  assert.equal(recovered.extra?.pluginAddressedReceipt?.phase, 'unconfirmed');
  assert.equal(calls, 1);
});
