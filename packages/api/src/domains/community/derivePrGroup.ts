/**
 * Derive PR board group from pr_tracking AutomationState (F168).
 *
 * Groups:  completed → re-review-needed → has-conflict → in-review
 * Priority order matters: completed wins over everything.
 *
 * Real field semantics from CiCdRouter / ConflictRouter:
 *   ci.lastFingerprint = `${headSha}:${aggregateBucket}`
 *   ci.lastBucket = 'pass' | 'fail' | 'pending'
 *   conflict.mergeState = 'CONFLICTING' | 'MERGEABLE' | 'UNKNOWN'
 */

import type { AutomationState, PrBoardGroup, TaskStatus } from '@cat-cafe/shared';

export function derivePrGroup(automationState?: AutomationState | null, taskStatus?: TaskStatus): PrBoardGroup {
  if (taskStatus === 'done') return 'completed';
  if (!automationState) return 'in-review';

  const { ci, conflict, closedAt } = automationState;

  if (closedAt != null) return 'completed';

  const hasNewCommit = ci?.headSha && ci.lastFingerprint && !ci.lastFingerprint.startsWith(`${ci.headSha}:`);

  if (hasNewCommit && ci?.lastBucket === 'pass') return 're-review-needed';

  if (conflict?.mergeState === 'CONFLICTING') return 'has-conflict';

  return 'in-review';
}
