/**
 * F168 Phase E — Community decision queue selector.
 *
 * Pure read-model builder. It does not read Redis, fetch GitHub, append events,
 * or mutate stores. Callers provide board-shaped issues/PRs plus reconciliation
 * findings; this selector returns the actionable queue.
 */

import { buildClosureActionItem } from './community-decision-queue-closure.js';
import type {
  BuildCommunityDecisionQueueInput,
  CommunityBoardIssueLike,
  CommunityDecisionActor,
  CommunityDecisionPriority,
  CommunityDecisionQueueItem,
  CommunityDecisionQueueKind,
  ReconciliationFindingLike,
} from './community-decision-queue-types.js';
import { parseRouteRecommendation } from './community-route-recommendation.js';

export type {
  BuildCommunityDecisionQueueInput,
  ClosureChecklistBlockerLike,
  ClosureChecklistLike,
  CommunityBoardIssueLike,
  CommunityBoardPrLike,
  CommunityDecisionAction,
  CommunityDecisionActor,
  CommunityDecisionEvidenceRef,
  CommunityDecisionPriority,
  CommunityDecisionQueueItem,
  CommunityDecisionQueueKind,
  CommunityDecisionStatus,
  ReconciliationFindingLike,
} from './community-decision-queue-types.js';

const PRIORITY_RANK: Record<CommunityDecisionPriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

const ACTOR_RANK: Record<CommunityDecisionActor, number> = {
  cvo: 0,
  'case-owner': 1,
  reconciler: 2,
  'external-author': 3,
};

const URGENT_FINDINGS = new Set([
  'github-reopened-case-closed',
  'github-closed-case-open',
  'case-closed-github-open',
  'case-fixed-unreported',
]);
const SLA_DEAD_LETTER_FINDINGS = new Set(['case-fixed-unreported']);
const EXTERNAL_FOLLOWUP_FINDINGS = new Set(['stale-awaiting-external', 'stale-needs-info']);
const DIRECTION_SUPPRESSING_PROJECTION_STATES = new Set([
  'routed',
  'in_progress',
  'awaiting_external',
  'needs_info',
  'fixed',
  'reported',
  'closed',
  'declined',
]);

export function buildCommunityDecisionQueue(input: BuildCommunityDecisionQueueInput): CommunityDecisionQueueItem[] {
  const items: CommunityDecisionQueueItem[] = [];
  const threadIdBySubject = buildThreadIdBySubject(input);

  for (const issue of input.issues) {
    const subjectKey = `issue:${issue.repo}#${issue.issueNumber}`;
    if (issue.repo !== input.repo) continue;

    const directionItem = buildDirectionDecisionItem(input.repo, subjectKey, issue);
    if (directionItem) items.push(directionItem);

    const closureItem = buildClosureActionItem(input.repo, subjectKey, {
      subjectType: 'issue',
      number: issue.issueNumber,
      title: issue.title,
      state: issue.state,
      projectionState: issue.projectionState,
      closureChecklist: issue.closureChecklist,
      closureActionsAvailable: issue.closureActionsAvailable,
      legacyIssueId: issue.id,
      nextOwner: issue.nextOwner,
      assignedCatId: issue.assignedCatId,
      updatedAt: issue.updatedAt,
    });
    if (closureItem) items.push(closureItem);
  }

  for (const pr of input.prItems) {
    if (!pr.prNumber) continue;
    const subjectKey = `pr:${input.repo}#${pr.prNumber}`;
    const closureItem = buildClosureActionItem(input.repo, subjectKey, {
      subjectType: 'pr',
      number: pr.prNumber,
      title: pr.title,
      state: pr.state ?? pr.status,
      projectionState: pr.projectionState,
      closureChecklist: pr.closureChecklist,
      nextOwner: pr.nextOwner,
      updatedAt: pr.updatedAt,
    });
    if (closureItem) items.push(closureItem);
  }

  for (const finding of input.findings) {
    if (!isActionableFindingStatus(finding.status)) continue;
    const parsed = parseSubjectKey(finding.subjectKey);
    if (!parsed || parsed.repo !== input.repo) continue;
    items.push(buildFindingItem(input.repo, parsed, finding));
  }

  return coalesceBySubject(items)
    .map((item) => withOwnerThreadAction(item, ownerThreadIdForItem(item, threadIdBySubject)))
    .sort(compareQueueItems);
}

