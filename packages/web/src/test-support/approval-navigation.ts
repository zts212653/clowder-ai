import type { ApprovalNavigation } from '@cat-cafe/shared';

interface AnchoredNavigationOptions {
  originMessageId?: string;
  cardThreadId?: string;
  cardMessageId?: string;
}

export function anchoredApprovalNavigation(
  originThreadId: string,
  {
    originMessageId = 'origin-message',
    cardThreadId = originThreadId,
    cardMessageId = 'approval-card',
  }: AnchoredNavigationOptions = {},
): ApprovalNavigation {
  return {
    state: 'anchored',
    originRef: { kind: 'message', threadId: originThreadId, messageId: originMessageId },
    approvalCardRef: { threadId: cardThreadId, messageId: cardMessageId },
  };
}
