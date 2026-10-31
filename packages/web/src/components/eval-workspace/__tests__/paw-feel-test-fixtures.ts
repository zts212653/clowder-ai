import type { PawFeelInboxItem, PawFeelIssueCounts, PawFeelIssueProjection } from '@cat-cafe/shared';

export function buildTestIssue(state: PawFeelInboxItem['disposition']['state']): PawFeelIssueProjection {
  return state === 'no_action'
    ? {
        resolution: 'resolved',
        continuation: { kind: 'no_action', evidenceRefs: [] },
        ageMs: 3_600_000,
        resolvedAt: '2026-07-20T01:00:00.000Z',
      }
    : {
        resolution: 'open',
        continuation: { kind: 'review_required', evidenceRefs: [] },
        ageMs: 3_600_000,
      };
}

export function countTestIssues(items: readonly PawFeelInboxItem[]): PawFeelIssueCounts {
  return {
    open: items.filter((item) => item.issue.resolution === 'open').length,
    resolved: items.filter((item) => item.issue.resolution === 'resolved').length,
    overdue: items.filter((item) => item.issue.resolution === 'open' && item.issue.ageMs >= 72 * 3_600_000).length,
  };
}
