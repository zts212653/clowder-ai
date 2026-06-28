import type { RouteRecommendation } from '@cat-cafe/shared';

export type CommunityDecisionQueueKind =
  | 'direction-decision'
  | 'closure-action'
  | 'reconciliation-finding'
  | 'sla-dead-letter'
  | 'external-followup';

export type CommunityDecisionActor = 'cvo' | 'case-owner' | 'reconciler' | 'external-author';
export type CommunityDecisionPriority = 'urgent' | 'high' | 'normal' | 'low';
export type CommunityDecisionStatus = 'open' | 'blocked' | 'done';

export interface CommunityDecisionAction {
  readonly kind:
    | 'resolve-direction'
    | 'mark-reported'
    | 'waive-closure'
    | 'close-via-github'
    | 'acknowledge-finding'
    | 'resolve-finding'
    | 'waive-finding'
    | 'open-thread'
    | 'open-github';
  readonly label: string;
  readonly endpoint?: string;
  readonly threadId?: string;
  readonly method?: 'GET' | 'POST';
  readonly requiresAuditForm?: boolean;
}

export interface CommunityDecisionEvidenceRef {
  readonly label: string;
  readonly source: 'projection' | 'direction-card' | 'closure-checklist' | 'reconciler-finding' | 'github' | 'thread';
  readonly href?: string;
  readonly text?: string;
}

export interface CommunityDecisionQueueItemModel {
  readonly id: string;
  readonly repo: string;
  readonly subjectKey: string;
  readonly subjectType: 'issue' | 'pr';
  readonly number: number;
  readonly kind: CommunityDecisionQueueKind;
  readonly priority: CommunityDecisionPriority;
  readonly actor: CommunityDecisionActor;
  readonly status: CommunityDecisionStatus;
  readonly title: string;
  readonly ask: string;
  readonly why: string;
  readonly recommendedActions: readonly CommunityDecisionAction[];
  readonly evidenceRefs: readonly CommunityDecisionEvidenceRef[];
  readonly source: {
    readonly projectionState?: string;
    readonly nextOwner?: string;
    readonly assignedThreadId?: string | null;
    readonly assignedCatId?: string | null;
    readonly catId?: string;
    readonly directionCardEntryId?: string;
    readonly routeRecommendation?: RouteRecommendation;
    readonly findingId?: string;
    readonly closureBlocker?: string;
  };
  readonly firstSeenAt: number;
  readonly lastUpdatedAt: number;
}
