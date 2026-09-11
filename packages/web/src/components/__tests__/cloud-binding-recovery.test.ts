import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { isLinkedCloudBindingRecoveryNotice, projectCloudBindingRecovery } from '../cloud-binding-recovery';

function source(): ChatMessage {
  return {
    id: 'source-1',
    type: 'user',
    content: '@gpt-pro hello',
    timestamp: 1,
  };
}

function notice(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'notice-1',
    type: 'connector',
    content: 'not sent',
    timestamp: 2,
    replyTo: 'source-1',
    source: {
      connector: 'cloud-bridge-status',
      label: '云端猫投递',
      icon: '☁️',
      meta: {
        presentation: 'system_notice',
        cloudBridgeRecovery: {
          v: 1,
          kind: 'needs_binding',
          sourceMessageId: 'source-1',
          targetCatId: 'gpt-pro',
          dispatchInvocationId: 'dispatch-1',
        },
      },
    },
    ...overrides,
  };
}

describe('cloud binding recovery projection', () => {
  it('projects one exact retryable source/target attempt and suppresses its linked notice', () => {
    const authored = source();
    const warning = notice();
    expect(projectCloudBindingRecovery(authored, [authored, warning])).toEqual({
      targetCatId: 'gpt-pro',
      attemptId: 'dispatch-1',
    });
    expect(isLinkedCloudBindingRecoveryNotice(warning, [authored, warning])).toBe(true);
  });

  it('hides recovery after a fresh source exists for the exact failed dispatch', () => {
    const authored = source();
    const retried: ChatMessage = {
      id: 'retry-source-1',
      type: 'user',
      content: authored.content,
      timestamp: 3,
      extra: {
        cloudBridgeRetry: {
          v: 1,
          sourceMessageId: authored.id,
          targetCatId: 'gpt-pro',
          priorDispatchInvocationId: 'dispatch-1',
        },
      },
    };
    expect(projectCloudBindingRecovery(authored, [authored, notice(), retried])).toBeUndefined();
  });

  it('rejects forged or cross-source recovery metadata', () => {
    const authored = source();
    const forged = notice({
      source: {
        connector: 'cloud-bridge-status',
        label: '云端猫投递',
        icon: '☁️',
        meta: {
          cloudBridgeRecovery: {
            v: 1,
            kind: 'needs_binding',
            sourceMessageId: 'different-source',
            targetCatId: 'gpt-pro',
            dispatchInvocationId: 'dispatch-1',
          },
        },
      },
    });
    expect(projectCloudBindingRecovery(authored, [authored, forged])).toBeUndefined();
    expect(isLinkedCloudBindingRecoveryNotice(forged, [authored, forged])).toBe(false);
  });

  it('keeps the standalone notice visible when its source is not loaded', () => {
    const warning = notice();
    expect(isLinkedCloudBindingRecoveryNotice(warning, [warning])).toBe(false);
  });
});
