import type { ApprovalHubItem, EventMemoryCorrectionProposalView, RichCardBlock } from '@cat-cafe/shared';
import { matchHostedApproval } from '@/components/shell/mailbox/approval-match';
import { parseUnifiedAttentionRead } from '@/components/shell/parse-unified-attention';
import { apiFetch } from '@/utils/api-client';
import { isEventCorrection } from './event-correction-read';
import { type MemoryEvent, memoryObject } from './owner-memory-read';
import { readEvent } from './read-memory-event';

export interface CorrectionMemory {
  proposal: EventMemoryCorrectionProposalView;
  event: MemoryEvent;
}
export interface CorrectionCoordinate {
  threadId: string;
  messageId: string;
}

/** The canonical execution phase is already accepted. This recognizes its original recovery lane, never a new decision. */
export function isCorrectionRecoveryProjection(
  item: Pick<
    ApprovalHubItem,
    'sourceFeatureId' | 'resolution' | 'materialization' | 'inlineApprovable' | 'decisionMode'
  >,
): boolean {
  return (
    item.sourceFeatureId === 'F321' &&
    item.resolution === 'accepted' &&
    item.materialization.state === 'outcome_unknown' &&
    !item.inlineApprovable &&
    item.decisionMode === undefined
  );
}

/** Recognition only. The canonical owner read supplies the actual request and writer coordinates. */
export function correctionPublicationCandidate(block: RichCardBlock): string | null {
  const stamp = block.meta?.approval;
  if (
    !memoryObject(stamp) ||
    Object.keys(stamp).length !== 2 ||
    stamp.producerId !== 'F321' ||
    typeof stamp.canonicalProposalId !== 'string' ||
    block.actions !== undefined
  )
    return null;
  return block.id === `event-memory-correction-${stamp.canonicalProposalId}` ? stamp.canonicalProposalId : null;
}
export function isCorrectionPublication(block: RichCardBlock): boolean {
  return (
    block.id.startsWith('event-memory-correction-') ||
    (memoryObject(block.meta?.approval) && block.meta.approval.producerId === 'F321')
  );
}
export async function readCorrectionOwner(): Promise<string | null> {
  const response = await apiFetch('/api/session', {}, { afterCurrentGet: true });
  const body: unknown = response.ok ? await response.json() : null;
  return memoryObject(body) && typeof body.userId === 'string' && body.userId ? body.userId : null;
}

/** Fresh owner-auth producer reads, including the complete event (paged large records use the original reader). */
export async function readCorrectionMemory(
  item: ApprovalHubItem,
  signal: AbortSignal,
): Promise<CorrectionMemory | null> {
  if (
    item.sourceFeatureId !== 'F321' ||
    item.navigation?.state !== 'anchored' ||
    typeof item.detail.eventId !== 'string'
  )
    return null;
  const response = await apiFetch(
    `/api/event-memory-corrections/${encodeURIComponent(item.proposalId)}`,
    { signal },
    { afterCurrentGet: true },
  );
  const body: unknown = response.ok ? await response.json() : null;
  if (!memoryObject(body) || !isEventCorrection(body.proposal)) return null;
  const proposal = body.proposal;
  if (
    (proposal.status === 'pending' && (item.resolution !== 'open' || !item.inlineApprovable)) ||
    (proposal.status === 'approving' && !isCorrectionRecoveryProjection(item))
  )
    return null;
  if (
    proposal.proposalId !== item.proposalId ||
    proposal.sourceCatId !== item.requesterCatId ||
    proposal.sourceThreadId !== item.navigation.approvalCardRef.threadId ||
    proposal.createdAt !== item.createdAt ||
    proposal.expectedRevision !== item.detail.expectedRevision ||
    proposal.reason !== item.detail.reason ||
    JSON.stringify(proposal.suggestedPatch) !== JSON.stringify(item.detail.suggestedPatch) ||
    JSON.stringify(proposal.source) !== JSON.stringify(item.detail.source)
  )
    return null;
  const event = await readEvent(item.detail.eventId, signal, true);
  if (event.ownerUserId !== item.ownerUserId) return null;
  if (proposal.status === 'pending' || proposal.status === 'approving') {
    const matching = event.correctionProposals?.filter((p) => p.proposalId === item.proposalId);
    if (matching?.length !== 1 || JSON.stringify(matching[0]) !== JSON.stringify(proposal)) return null;
  }
  return { event, proposal };
}

/** The original card's own re-read is separate from the global store's optimistic removal or an old GET. */
export async function correctionApprovalStillCurrent(item: ApprovalHubItem): Promise<boolean> {
  const owner = await readCorrectionOwner();
  if (
    owner !== item.ownerUserId ||
    !((item.resolution === 'open' && item.inlineApprovable) || isCorrectionRecoveryProjection(item))
  )
    return false;
  const response = await apiFetch('/api/approval-hub/pending', {}, { afterCurrentGet: true });
  const body: unknown = response.ok ? await response.json() : null;
  if (!memoryObject(body) || !Array.isArray(body.items)) return false;
  const match = matchHostedApproval({ read: item, readOwnerUserId: owner, storeItems: body.items, now: Date.now() });
  return match.kind === 'matched' && JSON.stringify(match.item.navigation) === JSON.stringify(item.navigation);
}

/** Chat finds its exact canonical publication across pages and both personal partitions. A miss is not handled. */
export async function readPublishedCorrection(
  block: RichCardBlock,
  coordinate: CorrectionCoordinate,
): Promise<ApprovalHubItem | null> {
  const proposalId = correctionPublicationCandidate(block),
    owner = await readCorrectionOwner();
  if (!proposalId || !owner) return null;
  for (let offset = 0; ; offset += 20) {
    const response = await apiFetch(
      `/api/concierge/work/decisions?view=unified&offset=${offset}&limit=20`,
      {},
      { afterCurrentGet: true },
    );
    const read = response.ok ? parseUnifiedAttentionRead(await response.json()) : null;
    if (
      !read ||
      read.identity.ownerUserId !== owner ||
      read.status !== 'available' ||
      read.consistency.state !== 'verified' ||
      read.personalView ||
      read.page.offset !== offset ||
      read.page.limit !== 20
    )
      return null;
    const items = read.items.filter(
      (r) => r.approval?.sourceFeatureId === 'F321' && r.approval.proposalId === proposalId,
    );
    if (items.length > 1) return null;
    if (items.length === 1) {
      const approval = items[0].approval;
      if (
        !approval ||
        approval.navigation?.state !== 'anchored' ||
        approval.navigation.approvalCardRef.threadId !== coordinate.threadId ||
        approval.navigation.approvalCardRef.messageId !== coordinate.messageId
      )
        return null;
      const item = { ...approval, ownerUserId: owner };
      return (await correctionApprovalStillCurrent(item)) ? item : null;
    }
    if (!read.page.hasMore || !read.items.length) return null;
  }
}
