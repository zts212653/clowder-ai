import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  appendMessageThroughHost,
  HostAdapterContractError,
  HostAdapterUnavailableError,
  type IConversationHostAdapter,
} from '../src/domains/cats/services/cloud-bridge/conversation-host-adapter.js';

describe('conversation Host Adapter', () => {
  it('calls append_message with the exact narrow contract and returns the host message ID', async () => {
    const calls: unknown[][] = [];
    const adapter: IConversationHostAdapter = {
      async append_message(conversationId, text, idempotencyKey) {
        calls.push([conversationId, text, idempotencyKey]);
        return { hostMessageId: 'host-message-42' };
      },
    };

    const receipt = await appendMessageThroughHost(adapter, 'conversation-7', 'hello cloud cat', 'source-msg-9');

    assert.deepEqual(calls, [['conversation-7', 'hello cloud cat', 'source-msg-9']]);
    assert.deepEqual(receipt, { hostMessageId: 'host-message-42' });
  });

  it('preserves host idempotency semantics across a retry', async () => {
    const idsByKey = new Map<string, string>();
    let appendCount = 0;
    const adapter: IConversationHostAdapter = {
      async append_message(_conversationId, _text, idempotencyKey) {
        appendCount += 1;
        const hostMessageId = idsByKey.get(idempotencyKey) ?? `host-message-${idsByKey.size + 1}`;
        idsByKey.set(idempotencyKey, hostMessageId);
        return { hostMessageId };
      },
    };

    const first = await appendMessageThroughHost(adapter, 'conversation-7', 'same message', 'source-msg-9');
    const retry = await appendMessageThroughHost(adapter, 'conversation-7', 'same message', 'source-msg-9');

    assert.equal(appendCount, 2);
    assert.equal(retry.hostMessageId, first.hostMessageId);
  });

  it('fails closed when no host adapter is installed', async () => {
    await assert.rejects(
      appendMessageThroughHost(null, 'conversation-7', 'hello', 'source-msg-9'),
      (error: unknown) => error instanceof HostAdapterUnavailableError && error.code === 'HOST_APPEND_UNAVAILABLE',
    );
  });

  it('rejects an empty host message ID instead of inventing an acknowledgement', async () => {
    const adapter: IConversationHostAdapter = {
      async append_message() {
        return { hostMessageId: '   ' };
      },
    };

    await assert.rejects(
      appendMessageThroughHost(adapter, 'conversation-7', 'hello', 'source-msg-9'),
      (error: unknown) => error instanceof HostAdapterContractError && error.code === 'HOST_APPEND_INVALID_RECEIPT',
    );
  });
});
