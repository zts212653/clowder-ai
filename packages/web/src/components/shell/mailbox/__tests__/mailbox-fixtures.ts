import type { ApprovalHubItem, UnifiedAttentionItemV1, UnifiedAttentionReadV1 } from '@cat-cafe/shared';
import { anchoredApprovalNavigation } from '@/test-support/approval-navigation';
import type { MailboxRead } from '../../unified-mailbox-state';

/** Shared fixtures for the mailbox's approval modules: one owner, one generic approval, reads that list or omit it. */
export const OWNER = 'owner-1';
export const NOW = 1_000_000;

export function storeItem(overrides: Partial<ApprovalHubItem> = {}): ApprovalHubItem {
  return {
    navigation: anchoredApprovalNavigation('thread-src'),
    requesterCatId: 'opus',
    resolution: 'open',
    materialization: { state: 'not_started' },
    createdAt: 500_000,
    ownerUserId: OWNER,
    proposalId: 'p-1',
    sourceFeatureId: 'F128',
    summary: 'New thread: 记一条品味',
    detail: {},
    inlineApprovable: true,
    ...overrides,
  };
}

/** What the unified read carries for an approval: the Hub's item without its owner (the read's identity carries that). */
export function visibleApproval(item: ApprovalHubItem): Omit<ApprovalHubItem, 'ownerUserId'> {
  return Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'ownerUserId')) as Omit<
    ApprovalHubItem,
    'ownerUserId'
  >;
}

export function approvalRow(
  item: ApprovalHubItem,
  decisionRef = `approval:${item.proposalId}`,
): UnifiedAttentionItemV1 {
  return { decisionRef, kind: 'approval', summary: item.summary, approval: visibleApproval(item), linkedNeedsMe: [] };
}

/** An available, complete, verified read of one owner's page. */
export function okRead(items: UnifiedAttentionItemV1[], overrides: Partial<UnifiedAttentionReadV1> = {}): MailboxRead {
  const source = {
    status: 'available' as const,
    startedAt: 1,
    observedAt: 2,
    coverage: 'all_registered_F246_producers' as const,
    exhaustiveness: 'complete' as const,
  };
  const read: UnifiedAttentionReadV1 = {
    version: 1,
    status: 'available',
    scope: 'owner_all_projects',
    identity: { ownerUserId: OWNER },
    observedAt: 2,
    sources: {
      approvals: source,
      needsMe: { ...source, coverage: 'current_linked_F310_five_producers' },
    },
    readWindow: { startedAt: 1, endedAt: 2, consistency: 'independent_source_reads' },
    consistency: { state: 'verified', reasons: [] },
    items,
    totalCount: items.length,
    page: { offset: 0, limit: 20, scope: 'known_rows', hasMore: false },
    ...overrides,
  };
  return { kind: 'ok', read };
}
