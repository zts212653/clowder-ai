import { type ApprovalDecisionReceiptV1, approvalDecisionReceiptV1Schema } from '@cat-cafe/shared';
import type { ChatMessage } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { lookupCreatedThread } from '../shell/mailbox/created-thread-lookup';
import { settledTerminal } from '../shell/mailbox/settled-lookup';
import { readSettledResults } from '../shell/mailbox/settled-results-source';

export function isChatApprovalReceipt(message: ChatMessage): boolean {
  return message.source?.connector === 'approval-hub' && message.source.meta?.approvalDecisionReceipt !== undefined;
}

export function chatApprovalReceipt(message: ChatMessage): ApprovalDecisionReceiptV1 | null {
  if (!isChatApprovalReceipt(message)) return null;
  const parsed = approvalDecisionReceiptV1Schema.safeParse(message.source?.meta?.approvalDecisionReceipt);
  return parsed.success ? parsed.data : null;
}

/** Adjacency is proven only by the supplied timeline, never timestamps or DOM proximity. */
export function receiptImmediatelyFollowsCard(
  messageId: string,
  receipt: ApprovalDecisionReceiptV1,
  threadId: string | undefined,
  messages: readonly ChatMessage[],
): boolean {
  if (receipt.approvalCardRef.threadId !== threadId) return false;
  const index = messages.findIndex((message) => message.id === messageId);
  return index > 0 && messages[index - 1].id === receipt.approvalCardRef.messageId;
}

async function sessionOwner(signal: AbortSignal): Promise<string | null> {
  const response = await apiFetch('/api/session', { signal }, { afterCurrentGet: true });
  const body: unknown = response.ok ? await response.json() : null;
  return body && typeof body === 'object' && 'userId' in body && typeof body.userId === 'string' ? body.userId : null;
}

/** Reuse the owner's bounded history and producer effect proof; never copy title/effect into the receipt carrier. */
export async function readChatApprovalReceipt(receipt: ApprovalDecisionReceiptV1, signal: AbortSignal) {
  try {
    const ownerUserId = await sessionOwner(signal);
    if (!ownerUserId || ownerUserId !== receipt.decidedBy) return null;
    const rows = await readSettledResults(ownerUserId, signal, 200);
    if (!Array.isArray(rows)) return null;
    const item = rows.find(
      (row) => row.proposalId === receipt.canonicalProposalId && row.sourceFeatureId === receipt.producerId,
    );
    if (
      !item ||
      item.requesterCatId !== receipt.requesterCatId ||
      item.resolution !== receipt.resolution ||
      item.decidedAt !== receipt.decidedAt ||
      item.decidedBy !== receipt.decidedBy ||
      item.navigation.state !== 'anchored' ||
      item.navigation.approvalCardRef.threadId !== receipt.approvalCardRef.threadId ||
      item.navigation.approvalCardRef.messageId !== receipt.approvalCardRef.messageId
    )
      return null;
    const terminal = settledTerminal({ ...item });
    if (!terminal) return null;
    if (item.sourceFeatureId === 'F128' && terminal.resolution === 'accepted') {
      const threadId = await lookupCreatedThread({ ...item, signal });
      Object.assign(terminal, threadId ? { threadId } : { effectUnknown: true });
    }
    if (signal.aborted || (await sessionOwner(signal)) !== ownerUserId) return null;
    return { ownerUserId, item, terminal };
  } catch {
    return null;
  }
}
