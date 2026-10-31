import {
  type CloudBridgeRecoveryV1,
  isCloudBridgeOutboundReceiptV1,
  isCloudBridgeRecoveryV1,
  isCloudBridgeRetryV1,
} from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chat-types';
import type { RecoveryDeliveryStatus } from './cloud-binding-recovery-operations';
import { cloudDispatchReceipt, cloudReceiptOf } from './cloud-dispatch-receipt';

export interface CloudBindingRecoveryProjection {
  targetCatId: string;
  attemptId?: string;
  deliveryStatus?: RecoveryDeliveryStatus;
  /** Owner connection setup only; never grants the user-source retry operation to a cat source. */
  bindingOnly?: true;
}

function recoveryFromNotice(message: ChatMessage): CloudBridgeRecoveryV1 | undefined {
  const recovery = message.source?.meta?.cloudBridgeRecovery;
  if (message.source?.connector === 'cloud-bridge-status' && isCloudBridgeRecoveryV1(recovery)) return recovery;
  const info = message.extra?.systemInfo;
  const receipt = cloudReceiptOf(message);
  if (
    message.type !== 'system' ||
    info?.payload.type !== 'cloud_bridge_status' ||
    info.payload.reason !== 'needs-binding' ||
    !receipt ||
    info.fallbackCatId !== receipt.targetCatId ||
    info.payload.catId !== receipt.targetCatId ||
    receipt.sourceSender.kind !== 'user' ||
    receipt.status !== 'failed' ||
    receipt.transport !== 'none' ||
    receipt.hostMessageId ||
    receipt.idempotency.disposition !== 'not_attempted'
  )
    return undefined;
  return {
    v: 1,
    kind: 'needs_binding',
    sourceMessageId: receipt.sourceMessageId,
    targetCatId: receipt.targetCatId,
    dispatchInvocationId: receipt.dispatchInvocationId,
  };
}

function latestRecoveryForSource(source: ChatMessage, timelineMessages: readonly ChatMessage[], includeLive = true) {
  for (let index = timelineMessages.length - 1; index >= 0; index -= 1) {
    const candidate = timelineMessages[index];
    if (!candidate) continue;
    if (!includeLive && candidate.type === 'system') continue;
    const parsed = recoveryFromNotice(candidate);
    if (parsed?.sourceMessageId !== source.id) continue;
    if (candidate.type === 'connector' && candidate.replyTo === source.id) return parsed;
    const current = cloudDispatchReceipt(source, parsed.targetCatId, timelineMessages);
    const receipt = cloudReceiptOf(candidate);
    if (current?.identity.dispatchInvocationId !== parsed.dispatchInvocationId) continue;
    if (source.from?.kind !== 'user' || receipt?.sourceSender.id !== source.from.userId) continue;
    return parsed;
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
    if (receipt.status === 'failed' && receipt.transport === 'host') return 'failed';
    return receipt.status === 'unknown' ? 'unknown' : undefined;
  }
  return undefined;
}

export function projectCloudBindingRecovery(
  source: ChatMessage,
  timelineMessages: readonly ChatMessage[],
  includeLive = true,
): CloudBindingRecoveryProjection | undefined {
  if (source.extra?.recall || source.visibility === 'whisper') return undefined;
  if (source.type === 'assistant' && source.from?.kind === 'agent' && source.catId === source.from.catId) {
    const dispatch = cloudDispatchReceipt(source, 'gpt-pro', timelineMessages);
    const receipt = dispatch?.receipt;
    if (
      !source.isStreaming &&
      source.content.trim() &&
      receipt?.sourceSender.kind === 'cat' &&
      receipt.sourceSender.id === source.catId &&
      receipt.status === 'failed' &&
      receipt.transport === 'none' &&
      !receipt.hostMessageId &&
      receipt.idempotency.disposition === 'not_attempted'
    )
      return { targetCatId: 'gpt-pro', attemptId: receipt.dispatchInvocationId, bindingOnly: true };
    return undefined;
  }
  if (source.type !== 'user' || source.catId) return undefined;

  const recovery = latestRecoveryForSource(source, timelineMessages, includeLive);
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
    ...(deliveryStatus === 'failed' ? {} : { attemptId: recovery.dispatchInvocationId }),
    ...(deliveryStatus ? { deliveryStatus } : {}),
  };
}

export function isLinkedCloudBindingRecoveryNotice(
  notice: ChatMessage,
  timelineMessages: readonly ChatMessage[],
): boolean {
  const recovery = recoveryFromNotice(notice);
  if (!recovery || (notice.type === 'connector' && notice.replyTo !== recovery.sourceMessageId)) return false;
  return timelineMessages.some(
    (candidate) =>
      candidate.id === recovery.sourceMessageId &&
      candidate.type === 'user' &&
      candidate.catId == null &&
      !candidate.extra?.recall &&
      candidate.visibility !== 'whisper' &&
      latestRecoveryForSource(candidate, timelineMessages)?.dispatchInvocationId === recovery.dispatchInvocationId,
  );
}

export function hasCloudBindingRecoveryMetadata(message: ChatMessage): boolean {
  return recoveryFromNotice(message) !== undefined;
}
