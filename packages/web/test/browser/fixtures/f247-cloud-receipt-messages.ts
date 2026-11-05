import type { ChatMessage } from '@/stores/chat-types';

export const cloudThreadId = 'thread-cloud-receipt';

/** Sanitized source77 / empty78 / notice79 / reply81, including the live warning's typed payload. */
export function cloudReceiptTurn(targetCatId = 'gpt-pro'): ChatMessage[] {
  const identity = { sourceMessageId: 'source77', targetCatId, dispatchInvocationId: 'dispatch77' };
  const outboundReceipt = {
    v: 1 as const,
    ...identity,
    sourceSender: { kind: 'user' as const, id: 'owner' },
    status: 'unknown' as const,
    transport: 'host' as const,
    idempotency: { keyKind: 'source_message_id' as const, disposition: 'fresh' as const },
    ...(targetCatId === 'gpt-dot'
      ? { status: 'sent' as const, transport: 'events' as const, hostMessageId: `dot_evt_${'a'.repeat(64)}` }
      : {}),
  };
  return [
    {
      id: 'source77',
      type: 'user',
      from: { kind: 'user', userId: 'owner' },
      content: `@${targetCatId} rua你大尾巴！`,
      timestamp: 100,
      lifecycle: {
        kind: 'input',
        orderKey: '100:source77',
        dispatchRefs: [{ targetId: targetCatId, phase: 'settled', statusMessageId: 'empty78', dispatchedAt: 110 }],
      },
    },
    {
      id: 'empty78',
      type: 'assistant',
      catId: targetCatId,
      from: { kind: 'agent', catId: targetCatId },
      content: '',
      replyTo: 'source77',
      origin: 'stream',
      timestamp: 110,
      lifecycle: {
        kind: 'response',
        orderKey: '110:dispatch77',
        invocationId: 'dispatch77',
        targetId: targetCatId,
        inputEntryIds: ['queue77'],
        inputMessageIds: ['source77'],
        status: 'completed',
        startedAt: 110,
        completedAt: 120,
      },
    },
    {
      id: 'live-warning',
      type: 'system',
      content: '投递结果未知：后台 Host 没有返回可验证回执。',
      timestamp: 120,
      extra: {
        systemInfo: {
          v: 1,
          fallbackCatId: targetCatId,
          payload: {
            type: 'cloud_bridge_status',
            catId: targetCatId,
            status: 'unavailable',
            message: '投递结果未知：后台 Host 没有返回可验证回执。',
            outboundReceipt,
          },
        },
      },
    },
    {
      id: 'notice79',
      type: 'connector',
      from: { kind: 'system', service: 'system-info-warning' },
      content: '投递结果未知：后台 Host 没有返回可验证回执。',
      replyTo: 'source77',
      timestamp: 121,
      source: {
        connector: 'cloud-bridge-status',
        label: '云端猫投递',
        icon: 'warning',
        meta: {
          presentation: 'system_notice',
          noticeTone: 'warning',
          cloudBridgeOutboundReceipt: outboundReceipt,
        },
      },
    },
    {
      id: 'reply81',
      type: 'assistant',
      catId: targetCatId,
      from: { kind: 'agent', catId: targetCatId },
      content: '咪呀！大尾巴被 rua 成了一朵云。',
      replyTo: 'source77',
      origin: 'callback',
      timestamp: 130,
      extra: {
        isExplicitPost: true,
        ...(targetCatId === 'gpt-dot' ? {} : { cloudBridgeReturn: { v: 1, threadId: cloudThreadId, ...identity } }),
      },
    },
  ];
}

export function cloudUnboundTurn(): ChatMessage[] {
  const [source, empty] = cloudReceiptTurn();
  return [
    source,
    empty,
    {
      id: 'needs-binding',
      type: 'connector',
      replyTo: source.id,
      timestamp: 120,
      content: '这条消息尚未绑定会话。',
      source: {
        connector: 'cloud-bridge-status',
        label: '云端猫投递',
        icon: 'warning',
        meta: {
          presentation: 'system_notice',
          cloudBridgeRecovery: {
            v: 1,
            kind: 'needs_binding',
            sourceMessageId: source.id,
            targetCatId: 'gpt-pro',
            dispatchInvocationId: 'dispatch77',
          },
        },
      },
    },
  ];
}
