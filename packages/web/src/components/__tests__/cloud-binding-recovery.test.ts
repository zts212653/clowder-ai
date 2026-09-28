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

  it('keeps the source card in a truthful waiting state after queue retry acceptance', () => {
    const authored = source('queued');
    expect(projectCloudBindingRecovery(authored, [authored, notice()])).toEqual({
      targetCatId: 'gpt-pro',
      deliveryStatus: 'sending',
    });
  });

  it.each([
    ['queued', 'sent'],
    ['queued', 'unknown'],
    ['failed', 'sent'],
    ['failed', 'unknown'],
  ] as const)('keeps %s authoritative until a %s receipt matches the current dispatch', (state, receiptStatus) => {
    const authored = source(state);
    const attempt = authored.extra!.queueReceipt!.targets[0]!.attempts![0]!;
    attempt.createdAt = 4;
    const receiptNotice = notice({ id: 'receipt-2', timestamp: 5 });
    receiptNotice.source!.meta = {
      cloudBridgeOutboundReceipt: {
        v: 1,
        sourceMessageId: authored.id,
        sourceSender: { kind: 'user', id: 'owner' },
        targetCatId: 'gpt-pro',
        dispatchInvocationId: 'dispatch-old',
        status: receiptStatus,
        transport: 'host',
        hostMessageId: 'real-host-id',
        idempotency: { keyKind: 'source_message_id', disposition: 'fresh' },
      },
    };
    const pendingProjection =
      state === 'queued'
        ? { targetCatId: 'gpt-pro', deliveryStatus: 'sending' }
        : { targetCatId: 'gpt-pro', attemptId: 'attempt-failed' };
    expect(projectCloudBindingRecovery(authored, [authored, notice(), receiptNotice])).toEqual(pendingProjection);
    attempt.invocationId = 'dispatch-new';
    expect(projectCloudBindingRecovery(authored, [authored, notice(), receiptNotice])).toEqual(pendingProjection);
    (receiptNotice.source!.meta.cloudBridgeOutboundReceipt as { dispatchInvocationId: string }).dispatchInvocationId =
      'dispatch-new';
    expect(projectCloudBindingRecovery(authored, [authored, notice(), receiptNotice])?.deliveryStatus).toBe(
      receiptStatus,
    );
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
