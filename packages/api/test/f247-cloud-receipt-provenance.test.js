import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { persistUserFacingSystemInfoNotices } from '../dist/domains/cats/services/agents/routing/persist-system-info-warnings.js';
import { MessageStore } from '../dist/domains/cats/services/stores/ports/MessageStore.js';

function receipt(sourceMessageId, overrides = {}) {
  return {
    v: 1,
    sourceMessageId,
    sourceSender: { kind: 'cat', id: 'codex-sol', invocationId: 'inv-source' },
    dispatchInvocationId: 'inv-cloud',
    targetCatId: 'gpt-pro',
    status: 'sent',
    transport: 'host',
    hostMessageId: 'host-message-1',
    idempotency: { keyKind: 'source_message_id', disposition: 'fresh' },
    ...overrides,
  };
}

function statusContent(outboundReceipt) {
  return JSON.stringify({
    type: 'cloud_bridge_status',
    status: outboundReceipt.status,
    message: 'cloud dispatch audit',
    outboundReceipt,
  });
}

function needsBindingContent(outboundReceipt) {
  return JSON.stringify({
    type: 'cloud_bridge_status',
    status: 'unavailable',
    reason: 'needs-binding',
    message: '这条消息还没有发送',
    outboundReceipt,
  });
}

describe('F247 durable outbound receipt provenance', () => {
  it('persists a refs-only recovery carrier for an exact direct-user needs-binding source', async () => {
    const store = new MessageStore();
    const source = store.append({
      userId: 'alice',
      catId: null,
      threadId: 'thread-owner',
      content: '@gpt-pro exact source',
      mentions: ['gpt-pro'],
      timestamp: 1_000,
    });
    const outboundReceipt = receipt(source.id, {
      sourceSender: { kind: 'user', id: 'alice' },
      status: 'failed',
      transport: 'none',
      hostMessageId: undefined,
      idempotency: { keyKind: 'source_message_id', disposition: 'not_attempted' },
    });

    await persistUserFacingSystemInfoNotices({
      messageStore: store,
      threadId: 'thread-owner',
      catId: 'gpt-pro',
      expectedSourceMessageId: source.id,
      expectedDispatchInvocationId: 'inv-cloud',
      contents: [needsBindingContent(outboundReceipt)],
    });

    const persisted = (await store.getByThread('thread-owner')).find(
      (message) => message.source?.connector === 'cloud-bridge-status',
    );
    assert.deepEqual(persisted.source.meta.cloudBridgeRecovery, {
      v: 1,
      kind: 'needs_binding',
      sourceMessageId: source.id,
      targetCatId: 'gpt-pro',
      dispatchInvocationId: 'inv-cloud',
    });
    assert.equal(JSON.stringify(persisted.source.meta.cloudBridgeRecovery).includes('chatgpt.com'), false);
    assert.equal(JSON.stringify(persisted.source.meta.cloudBridgeRecovery).includes('conversation'), false);
  });

  it('does not persist an interactive recovery carrier for an exact cat-authored source', async () => {
    const store = new MessageStore();
    const source = store.append({
      userId: 'alice',
      catId: 'codex-sol',
      threadId: 'thread-owner',
      content: '@gpt-pro exact A2A source',
      mentions: ['gpt-pro'],
      timestamp: 1_000,
      extra: { stream: { invocationId: 'inv-source', turnInvocationId: 'inv-source' } },
    });
    const outboundReceipt = receipt(source.id, {
      status: 'failed',
      transport: 'none',
      hostMessageId: undefined,
      idempotency: { keyKind: 'source_message_id', disposition: 'not_attempted' },
    });

    await persistUserFacingSystemInfoNotices({
      messageStore: store,
      threadId: 'thread-owner',
      catId: 'gpt-pro',
      expectedSourceMessageId: source.id,
      expectedDispatchInvocationId: 'inv-cloud',
      contents: [needsBindingContent(outboundReceipt)],
    });

    const persisted = (await store.getByThread('thread-owner')).find(
      (message) => message.source?.connector === 'cloud-bridge-status',
    );
    assert.equal(persisted.source.meta.cloudBridgeRecovery, undefined);
  });

  it('does not infer recovery from a generic failed cloud receipt', async () => {
    const store = new MessageStore();
    const source = store.append({
      userId: 'alice',
      catId: null,
      threadId: 'thread-owner',
      content: '@gpt-pro exact source',
      mentions: ['gpt-pro'],
      timestamp: 1_000,
    });
    const outboundReceipt = receipt(source.id, {
      sourceSender: { kind: 'user', id: 'alice' },
      status: 'failed',
      transport: 'none',
      hostMessageId: undefined,
      idempotency: { keyKind: 'source_message_id', disposition: 'not_attempted' },
    });

    await persistUserFacingSystemInfoNotices({
      messageStore: store,
      threadId: 'thread-owner',
      catId: 'gpt-pro',
      expectedSourceMessageId: source.id,
      expectedDispatchInvocationId: 'inv-cloud',
      contents: [statusContent(outboundReceipt)],
    });

    const persisted = (await store.getByThread('thread-owner')).find(
      (message) => message.source?.connector === 'cloud-bridge-status',
    );
    assert.equal(persisted.source.meta.cloudBridgeRecovery, undefined);
  });

  it('persists replyTo only when source, sender, dispatch invocation, and target all match server context', async () => {
    const store = new MessageStore();
    const source = store.append({
      userId: 'alice',
      catId: 'codex-sol',
      threadId: 'thread-owner',
      content: '@gpt-pro exact source',
      mentions: ['gpt-pro'],
      timestamp: 1_000,
      extra: { stream: { invocationId: 'inv-source', turnInvocationId: 'inv-source' } },
    });

    await persistUserFacingSystemInfoNotices({
      messageStore: store,
      threadId: 'thread-owner',
      catId: 'gpt-pro',
      expectedSourceMessageId: source.id,
      expectedDispatchInvocationId: 'inv-cloud',
      contents: [statusContent(receipt(source.id))],
    });

    const persisted = (await store.getByThread('thread-owner')).find(
      (message) => message.source?.connector === 'cloud-bridge-status',
    );
    assert.equal(persisted.replyTo, source.id);
    assert.equal(persisted.source.meta.cloudBridgeOutboundReceipt.sourceMessageId, source.id);
  });

  it('drops a same-thread receipt when its source differs from the server-owned trigger', async () => {
    const store = new MessageStore();
    const expectedSource = store.append({
      userId: 'alice',
      catId: 'codex-sol',
      threadId: 'thread-owner',
      content: '@gpt-pro expected source',
      mentions: ['gpt-pro'],
      timestamp: 1_000,
      extra: { stream: { invocationId: 'inv-source', turnInvocationId: 'inv-source' } },
    });
    const substitutedSource = store.append({
      userId: 'alice',
      catId: 'codex-sol',
      threadId: 'thread-owner',
      content: 'same sender, wrong source',
      mentions: [],
      timestamp: 1_001,
      extra: { stream: { invocationId: 'inv-source', turnInvocationId: 'inv-source' } },
    });

    await persistUserFacingSystemInfoNotices({
      messageStore: store,
      threadId: 'thread-owner',
      catId: 'gpt-pro',
      expectedSourceMessageId: expectedSource.id,
      expectedDispatchInvocationId: 'inv-cloud',
      contents: [statusContent(receipt(substitutedSource.id))],
    });

    const persisted = (await store.getByThread('thread-owner')).find(
      (message) => message.source?.connector === 'cloud-bridge-status',
    );
    assert.equal(persisted.replyTo, undefined);
    assert.equal(persisted.source.meta.cloudBridgeOutboundReceipt, undefined);
  });

  for (const invalidCase of [
    { name: 'cross-thread source', sourceThreadId: 'thread-private', overrides: {} },
    { name: 'wrong sender', sourceThreadId: 'thread-owner', overrides: { sourceSender: { kind: 'cat', id: 'opus' } } },
    { name: 'wrong target', sourceThreadId: 'thread-owner', overrides: { targetCatId: 'other-cloud-cat' } },
    {
      name: 'wrong dispatch invocation',
      sourceThreadId: 'thread-owner',
      overrides: { dispatchInvocationId: 'inv-other' },
    },
    {
      name: 'queued user source',
      sourceThreadId: 'thread-owner',
      sourceCatId: null,
      deliveryStatus: 'queued',
      overrides: { sourceSender: { kind: 'user', id: 'alice' } },
    },
    {
      name: 'internal system source',
      sourceThreadId: 'thread-owner',
      sourceCatId: null,
      sourceUserId: 'system',
      overrides: { sourceSender: { kind: 'user', id: 'system' } },
    },
  ]) {
    it(`drops the source-bound projection for ${invalidCase.name}`, async () => {
      const store = new MessageStore();
      const source = store.append({
        userId: invalidCase.sourceUserId ?? 'alice',
        catId: invalidCase.sourceCatId === undefined ? 'codex-sol' : invalidCase.sourceCatId,
        threadId: invalidCase.sourceThreadId,
        content: 'private source body must not hydrate',
        mentions: [],
        timestamp: 1_000,
        ...(invalidCase.deliveryStatus ? { deliveryStatus: invalidCase.deliveryStatus } : {}),
        extra: { stream: { invocationId: 'inv-source', turnInvocationId: 'inv-source' } },
      });

      await persistUserFacingSystemInfoNotices({
        messageStore: store,
        threadId: 'thread-owner',
        catId: 'gpt-pro',
        expectedSourceMessageId: source.id,
        expectedDispatchInvocationId: 'inv-cloud',
        contents: [statusContent(receipt(source.id, invalidCase.overrides))],
      });

      const persisted = (await store.getByThread('thread-owner')).find(
        (message) => message.source?.connector === 'cloud-bridge-status',
      );
      assert.equal(persisted.replyTo, undefined);
      assert.equal(persisted.source.meta.cloudBridgeOutboundReceipt, undefined);
    });
  }
});
