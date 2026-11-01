import assert from 'node:assert/strict';
import test from 'node:test';
import { createPluginSentMessageReader } from '../src/domains/plugin/host-surface/plugin-sent-message-read.js';

test('a durable send query uses the caller namespace and canonical Queue targets after temporary ledger expiry', async () => {
  let source: Record<string, unknown> | null = {
    id: 'original',
    threadId: 'thread',
    userId: 'owner',
    from: { kind: 'plugin', instanceId: 'this-plugin' },
    content: 'same request',
  };
  const lookup: unknown[] = [];
  let targets = ['selected-cat'];
  const read = createPluginSentMessageReader({
    pluginInstanceId: 'this-plugin',
    ownerUserId: 'owner',
    assertCurrent: () => {},
    threadStore: { get: async () => ({ id: 'thread' }) } as never,
    messageStore: {
      getByIdempotencyKey: async (...args: unknown[]) => {
        lookup.push(args);
        return source;
      },
    } as never,
    readMessageTargets: async () => targets,
  });
  assert.deepEqual(await read({ threadId: 'thread', idempotencyKey: 'same-key' }), {
    messageId: 'original',
    threadId: 'thread',
    content: 'same request',
    routedCatIds: ['selected-cat'],
  });
  assert.deepEqual(lookup[0], ['owner', 'thread', 'plugmsg:this-plugin:same-key']);
  targets = [];
  source = {
    ...source,
    lifecycle: {
      kind: 'input',
      orderKey: '1',
      dispatchRefs: [{ targetId: 'selected-cat', phase: 'settled', statusMessageId: 'response' }],
    },
  };
  assert.deepEqual(
    (await read({ threadId: 'thread', idempotencyKey: 'same-key' }))?.routedCatIds,
    ['selected-cat'],
    'after Queue consumes the target, its permanent History dispatch remains the delivery evidence',
  );
  source = { ...source, from: { kind: 'plugin', instanceId: 'foreign-plugin' } };
  assert.equal(await read({ threadId: 'thread', idempotencyKey: 'same-key' }), null);
  source = null;
  assert.equal(await read({ threadId: 'thread', idempotencyKey: 'same-key' }), null);
  await assert.rejects(() =>
    read({ threadId: 'thread', idempotencyKey: 'same-key', pluginInstanceId: 'foreign' } as never),
  );
});

test('recipient adoption between the Message and Queue reads retains the permanent recipient', async () => {
  let message = {
    id: 'original',
    threadId: 'thread',
    userId: 'owner',
    from: { kind: 'plugin', instanceId: 'this-plugin' },
    content: 'same request',
    deliveryStatus: 'queued',
  };
  const read = createPluginSentMessageReader({
    pluginInstanceId: 'this-plugin',
    ownerUserId: 'owner',
    threadStore: { get: async () => ({ id: 'thread' }) } as never,
    messageStore: { getByIdempotencyKey: async () => structuredClone(message) } as never,
    readMessageTargets: async () => {
      // The real adoption commits History before removing its Queue recipient.
      message = {
        ...message,
        deliveryStatus: 'delivered',
        lifecycle: {
          dispatchRefs: [{ targetId: 'selected-cat', phase: 'settled', statusMessageId: 'response' }],
        },
      } as typeof message;
      return [];
    },
  });
  const original = await read({ threadId: 'thread', idempotencyKey: 'same-key' });
  assert.deepEqual(original?.routedCatIds, ['selected-cat']);
  assert.equal(original?.deliveryStatus, 'delivered');
});
