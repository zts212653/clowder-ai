import { readApprovalDecisionReceipt } from '../domains/cats/services/stores/host-message-policy.js';
import type { StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import type { Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';
import { isTimelinePublished } from '../domains/cats/services/stores/visibility.js';

/** Exact read admission only; caller still applies viewer visibility and never grants reply authority. */
export function isReadableApprovalDecisionReceipt(
  message: StoredMessage,
  ownerUserId: string,
  thread: Pick<Thread, 'id' | 'createdBy' | 'deletedAt'> | null | undefined,
): boolean {
  const receipt = readApprovalDecisionReceipt(message);
  return (
    receipt !== undefined &&
    message.userId === ownerUserId &&
    thread?.id === message.threadId &&
    thread.createdBy === ownerUserId &&
    !thread.deletedAt &&
    receipt.approvalCardRef.threadId === message.threadId &&
    !message.deletedAt &&
    !message.sourceParseFailure &&
    message.origin !== 'briefing' &&
    message.extra?.scheduler?.hiddenTrigger !== true &&
    message.deliveryStatus !== 'canceled' &&
    isTimelinePublished(message)
  );
}
