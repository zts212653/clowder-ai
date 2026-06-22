import type {
  ClosureChecklistLike,
  CommunityDecisionQueueItem,
  CommunityDecisionQueueKind,
} from './community-decision-queue-types.js';

const TERMINAL_PROJECTION_STATES = new Set(['closed', 'declined']);

export interface ClosureActionSubject {
  readonly subjectType: 'issue' | 'pr';
  readonly number: number;
  readonly title: string;
  readonly state?: string;
  readonly closureChecklist?: ClosureChecklistLike;
  /** False for projection-only issue rows whose synthetic id cannot call legacy closure mutation endpoints. */
  readonly closureActionsAvailable?: boolean;
  readonly legacyIssueId?: string;
  readonly projectionState?: string;
  readonly nextOwner?: string;
  readonly assignedCatId?: string | null;
  readonly updatedAt: number;
}

export function buildClosureActionItem(
  repo: string,
  subjectKey: string,
  subject: ClosureActionSubject,
): CommunityDecisionQueueItem | null {
  const projectionState = subject.projectionState ?? subject.state;
  if (projectionState && TERMINAL_PROJECTION_STATES.has(projectionState)) return null;

  const checklist = subject.closureChecklist;
  if (checklist?.readyToClose === true && checklist.blockers.length === 0) {
    return buildReadyToCloseItem(repo, subjectKey, subject, projectionState);
  }

  if (subject.subjectType !== 'issue' || subject.closureActionsAvailable === false || !subject.legacyIssueId) {
    return null;
  }

  const blocker = checklist?.blockers.find((b) => b.kind === 'fixed-not-reported');
  if (!blocker) return null;

  return {
    id: `decision:closure-action:${subjectKey}:${blocker.kind}`,
    repo,
    subjectKey,
    subjectType: 'issue',
    number: subject.number,
    kind: 'closure-action',
    priority: 'high',
    actor: 'case-owner',
    status: 'open',
    title: subject.title || `Issue #${subject.number}`,
    ask: `Report or waive closure for issue #${subject.number}.`,
    why: blocker.detail,
    recommendedActions: [
      {
        kind: 'mark-reported',
        label: 'Mark reported',
        endpoint: `/api/community-issues/${subject.legacyIssueId}/report`,
        method: 'POST',
        requiresAuditForm: true,
      },
      {
        kind: 'waive-closure',
        label: 'Waive closure',
        endpoint: `/api/community-issues/${subject.legacyIssueId}/waive-closure`,
        method: 'POST',
        requiresAuditForm: true,
      },
    ],
    evidenceRefs: [{ label: blocker.detail, source: 'closure-checklist', text: blocker.detail }],
    source: {
      projectionState,
      nextOwner: subject.nextOwner,
      assignedCatId: subject.assignedCatId,
      closureBlocker: blocker.kind,
    },
    firstSeenAt: subject.updatedAt,
    lastUpdatedAt: subject.updatedAt,
  };
}

function buildReadyToCloseItem(
  repo: string,
  subjectKey: string,
  subject: ClosureActionSubject,
  projectionState: string | undefined,
): CommunityDecisionQueueItem {
  const label = subject.subjectType === 'issue' ? 'issue' : 'PR';
  const path = subject.subjectType === 'issue' ? `issues/${subject.number}` : `pull/${subject.number}`;
  const titlePrefix = subject.subjectType === 'issue' ? 'Issue' : 'PR';

  return {
    id: `decision:closure-action:${subjectKey}:ready-to-close`,
    repo,
    subjectKey,
    subjectType: subject.subjectType,
    number: subject.number,
    kind: 'closure-action' satisfies CommunityDecisionQueueKind,
    priority: 'high',
    actor: 'case-owner',
    status: 'open',
    title: subject.title || `${titlePrefix} #${subject.number}`,
    ask: `Close ${label} #${subject.number} on GitHub.`,
    why: `Closure checklist is complete; close the GitHub ${label} and let the webhook/Reconciler confirm.`,
    recommendedActions: [
      {
        kind: 'close-via-github',
        label: 'Close on GitHub',
        endpoint: `https://github.com/${repo}/${path}`,
        method: 'GET',
      },
    ],
    evidenceRefs: [
      {
        label: 'Closure checklist ready',
        source: 'closure-checklist',
        text: 'All closure blockers are cleared.',
      },
    ],
    source: {
      projectionState,
      nextOwner: subject.nextOwner,
      assignedCatId: subject.assignedCatId,
    },
    firstSeenAt: subject.updatedAt,
    lastUpdatedAt: subject.updatedAt,
  };
}
