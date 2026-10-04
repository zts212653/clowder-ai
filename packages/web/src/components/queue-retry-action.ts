import { isCloudBridgeOutboundReceiptV1, type QueueReceiptTarget, type QueueTargetAttempt } from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chat-types';

export function latestCloudReceiptForTarget(
  sourceMessageId: string,
  targetCatId: string,
  messages: readonly ChatMessage[],
  latestAttempt?: QueueTargetAttempt,
) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const notice = messages[index];
    const receipt = notice?.source?.meta?.cloudBridgeOutboundReceipt;
    if (notice?.type !== 'connector' || notice.replyTo !== sourceMessageId || !isCloudBridgeOutboundReceiptV1(receipt))
      continue;
    if (receipt.sourceMessageId !== sourceMessageId || receipt.targetCatId !== targetCatId) continue;
    if (
      latestAttempt &&
      (!latestAttempt.invocationId ||
        notice.timestamp < latestAttempt.createdAt ||
        receipt.dispatchInvocationId !== latestAttempt.invocationId)
    )
      continue;
    return receipt;
  }
  return undefined;
}

export function latestRetryableQueueAttempt(
  target: QueueReceiptTarget,
  context?: { messageId?: string; messages: readonly ChatMessage[] },
): QueueTargetAttempt | undefined {
  if (target.state !== 'failed' || target.retryable === false) return undefined;
  const latest = target.attempts?.at(-1);
  const receipt = context?.messageId
    ? latestCloudReceiptForTarget(context.messageId, target.catId, context.messages, latest)
    : undefined;
  if (receipt?.transport === 'host' && receipt.status === 'failed') return undefined;
  return latest?.state === 'failed' ||
    (latest?.state === 'cancelled' && latest.terminalReason === 'invocation_cancelled')
    ? latest
    : undefined;
}
