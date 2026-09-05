import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/stores/chat-types';
import { isLinkedCloudBindingRecoveryNotice, projectCloudBindingRecovery } from '../cloud-binding-recovery';

function source(state: 'failed' | 'queued' = 'failed'): ChatMessage {
  return {
    id: 'source-1',
    type: 'user',
    content: '@gpt-pro hello',
    timestamp: 1,
    extra: {
      queueReceipt: {
        version: 1,
        entryId: 'entry-1',
        targets: [
          {
            catId: 'gpt-pro',
            state,
            retryable: state === 'failed',
            attempts: [
              {
                id: state === 'failed' ? 'attempt-failed' : 'attempt-retried',
                targetCatId: 'gpt-pro',
                sequence: 1,
                state,
                createdAt: 1,
                updatedAt: 2,
              },
            ],
          },
        ],
        reminderAttempts: [],
      },
    },
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
      attemptId: 'attempt-failed',
    });
    expect(isLinkedCloudBindingRecoveryNotice(warning, [authored, warning])).toBe(true);
  });

  it('hides a stale recovery after the exact target advances beyond failed', () => {
    const authored = source('queued');
    expect(projectCloudBindingRecovery(authored, [authored, notice()])).toBeUndefined();
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
