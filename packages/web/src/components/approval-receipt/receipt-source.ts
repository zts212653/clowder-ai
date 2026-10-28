import { type ApprovalDecisionReceiptV1, approvalDecisionReceiptV1Schema } from '@cat-cafe/shared';
import { approvalResultRead } from '@/lib/approval-result-read';
import type { ChatMessage } from '@/stores/chatStore';
import { apiFetch } from '@/utils/api-client';
import { apiSessionIdentity, observeApiSessionOwner } from '@/utils/api-session-identity';
import type { Terminal } from '../shell/mailbox/approval-reconcile';
import { lookupCreatedThread } from '../shell/mailbox/created-thread-lookup';
import { settledTerminal } from '../shell/mailbox/settled-lookup';
import type { SettledResultItem } from '../shell/mailbox/settled-results-source';
import { readSharedSettledWindow, settledWindowKey } from '../shell/mailbox/shared-settled-window';

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
  const owner =
    body && typeof body === 'object' && 'userId' in body && typeof body.userId === 'string' ? body.userId : null;
  observeApiSessionOwner(owner);
  return owner;
}

interface ReceiptSource {
  ownerUserId: string;
  item: SettledResultItem;
  terminal: Terminal;
}
function matchesReceipt(item: SettledResultItem, receipt: ApprovalDecisionReceiptV1): boolean {
  return (
    item.ownerUserId === receipt.decidedBy &&
    item.proposalId === receipt.canonicalProposalId &&
    item.sourceFeatureId === receipt.producerId &&
    item.requesterCatId === receipt.requesterCatId &&
    item.resolution === receipt.resolution &&
    item.decidedAt === receipt.decidedAt &&
    item.decidedBy === receipt.decidedBy &&
    item.navigation.state === 'anchored' &&
    item.navigation.approvalCardRef.threadId === receipt.approvalCardRef.threadId &&
    item.navigation.approvalCardRef.messageId === receipt.approvalCardRef.messageId
  );
}

const receiptPart = (receipt: ApprovalDecisionReceiptV1) =>
  `receipt-admission:${JSON.stringify([receipt.requesterCatId, receipt.resolution, receipt.decidedAt, receipt.approvalCardRef])}`;

/** The receipt retains only its admission stamp. Its item and outcome are always derived from current shared facts. */
export function deriveChatApprovalReceipt(receipt: ApprovalDecisionReceiptV1): ReceiptSource | null {
  if (apiSessionIdentity.getSnapshot().ownerUserId !== receipt.decidedBy) return null;
  const key = { owner: receipt.decidedBy, producer: receipt.producerId, proposalId: receipt.canonicalProposalId };
  const item = approvalResultRead.isCurrent(key, 'settled')
    ? approvalResultRead.snapshot<SettledResultItem>(key, 'settled').value
    : undefined;
  if (!item || !matchesReceipt(item, receipt)) return null;
  const terminal = settledTerminal({ ...item });
  if (!terminal) return null;
  if (item.sourceFeatureId === 'F128' && terminal.resolution === 'accepted') {
    const child = approvalResultRead.isCurrent(key, 'verified-thread')
      ? approvalResultRead.snapshot<string>(key, 'verified-thread').value
      : undefined;
    const admitted =
      approvalResultRead.isCurrent(key, receiptPart(receipt)) &&
      approvalResultRead.snapshot<boolean>(key, receiptPart(receipt)).value === true;
    if (!child && !admitted) return null;
    Object.assign(terminal, child ? { threadId: child } : { effectUnknown: true });
  }
  return { ownerUserId: item.ownerUserId, item, terminal };
}

export async function readChatApprovalReceipt(
  receipt: ApprovalDecisionReceiptV1,
  signal: AbortSignal,
  fresh = false,
): Promise<ReceiptSource | null> {
  const key = { owner: receipt.decidedBy, producer: receipt.producerId, proposalId: receipt.canonicalProposalId };
  try {
    const owner = apiSessionIdentity.getSnapshot().ownerUserId;
    if (owner && owner !== receipt.decidedBy) return null;
    if (!fresh) {
      const current = deriveChatApprovalReceipt(receipt);
      if (current) {
        signal.throwIfAborted();
        return current;
      }
    }
    await approvalResultRead.read(
      key,
      receiptPart(receipt),
      async (current) => !!(await readFreshReceipt(receipt, current, fresh)),
      fresh,
    );
    signal.throwIfAborted();
    return deriveChatApprovalReceipt(receipt);
  } catch {
    return null;
  }
}

async function readFreshReceipt(
  receipt: ApprovalDecisionReceiptV1,
  signal: AbortSignal,
  fresh: boolean,
): Promise<ReceiptSource | null> {
  const ownerUserId = await sessionOwner(signal);
  if (!ownerUserId || ownerUserId !== receipt.decidedBy) return null;
  const key = { owner: ownerUserId, producer: receipt.producerId, proposalId: receipt.canonicalProposalId };
  let item = fresh ? undefined : approvalResultRead.snapshot<SettledResultItem>(key, 'settled').value;
  if (!item || !matchesReceipt(item, receipt) || !approvalResultRead.isCurrent(key, 'settled')) {
    const windowKey = settledWindowKey(ownerUserId);
    const wasCached = approvalResultRead.isCurrent(windowKey, 'window');
    let rows = await readSharedSettledWindow(ownerUserId, signal, fresh);
    item = Array.isArray(rows) ? rows.find((row) => matchesReceipt(row, receipt)) : undefined;
    if (!item && wasCached && !fresh) {
      rows = await readSharedSettledWindow(ownerUserId, signal, true);
      item = Array.isArray(rows) ? rows.find((row) => matchesReceipt(row, receipt)) : undefined;
    }
  }
  if (!item || !matchesReceipt(item, receipt)) return null;
  const terminal = settledTerminal({ ...item });
  if (!terminal) return null;
  if (item.sourceFeatureId === 'F128' && terminal.resolution === 'accepted') {
    const verified = approvalResultRead.isCurrent(key, 'verified-thread')
      ? approvalResultRead.snapshot<string>(key, 'verified-thread').value
      : undefined;
    const threadId =
      !fresh && verified
        ? verified
        : await lookupCreatedThread({ ...item, signal }, { reuseProducerForDisplay: !fresh });
    Object.assign(terminal, threadId ? { threadId } : { effectUnknown: true });
  }
  if (signal.aborted || (await sessionOwner(signal)) !== ownerUserId) return null;
  return { ownerUserId, item, terminal };
}
