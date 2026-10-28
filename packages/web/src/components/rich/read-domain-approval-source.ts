import type { ApprovalHubItem, RichCardBlock, UnifiedAttentionItemV1 } from '@cat-cafe/shared';
import { matchHostedApproval } from '@/components/shell/mailbox/approval-match';
import { parseUnifiedAttentionRead } from '@/components/shell/parse-unified-attention';
import { readFreshApprovalResultOwner } from '@/lib/approval-result-owner';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { apiFetch } from '@/utils/api-client';

export interface DomainCardCoordinate {
  threadId: string;
  messageId: string;
}
export interface DomainApprovalSource {
  item: ApprovalHubItem;
  row: UnifiedAttentionItemV1;
  ownerUserId: string;
}
const prefix = { F193: 'dispatch', F221: 'taste-proposal', F260: 'entity-proposal' } as const;

/** Route malformed copies to this family's readonly verification view; recognition never grants a writer. */
export function isDomainApprovalPublication(block: RichCardBlock): boolean {
  const stamp = block.meta?.approval;
  const producer = stamp && typeof stamp === 'object' && 'producerId' in stamp ? stamp.producerId : null;
  return (
    (typeof producer === 'string' && Object.hasOwn(prefix, producer)) ||
    Object.values(prefix).some((id) => block.id.startsWith(`${id}-`))
  );
}

/** This only recognizes a candidate. The authenticated canonical proof below alone enables its writer. */
export function domainApprovalCandidate(
  block: RichCardBlock,
): { feature: keyof typeof prefix; proposalId: string } | null {
  const stamp = block.meta?.approval;
  if (
    !stamp ||
    typeof stamp !== 'object' ||
    Array.isArray(stamp) ||
    Object.keys(stamp).length !== 2 ||
    block.actions !== undefined
  )
    return null;
  const value = stamp as Record<string, unknown>;
  if (
    typeof value.producerId !== 'string' ||
    !Object.hasOwn(prefix, value.producerId) ||
    typeof value.canonicalProposalId !== 'string'
  )
    return null;
  const feature = value.producerId as keyof typeof prefix;
  return block.id === `${prefix[feature]}-${value.canonicalProposalId}`
    ? { feature, proposalId: value.canonicalProposalId }
    : null;
}

/** Read the canonical vector, not either personal partition; a missing page is never a terminal decision. */
export async function readDomainApprovalSource(
  block: RichCardBlock,
  coordinate: DomainCardCoordinate,
  fresh = true,
): Promise<DomainApprovalSource | null> {
  const candidate = domainApprovalCandidate(block);
  if (!candidate) return null;
  try {
    const userId = await readFreshApprovalResultOwner();
    if (!userId) return null;
    const identity = { userId };
    for (let offset = 0; ; offset += 20) {
      const response = await apiFetch(
        `/api/concierge/work/decisions?view=unified&offset=${offset}&limit=20`,
        {},
        { afterCurrentGet: true },
      );
      if (!response.ok) return null;
      const read = parseUnifiedAttentionRead(await response.json());
      if (
        !read ||
        read.identity.ownerUserId !== identity.userId ||
        read.status !== 'available' ||
        read.consistency.state !== 'verified' ||
        read.page.offset !== offset ||
        read.page.limit !== 20 ||
        read.personalView
      )
        return null;
      const matches = read.items.filter(
        (row) =>
          row.approval?.sourceFeatureId === candidate.feature && row.approval.proposalId === candidate.proposalId,
      );
      if (matches.length > 1) return null;
      if (matches.length === 1) {
        const row = matches[0],
          proof = row.originalApprovalCard,
          approval = row.approval;
        if (
          !proof ||
          !approval ||
          proof.cardRef.threadId !== coordinate.threadId ||
          proof.cardRef.messageId !== coordinate.messageId ||
          proof.cardRef.blockId !== block.id ||
          JSON.stringify(proof.block) !== JSON.stringify(block)
        )
          return null;
        if (fresh) await useApprovalHubStore.getState().fetchPending();
        else await useApprovalHubStore.getState().ensurePending(identity.userId);
        const store = useApprovalHubStore.getState();
        if (!store.pendingReadAvailable || store.isLoading) return null;
        const match = matchHostedApproval({
          read: approval,
          readOwnerUserId: identity.userId,
          storeItems: store.items,
          now: Date.now(),
        });
        if (match.kind !== 'matched' || JSON.stringify(match.item.navigation) !== JSON.stringify(approval.navigation))
          return null;
        return { item: match.item, row, ownerUserId: identity.userId };
      }
      if (!read.page.hasMore || read.items.length === 0) return null;
    }
  } catch {
    return null;
  }
}
