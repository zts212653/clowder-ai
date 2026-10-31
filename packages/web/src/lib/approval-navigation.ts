import type { ApprovalNavigation } from '@cat-cafe/shared';

export function approvalOriginThreadId(navigation: ApprovalNavigation): string | undefined {
  if (navigation.state === 'legacy_unanchored') return navigation.legacyThreadId;
  return navigation.originRef.threadId;
}

export function approvalNavigationThreadIds(navigation: ApprovalNavigation): string[] {
  if (navigation.state === 'legacy_unanchored') {
    return navigation.legacyThreadId ? [navigation.legacyThreadId] : [];
  }
  const ids = new Set([navigation.approvalCardRef.threadId]);
  if (navigation.originRef.threadId) ids.add(navigation.originRef.threadId);
  return [...ids];
}
