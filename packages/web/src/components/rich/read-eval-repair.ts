import type { ApprovalHubItem, RichCardBlock } from '@cat-cafe/shared';
import { matchHostedApproval } from '@/components/shell/mailbox/approval-match';
import type { Terminal } from '@/components/shell/mailbox/approval-reconcile';
import { SETTLED_LOOKUP_PATH } from '@/components/shell/mailbox/settled-lookup';
import { useApprovalHubStore } from '@/stores/approvalHubStore';
import { apiFetch } from '@/utils/api-client';
import { evalRepairCandidate, evalRepairModel, matchesEvalRepairCard } from './eval-repair-model';
import { readEvalRepairPublication } from './read-eval-repair-publication';

export type RepairCoordinate = { threadId: string; messageId: string };
function samePublication(item: ApprovalHubItem, coordinate: RepairCoordinate): boolean {
  return (
    item.navigation?.state === 'anchored' &&
    item.navigation.approvalCardRef.threadId === coordinate.threadId &&
    item.navigation.approvalCardRef.messageId === coordinate.messageId
  );
}
async function readOwner(): Promise<string | null> {
  const response = await apiFetch('/api/session', {}, { afterCurrentGet: true });
  const body: unknown = response.ok ? await response.json() : null;
  return body && typeof body === 'object' && 'userId' in body && typeof body.userId === 'string' && body.userId
    ? body.userId
    : null;
}

/** F266 already has an owner-complete pending fan-out. Read it without any Inbox personal partition or page cap. */
export async function readEvalRepairPending(
  proposalId: string,
  coordinate: RepairCoordinate,
  expected?: ApprovalHubItem,
  block?: RichCardBlock,
): Promise<ApprovalHubItem | null> {
  try {
    const owner = await readOwner();
    if (!owner || (expected && expected.ownerUserId !== owner) || (block && evalRepairCandidate(block) !== proposalId))
      return null;
    await useApprovalHubStore.getState().fetchPending();
    const store = useApprovalHubStore.getState();
    if (!store.pendingReadAvailable || store.isLoading) return null;
    const copies = store.items.filter((item) => item.sourceFeatureId === 'F266' && item.proposalId === proposalId);
    if (copies.length !== 1) return null;
    const item = copies[0];
    if (
      item.ownerUserId !== owner ||
      !samePublication(item, coordinate) ||
      !evalRepairModel(item) ||
      (block && !matchesEvalRepairCard(block, item))
    )
      return null;
    if (!(await readEvalRepairPublication(item, coordinate))) return null;
    const match = matchHostedApproval({
      read: expected ?? item,
      readOwnerUserId: owner,
      storeItems: store.items,
      now: Date.now(),
    });
    return match.kind === 'matched' && samePublication(match.item, coordinate) ? match.item : null;
  } catch {
    return null;
  }
}

/** Only a canonical historical row proves settlement; a missing pending card is never an answer. */
export async function readEvalRepairResult(
  proposalId: string,
  coordinate: RepairCoordinate,
  expected?: ApprovalHubItem,
  block?: RichCardBlock,
): Promise<{ ownerUserId: string; terminal: Terminal; effect?: 'repair-started' } | null> {
  try {
    const owner = await readOwner();
    if (!owner || (expected && expected.ownerUserId !== owner)) return null;
    const response = await apiFetch(SETTLED_LOOKUP_PATH, {}, { afterCurrentGet: true });
    const body: unknown = response.ok ? await response.json() : null;
    if (!body || typeof body !== 'object' || !('items' in body) || !Array.isArray(body.items)) return null;
    const copies = body.items.filter(
      (item: unknown) =>
        item &&
        typeof item === 'object' &&
        'proposalId' in item &&
        item.proposalId === proposalId &&
        'sourceFeatureId' in item &&
        item.sourceFeatureId === 'F266' &&
        'ownerUserId' in item &&
        item.ownerUserId === owner,
    ) as ApprovalHubItem[];
    if (copies.length !== 1) return null;
    const item = copies[0],
      model = item.detail && evalRepairModel(item);
    if (
      !model ||
      !samePublication(item, coordinate) ||
      (block && !matchesEvalRepairCard(block, item)) ||
      (expected &&
        (expected.requesterCatId !== item.requesterCatId ||
          expected.createdAt !== item.createdAt ||
          expected.summary !== item.summary ||
          JSON.stringify(evalRepairModel(expected)) !== JSON.stringify(model)))
    )
      return null;
    const resolution = item.resolution;
    if (resolution !== 'accepted' && resolution !== 'rejected' && resolution !== 'closed_without_decision') return null;
    const settled = item as ApprovalHubItem & { decidedAt?: number; decidedBy?: string };
    const effect =
      resolution === 'accepted' &&
      item.materialization?.state === 'succeeded' &&
      typeof item.detail.canonicalEffectProofRef === 'string' &&
      item.detail.canonicalEffectProofRef.trim() &&
      item.materialization.effectProofRef === item.detail.canonicalEffectProofRef
        ? ('repair-started' as const)
        : undefined;
    return {
      ownerUserId: owner,
      terminal: {
        resolution,
        ...(resolution === 'closed_without_decision' &&
        (item.closedReason === 'expired' || item.closedReason === 'withdrawn')
          ? { closedReason: item.closedReason }
          : {}),
        ...(item.detail.closureTimeUnknown !== true &&
        typeof settled.decidedAt === 'number' &&
        Number.isFinite(settled.decidedAt)
          ? { decidedAt: settled.decidedAt }
          : {}),
        ...(typeof settled.decidedBy === 'string' && settled.decidedBy ? { decidedBy: settled.decidedBy } : {}),
        ...(resolution === 'accepted' && !effect ? { effectUnknown: true } : {}),
      },
      ...(effect ? { effect } : {}),
    };
  } catch {
    return null;
  }
}
