import { isCloudBridgeRecoveryV1 } from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chat-types';
import type { RecoveryDeliveryStatus } from './cloud-binding-recovery-operations';
import { latestCloudReceiptForTarget, latestRetryableQueueAttempt } from './queue-retry-action';

export interface CloudBindingRecoveryProjection {
  targetCatId: string;
  attemptId?: string;
  deliveryStatus?: RecoveryDeliveryStatus;
}

function recoveryFromNotice(message: ChatMessage) {
  const recovery = message.source?.meta?.cloudBridgeRecovery;
  return isCloudBridgeRecoveryV1(recovery) ? recovery : undefined;
}

export function projectCloudBindingRecovery(
  source: ChatMessage,
  timelineMessages: readonly ChatMessage[],
): CloudBindingRecoveryProjection | undefined {
  if (source.type !== 'user' || source.catId) return undefined;

  let recovery: ReturnType<typeof recoveryFromNotice>;
  for (let index = timelineMessages.length - 1; index >= 0; index -= 1) {
    const candidate = timelineMessages[index];
    if (!candidate || candidate.type !== 'connector' || candidate.replyTo !== source.id) continue;
    const parsed = recoveryFromNotice(candidate);
    if (!parsed || parsed.sourceMessageId !== source.id) continue;
    recovery = parsed;
    break;
  }
  if (!recovery) return undefined;

  const target = source.extra?.queueReceipt?.targets.find((candidate) => candidate.catId === recovery?.targetCatId);
  const latestAttempt = target?.attempts?.at(-1);
  const receipt = latestCloudReceiptForTarget(source.id, recovery.targetCatId, timelineMessages, latestAttempt);
  if (receipt) {
    if (receipt.status === 'sent' && receipt.transport === 'host' && receipt.hostMessageId)
      return { targetCatId: recovery.targetCatId, deliveryStatus: 'sent' };
    if (receipt.status === 'unknown') return { targetCatId: recovery.targetCatId, deliveryStatus: 'unknown' };
    if (receipt.status === 'failed' && receipt.transport === 'host')
      return { targetCatId: recovery.targetCatId, deliveryStatus: 'failed' };
  }
  if (!target) return { targetCatId: recovery.targetCatId };
  const attempt = latestRetryableQueueAttempt(target);
  if (!attempt)
    return {
      targetCatId: recovery.targetCatId,
      deliveryStatus:
        latestAttempt && ['queued', 'starting', 'appended'].includes(latestAttempt.state) ? 'sending' : 'unknown',
    };
  return { targetCatId: recovery.targetCatId, attemptId: attempt.id };
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