function buildThreadIdBySubject(input: BuildCommunityDecisionQueueInput): Map<string, string> {
  const threadIdBySubject = new Map<string, string>();
  for (const issue of input.issues) {
    const threadId = textField(issue.assignedThreadId);
    if (issue.repo === input.repo && threadId)
      threadIdBySubject.set(`issue:${issue.repo}#${issue.issueNumber}`, threadId);
  }
  for (const pr of input.prItems) {
    if (!pr.prNumber) continue;
    const threadId = textField(pr.threadId);
    if (threadId) threadIdBySubject.set(`pr:${input.repo}#${pr.prNumber}`, threadId);
  }
  return threadIdBySubject;
}

function ownerThreadIdForItem(
  item: CommunityDecisionQueueItem,
  threadIdBySubject: ReadonlyMap<string, string>,
): string | undefined {
  const routeRecommendation = item.source.routeRecommendation;
  const recommendedThreadId =
    routeRecommendation?.kind === 'existing-thread' ? textField(routeRecommendation.threadId) : undefined;
  if (recommendedThreadId) return recommendedThreadId;
  const mappedThreadId = textField(threadIdBySubject.get(item.subjectKey));
  if (mappedThreadId) return mappedThreadId;
  return undefined;
}

function withOwnerThreadAction(
  item: CommunityDecisionQueueItem,
  threadId: string | undefined,
): CommunityDecisionQueueItem {
  const ownerThreadId = textField(threadId);
  if (!ownerThreadId) return item;
  const hasThreadAction = item.recommendedActions.some((action) => action.kind === 'open-thread');
  return {
    ...item,
    recommendedActions: hasThreadAction
      ? item.recommendedActions
      : [
          {
            kind: 'open-thread',
            label: 'Open thread',
            threadId: ownerThreadId,
          },
          ...item.recommendedActions,
        ],
    source: {
      ...item.source,
      assignedThreadId: ownerThreadId,
    },
  };
}

function buildDirectionDecisionItem(
  repo: string,
  subjectKey: string,
  issue: CommunityBoardIssueLike,
): CommunityDecisionQueueItem | null {
  if (issue.state !== 'pending-decision') return null;
  if (issue.projectionState && DIRECTION_SUPPRESSING_PROJECTION_STATES.has(issue.projectionState)) return null;
  const directionEntry = findDirectionEntry(issue.directionCard);
  if (!directionEntry) return null;
  const updatedAt = numberField(directionEntry.timestamp) ?? issue.updatedAt;
  const parsedRouteRecommendation = parseRouteRecommendation(directionEntry.routeRecommendation);
  return {
    id: `decision:direction-decision:${subjectKey}:${issue.id}`,
    repo,
    subjectKey,
    subjectType: 'issue',
    number: issue.issueNumber,
    kind: 'direction-decision',
    priority: 'high',
    actor: 'cvo',
    status: 'open',
    title: issue.title || `Issue #${issue.issueNumber}`,
    ask: `Decide the routing direction for issue #${issue.issueNumber}.`,
    why: textField(directionEntry.narrative) ?? 'A route decision is pending and needs confirmation.',
    recommendedActions: [
      {
        kind: 'resolve-direction',
        label: 'Resolve direction',
        endpoint: `/api/community-issues/${issue.id}/resolve`,
        method: 'POST',
      },
    ],
    evidenceRefs: [
      {
        label: 'Direction card',
        source: 'direction-card',
        text: textField(directionEntry.narrative),
      },
    ],
    source: {
      projectionState: issue.projectionState ?? issue.state,
      nextOwner: issue.nextOwner,
      assignedCatId: textField(issue.assignedCatId),
      catId: textField(directionEntry.catId),
      directionCardEntryId: textField(directionEntry.id),
      routeRecommendation: parsedRouteRecommendation.ok ? parsedRouteRecommendation.value : undefined,
    },
    firstSeenAt: updatedAt,
    lastUpdatedAt: updatedAt,
  };
}

