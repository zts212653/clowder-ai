import { expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { projectCloudBindingRecovery } from '../cloud-binding-recovery';

const source: ChatMessage = { id: 'source', type: 'user', content: 'hello', timestamp: 1 };
const recovery: ChatMessage = {
  id: 'recovery',
  type: 'connector',
  content: 'connect',
  timestamp: 2,
  replyTo: source.id,
  source: {
    connector: 'cloud-bridge-status',
    label: 'cloud',
    icon: '',
    meta: {
      cloudBridgeRecovery: {
        v: 1,
        kind: 'needs_binding',
        sourceMessageId: source.id,
        targetCatId: 'gpt-pro',
        dispatchInvocationId: 'dispatch',
      },
    },
  },
};
function notice(invocationId = 'dispatch', transport: 'host' | 'none' = 'host'): ChatMessage {
  return {
    id: 'receipt',
    type: 'connector',
    content: 'not sent',
    timestamp: 3,
    replyTo: source.id,
    source: {
      connector: 'cloud-bridge-status',
      label: 'cloud',
      icon: '',
      meta: {
        cloudBridgeOutboundReceipt: {
          v: 1,
          sourceMessageId: source.id,
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
it('a terminal Host failure stays on the original source and never offers the prior attempt as Queue retry', () => {
  expect(projectCloudBindingRecovery(source, [source, recovery, notice()])).toEqual({
    targetCatId: 'gpt-pro',
    deliveryStatus: 'failed',
  });
});
it.each([
  notice('stale'),
  notice('dispatch', 'none'),
  { ...notice(), replyTo: 'foreign-source' },
])('does not borrow an unrelated Host terminal fact', (receipt) => {
  expect(projectCloudBindingRecovery(source, [source, recovery, receipt])).toEqual({
    targetCatId: 'gpt-pro',
    attemptId: 'dispatch',
  });
});
