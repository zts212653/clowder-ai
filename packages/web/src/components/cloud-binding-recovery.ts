import { isCloudBridgeRecoveryV1 } from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chat-types';
import { latestRetryableQueueAttempt } from './queue-retry-action';

export interface CloudBindingRecoveryProjection {
  targetCatId: string;
  attemptId?: string;
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

  const receipt = source.extra?.queueReceipt;
  if (!receipt) return { targetCatId: recovery.targetCatId };
  const target = receipt.targets.find((candidate) => candidate.catId === recovery?.targetCatId);
  if (!target) return undefined;
  const attempt = latestRetryableQueueAttempt(target);
  if (!attempt) return undefined;
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