function findDirectionEntry(directionCard: CommunityBoardIssueLike['directionCard']): Record<string, unknown> | null {
  const entries = directionCard?.entries;
  if (!Array.isArray(entries)) return null;
  const validEntries = entries.filter(isRecord);
  return validEntries.find((entry) => entry.authoredByRole === 'narrator') ?? validEntries[0] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function buildFindingItem(
  repo: string,
  subject: { type: 'issue' | 'pr'; repo: string; number: number },
  finding: ReconciliationFindingLike,
): CommunityDecisionQueueItem {
  const kind = findingKindToQueueKind(finding.findingKind);
  return {
    id: `decision:${kind}:${finding.subjectKey}:${finding.findingId}`,
    repo,
    subjectKey: finding.subjectKey,
    subjectType: subject.type,
    number: subject.number,
    kind,
    priority: findingPriority(finding),
    actor: findingActor(kind),
    status: 'open',
    title: `${subject.type === 'issue' ? 'Issue' : 'PR'} #${subject.number}: ${finding.findingKind}`,
    ask: findingAsk(kind, subject),
    why: finding.message,
    recommendedActions: [
      {
        kind: 'acknowledge-finding',
        label: 'Acknowledge',
        endpoint: `/api/community-findings/${encodeURIComponent(finding.findingId)}/acknowledge`,
        method: 'POST',
      },
      {
        kind: 'resolve-finding',
        label: 'Resolve',
        endpoint: `/api/community-findings/${encodeURIComponent(finding.findingId)}/resolve`,
        method: 'POST',
      },
      {
        kind: 'waive-finding',
        label: 'Waive',
        endpoint: `/api/community-findings/${encodeURIComponent(finding.findingId)}/waive`,
        method: 'POST',
        requiresAuditForm: true,
      },
    ],
    evidenceRefs: [
      {
        label: finding.evidenceFingerprint ? `Evidence ${finding.evidenceFingerprint}` : finding.findingKind,
        source: 'reconciler-finding',
        text: finding.message,
      },
    ],
    source: { findingId: finding.findingId },
    firstSeenAt: finding.createdAt,
    lastUpdatedAt: finding.updatedAt,
  };
}

function findingKindToQueueKind(findingKind: string): CommunityDecisionQueueKind {
  if (SLA_DEAD_LETTER_FINDINGS.has(findingKind)) return 'sla-dead-letter';
  if (EXTERNAL_FOLLOWUP_FINDINGS.has(findingKind)) return 'external-followup';
  return 'reconciliation-finding';
}

function findingPriority(finding: ReconciliationFindingLike): CommunityDecisionPriority {
  if (finding.status === 'acknowledged') return 'low';
  if (URGENT_FINDINGS.has(finding.findingKind)) return 'urgent';
  if (EXTERNAL_FOLLOWUP_FINDINGS.has(finding.findingKind)) return 'normal';
  return 'high';
}

function findingActor(kind: CommunityDecisionQueueKind): CommunityDecisionActor {
  if (kind === 'external-followup') return 'case-owner';
  if (kind === 'sla-dead-letter') return 'case-owner';
  return 'case-owner';
}

function findingAsk(kind: CommunityDecisionQueueKind, subject: { type: 'issue' | 'pr'; number: number }): string {
  const label = `${subject.type === 'issue' ? 'issue' : 'PR'} #${subject.number}`;
  if (kind === 'external-followup') return `Follow up on ${label} or update waiting status.`;
  if (kind === 'sla-dead-letter') return `Resolve the stale closure task for ${label}.`;
  return `Review and resolve the reconciliation finding for ${label}.`;
}

function isActionableFindingStatus(status: string): boolean {
  return status === 'open' || status === 'acknowledged';
}

function coalesceBySubject(items: readonly CommunityDecisionQueueItem[]): CommunityDecisionQueueItem[] {
  const bySubject = new Map<string, CommunityDecisionQueueItem>();
  for (const item of items) {
    const key = coalescingKey(item);
    const existing = bySubject.get(key);
    if (!existing || compareQueueItems(item, existing) < 0) {
      bySubject.set(key, item);
    }
  }
  return [...bySubject.values()];
}

function coalescingKey(item: CommunityDecisionQueueItem): string {
  const actionSignature = item.recommendedActions.map((action) => action.kind).join('|');
  return `${item.subjectKey}:${item.actor}:${actionSignature}`;
}

function compareQueueItems(a: CommunityDecisionQueueItem, b: CommunityDecisionQueueItem): number {
  const priority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (priority !== 0) return priority;
  const actor = ACTOR_RANK[a.actor] - ACTOR_RANK[b.actor];
  if (actor !== 0) return actor;
  const recency = b.lastUpdatedAt - a.lastUpdatedAt;
  if (recency !== 0) return recency;
  return a.id.localeCompare(b.id);
}

function parseSubjectKey(subjectKey: string): { type: 'issue' | 'pr'; repo: string; number: number } | null {
  const match = /^(issue|pr):(.+)#(\d+)$/.exec(subjectKey);
  if (!match) return null;
  return {
    type: match[1] as 'issue' | 'pr',
    repo: match[2]!,
    number: Number(match[3]),
  };
}

function textField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
