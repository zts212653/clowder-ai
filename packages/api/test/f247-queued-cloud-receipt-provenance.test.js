import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InvocationQueue } from '../dist/domains/cats/services/agents/invocation/InvocationQueue.js';
import { createInitialQueuedMessageCustody } from '../dist/domains/cats/services/agents/invocation/QueuedMessageCustodyCoordinator.js';
import { persistUserFacingSystemInfoNotices } from '../dist/domains/cats/services/agents/routing/persist-system-info-warnings.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';
import { resolveVisibleReplyParent } from '../dist/domains/cats/services/stores/visibility.js';

async function persist({ sourceOverrides = {}, exposures, receiptOverrides = {}, status = 'failed', transition } = {}) {
  const store = new MessageStore();
  const { entry } = new InvocationQueue().enqueue({
    threadId: 'owner-thread',
    userId: 'alice',
    ownerAuthProvenance: 'strict',
    idempotencyKey: 'first-source',
    content: 'original user body',
    targetCats: ['gpt-pro', 'opus'],
    source: 'user',
    intent: 'execute',
  });
  const source = store.append({
    threadId: 'owner-thread',
    userId: 'alice',
    catId: null,
    content: 'original user body',
    mentions: ['gpt-pro'],
    timestamp: 1_000,
    deliveryStatus: 'queued',
    queueCustody: {
      ...createInitialQueuedMessageCustody(entry),
      bodyExposures: exposures ?? [{ targetCatId: 'gpt-pro', invocationId: 'cloud-child', seenAt: 1_001 }],
    },
    ...sourceOverrides,
  });
  if (transition === 'deleted') store.softDelete(source.id, 'alice');
  if (transition === 'canceled') store.markCanceled(source.id);
  const outboundReceipt = {
    v: 1,
    sourceMessageId: source.id,
    sourceSender: { kind: 'user', id: 'alice' },
    dispatchInvocationId: 'cloud-child',
    targetCatId: 'gpt-pro',
    status,
    transport: status === 'sent' ? 'host' : 'none',
    ...(status === 'sent' ? { hostMessageId: 'host-confirmed-id' } : {}),
    idempotency: { keyKind: 'source_message_id', disposition: status === 'sent' ? 'fresh' : 'not_attempted' },
    ...receiptOverrides,
  };
  await persistUserFacingSystemInfoNotices({
    messageStore: store,
    threadId: 'owner-thread',
    catId: 'gpt-pro',
    expectedSourceMessageId: source.id,
    expectedDispatchInvocationId: 'cloud-child',
    contents: [
      JSON.stringify({
        type: 'cloud_bridge_status',
        message: 'Cloud status',
        ...(status === 'failed' ? { reason: 'needs-binding' } : {}),
        outboundReceipt,
      }),
    ],
  });
  const notice = store
    .getByThread('owner-thread')
    .find((message) => message.source?.connector === 'cloud-bridge-status');
  return { store, source, notice, outboundReceipt };
}

for (const status of ['failed', 'sent']) {
  test(`persists ${status} receipt for the exact exposed queued user source without publishing its body`, async () => {
    const { store, source, notice, outboundReceipt } = await persist({ status });
    assert.deepEqual(notice.source.meta.cloudBridgeOutboundReceipt, outboundReceipt);
    assert.equal(notice.replyTo, source.id);
    assert.equal(notice.source.meta.cloudBridgeRecovery?.sourceMessageId, status === 'failed' ? source.id : undefined);
    assert.equal(store.getById(source.id).deliveryStatus, 'queued');
    assert.equal(
      await resolveVisibleReplyParent(store, source.id, {
        threadId: 'owner-thread',
        viewer: { type: 'cat', catId: 'opus' },
        publicReply: true,
      }),
      null,
      'receipt validation does not relax ordinary reply publication',
    );
  });
}

for (const [name, options] of [
  ['no body exposure', { exposures: [] }],
  ['a different child', { exposures: [{ targetCatId: 'gpt-pro', invocationId: 'other-child', seenAt: 1_001 }] }],
  ['a different target', { exposures: [{ targetCatId: 'opus', invocationId: 'cloud-child', seenAt: 1_001 }] }],
  ['another thread', { sourceOverrides: { threadId: 'private-thread' } }],
  ['a different owner', { sourceOverrides: { userId: 'bob' } }],
  ['a deleted source', { transition: 'deleted' }],
  ['a canceled source', { transition: 'canceled' }],
  [
    'a system source',
    { sourceOverrides: { userId: 'system' }, receiptOverrides: { sourceSender: { kind: 'user', id: 'system' } } },
  ],
  ['a briefing', { sourceOverrides: { origin: 'briefing' } }],
  ['an unrevealed whisper', { sourceOverrides: { visibility: 'whisper', whisperTo: ['gpt-pro'] } }],
  ['a forged dispatch', { receiptOverrides: { dispatchInvocationId: 'other-child' } }],
  ['a forged source', { receiptOverrides: { sourceMessageId: 'other-source' } }],
]) {
  test(`refuses queued source receipt for ${name}`, async () => {
    const { notice } = await persist(options);
    assert.equal(notice.replyTo, undefined);
    assert.equal(notice.source.meta.cloudBridgeOutboundReceipt, undefined);
    assert.equal(notice.source.meta.cloudBridgeRecovery, undefined);
  });
}
