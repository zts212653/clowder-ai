import { isCloudBridgeOutboundReceiptV1, isCloudBridgeRecoveryV1, isCloudBridgeRetryV1 } from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chat-types';
import type { RecoveryDeliveryStatus } from './cloud-binding-recovery-operations';

export interface CloudBindingRecoveryProjection {
  targetCatId: string;
  attemptId?: string;
  deliveryStatus?: RecoveryDeliveryStatus;
}

function recoveryFromNotice(message: ChatMessage) {
  const recovery = message.source?.meta?.cloudBridgeRecovery;
  return isCloudBridgeRecoveryV1(recovery) ? recovery : undefined;
}

function latestRecoveryForSource(sourceId: string, timelineMessages: readonly ChatMessage[]) {
  for (let index = timelineMessages.length - 1; index >= 0; index -= 1) {
    const candidate = timelineMessages[index];
    if (!candidate || candidate.type !== 'connector' || candidate.replyTo !== sourceId) continue;
    const parsed = recoveryFromNotice(candidate);
    if (parsed?.sourceMessageId === sourceId) return parsed;
  }
  return undefined;
}

function deliveryStatusForRecovery(
  sourceId: string,
  recovery: NonNullable<ReturnType<typeof recoveryFromNotice>>,
  timelineMessages: readonly ChatMessage[],
): RecoveryDeliveryStatus | undefined {
  for (let index = timelineMessages.length - 1; index >= 0; index -= 1) {
    const notice = timelineMessages[index];
    const receipt = notice?.source?.meta?.cloudBridgeOutboundReceipt;
    if (notice?.type !== 'connector' || notice.replyTo !== sourceId || !isCloudBridgeOutboundReceiptV1(receipt)) {
      continue;
    }
    if (
      receipt.sourceMessageId !== sourceId ||
      receipt.targetCatId !== recovery.targetCatId ||
      receipt.dispatchInvocationId !== recovery.dispatchInvocationId
    ) {
      continue;
    }
    if (receipt.status === 'sent' && receipt.transport === 'host' && receipt.hostMessageId) return 'sent';
    return receipt.status === 'unknown' ? 'unknown' : undefined;
  }
  return undefined;
}

export function projectCloudBindingRecovery(
  source: ChatMessage,
  timelineMessages: readonly ChatMessage[],
): CloudBindingRecoveryProjection | undefined {
  if (source.type !== 'user' || source.catId) return undefined;

  const recovery = latestRecoveryForSource(source.id, timelineMessages);
  if (!recovery) return undefined;

  const alreadyRetried = timelineMessages.some((candidate) => {
    const retry = candidate.extra?.cloudBridgeRetry;
    return (
      candidate.type === 'user' &&
      isCloudBridgeRetryV1(retry) &&
      retry.sourceMessageId === source.id &&
      retry.targetCatId === recovery?.targetCatId &&
      retry.priorDispatchInvocationId === recovery.dispatchInvocationId
    );
  });
  if (alreadyRetried) return undefined;

  const deliveryStatus = deliveryStatusForRecovery(source.id, recovery, timelineMessages);
  return {
    targetCatId: recovery.targetCatId,
    attemptId: recovery.dispatchInvocationId,
    ...(deliveryStatus ? { deliveryStatus } : {}),
  };
}

export function isLinkedCloudBindingRecoveryNotice(
  notice: ChatMessage,
  timelineMessages: readonly ChatMessage[],
): boolean {
  const recovery = recoveryFromNotice(notice);
  if (!recovery || notice.replyTo !== recovery.sourceMessageId) return false;
  return timelineMessages.some(
    (candidate) => candidate.id === recovery.sourceMessageId && candidate.type === 'user' && candidate.catId == null,
  );
}

export function hasCloudBindingRecoveryMetadata(message: ChatMessage): boolean {
  return recoveryFromNotice(message) !== undefined;
}
