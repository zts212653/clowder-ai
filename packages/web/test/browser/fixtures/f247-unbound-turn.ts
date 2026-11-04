import type { ChatMessage } from '@/stores/chat-types';
import { cloudReceiptTurn } from './f247-cloud-receipt-messages';

/** Real source65/cat and source90/user shapes, with account and dispatch identifiers sanitized. */
export function unboundTurn(author: 'user' | 'cat' = 'user', live = false): ChatMessage[] {
  const [source, response] = cloudReceiptTurn();
  if (author === 'cat') {
    source.type = 'assistant';
    source.from = { kind: 'agent', catId: 'codex-sol' };
    source.catId = 'codex-sol';
    source.content = '@gpt-pro 请审查这份实现。';
    source.extra = { isExplicitPost: true };
  }
  const outboundReceipt = {
    v: 1 as const,
    sourceMessageId: source.id,
    sourceSender: {
      kind: author === 'cat' ? ('cat' as const) : ('user' as const),
      id: author === 'cat' ? 'codex-sol' : 'owner',
    },
    dispatchInvocationId: 'dispatch77',
    targetCatId: 'gpt-pro',
    status: 'failed' as const,
    transport: 'none' as const,
    idempotency: { keyKind: 'source_message_id' as const, disposition: 'not_attempted' as const },
  };
  const content = '尚未绑定到这个 Thread。这条消息还没有发送。';
  const recovery = {
    v: 1,
    kind: 'needs_binding',
    sourceMessageId: source.id,
    targetCatId: 'gpt-pro',
    dispatchInvocationId: 'dispatch77',
  };
  const notice: ChatMessage = live
    ? {
        id: 'live-needs-binding',
        type: 'system',
        content,
        timestamp: 120,
        extra: {
          systemInfo: {
            v: 1,
            fallbackCatId: 'gpt-pro',
            payload: {
              type: 'cloud_bridge_status',
              catId: 'gpt-pro',
              reason: 'needs-binding',
              message: content,
              outboundReceipt,
            },
          },
        },
      }
    : {
        id: 'needs-binding',
        type: 'connector',
        content,
        timestamp: 120,
        replyTo: source.id,
        source: {
          connector: 'cloud-bridge-status',
          label: '云端猫投递',
          icon: 'warning',
          meta: {
            presentation: 'system_notice',
            cloudBridgeOutboundReceipt: outboundReceipt,
            ...(author === 'user' ? { cloudBridgeRecovery: recovery } : {}),
          },
        },
      };
  return [source, response, notice];
}

export function authorizedRows() {
  return Array.from({ length: 21 }, (_, index) => ({
    conversationId: `6a88a3fd-cc28-483e-a4d3-${String(index).padStart(12, '0')}`,
    ...(index % 2 ? { displayTitle: `授权会话 ${index + 1}，一起审查与讨论` } : {}),
  }));
}
