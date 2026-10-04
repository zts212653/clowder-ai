import type { QueueMessageReceipt } from '@cat-cafe/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { MessageReceiptDock } from '../MessageReceiptDock';

vi.mock('../CatAvatar', () => ({ CatAvatar: () => null }));

const receipt: QueueMessageReceipt = {
  version: 1,
  entryId: 'entry-1',
  reminderAttempts: [],
  targets: [
    {
      catId: 'gpt-pro',
      state: 'failed',
      retryable: true,
      attempts: [
        {
          id: 'attempt-1',
          targetCatId: 'gpt-pro',
          sequence: 1,
          state: 'failed',
          createdAt: 2,
          updatedAt: 3,
          invocationId: 'dispatch-1',
        },
      ],
    },
  ],
};
function notice(invocationId = 'dispatch-1', transport: 'host' | 'none' = 'host'): ChatMessage {
  return {
    id: 'notice-1',
    type: 'connector',
    content: '未发送',
    timestamp: 3,
    replyTo: 'source-1',
    source: {
      connector: 'cloud-bridge-status',
      label: '云端投递',
      icon: '',
      meta: {
        cloudBridgeOutboundReceipt: {
          v: 1,
          sourceMessageId: 'source-1',
          sourceSender: { kind: 'user', id: 'owner' },
          targetCatId: 'gpt-pro',
          dispatchInvocationId: invocationId,
          status: 'failed',
          transport,
          idempotency: { keyKind: 'source_message_id', disposition: 'fresh' },
        },
      },
    },
  };
}
function render(messages: ChatMessage[]) {
  return renderToStaticMarkup(
    <MessageReceiptDock messageId="source-1" receipt={receipt} messages={messages} getCatLabel={() => '砚砚 Pro'} />,
  );
}
it('does not offer the generic queue retry for a terminal failed Host source', () => {
  expect(render([notice()])).not.toContain('data-retry-target');
  expect(render([notice()])).not.toContain('已回队列');
  expect(render([notice()])).toContain('未发送 · 需要新消息');
});
it('keeps non-Host binding failures retryable and ignores stale or cross-source Host receipts', () => {
  for (const message of [
    notice('dispatch-old'),
    notice('dispatch-1', 'none'),
    { ...notice(), replyTo: 'other-source' },
    { ...notice(), timestamp: 1 },
  ]) {
    expect(render([message])).toContain('data-retry-target');
  }
});
