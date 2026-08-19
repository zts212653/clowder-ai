/**
 * Community Ops Event Types (F168 Phase A)
 * Engine-agnostic: zero cat names, zero brand constants, zero repo hardcodes.
 *
 * True-up: Event Log is the single internal-canonical truth source for
 * community case state. CommunityObjectProjection is a rebuildable view.
 */

// ---------------------------------------------------------------------------
// Event kinds
// ---------------------------------------------------------------------------

/** All event kinds understood by the community-ops engine. */
export type CommunityEventKind =
  // External fact events (Phase A: core lifecycle)
  | 'issue.opened'
  | 'pr.opened'
  | 'pr.ready_for_review'
  | 'pr.merged'
  | 'pr.closed'
  | 'issue.closed'
  | 'issue.reopened'
  // External fact events (Phase B: activity signals)
  | 'issue.commented' // webhook issue_comment.created / polling IssueCommentTaskSpec
  | 'issue.labeled' // webhook issues.labeled | unlabeled (payload.label carries name)
  | 'pr.review_submitted' // webhook pull_request_review.submitted
  // Internal decision events
  | 'case.triaged'
  | 'case.routed'
  | 'case.reported'
  | 'case.waived'
  | 'case.declined'
  | 'case.awaiting_external' // owner declares waiting for external actor (payload: { reason, declaredBy })
  | 'case.fix_evidence_recorded'
  // External review lifecycle events (F168 Phase F-Step3)
  | 'case.external_review_assigned'
  | 'case.head_observed'
  | 'case.ci_observed'
  | 'case.cloud_review_observed'
  | 'case.review_ready'
  | 'case.reviewer_wake_delivered'
  | 'case.review_verdict_recorded'
  // Route validation events (F168 Phase F: target cat accepts/rejects routed issue)
  | 'case.route_validated'
  | 'case.route_rejected'
  // Eval events (INV-13: narrator recommendation vs owner decision)
  | 'case.route_decision_eval'
  // Migration synthetic event
  | 'case.bootstrap';

// ---------------------------------------------------------------------------
// GitHub author association (generic GitHub semantics — no brand coupling)
// ---------------------------------------------------------------------------

/**
 * GitHub-native author_association values.
 * Preserved as event context. Association is never sufficient to suppress
 * delivery because OWNER/MEMBER may be the external repository maintainers.
 */
export type GitHubAuthorAssociation =
  | 'OWNER'
  | 'MEMBER'
  | 'COLLABORATOR'
  | 'CONTRIBUTOR'
  | 'FIRST_TIME_CONTRIBUTOR'
  | 'FIRST_TIMER'
  | 'NONE';

/** Delivery priority / noise classification for fan-out. */
export type CommunityEventClassification = 'state-changing' | 'needs-human' | 'needs-owner' | 'informational' | 'stale';

// ---------------------------------------------------------------------------
// Core event record
// ---------------------------------------------------------------------------

export interface CommunityEvent {
  /**
   * Idempotency / dedup key.
   * - webhook: GitHub delivery ID
   * - scan-derived: `scan:{repo}:{number}:{kind}`
   * - manual dispatch: `manual:{uuid}`
   * - migration: `bootstrap:{subjectKey}`
   */
  sourceEventId: string;

  /**
   * Stable subject identifier.
   * Format: `issue:{owner}/{repo}#{n}` | `pr:{owner}/{repo}#{n}`
   */
  subjectKey: string;

  kind: CommunityEventKind;
  classification: CommunityEventClassification;
  payload: Record<string, unknown>;
  /** Unix timestamp (ms) */
  at: number;
}

// ---------------------------------------------------------------------------
// Projection state machine types
// ---------------------------------------------------------------------------

export type CommunityObjectState =
  | 'new'
  | 'triaged'
  | 'routed'
  | 'in_progress'
  | 'awaiting_external'
  | 'needs_info'
  | 'fixed'
  | 'reported'
  | 'closed'
  | 'declined';

/**
 * Who holds the next-action token.
 * Engine stores a role label; binding to an actual cat/team is deployment config.
 */
export type CommunityNextOwner = 'role' | 'external_author' | 'ci' | 'cvo' | 'none';

/** Proof-of-reported record required to skip the `fixed→reported→closed` invariant. */
export interface CommunityClosureWaiver {
  reason: string;
  /** Role label or external actor identifier — engine does NOT validate against roster. */
  actor: string;
  /** Link, commit SHA, or human-readable explanation. */
  evidence: string;
}

/** Structured proof required before an issue "fixed" claim becomes re-review ready. */
export type IssueFixEvidence =
  | {
      readonly kind: 'pull_request';
      readonly url: string;
      readonly number: number;
    }
  | {
      readonly kind: 'commit';
      readonly sha: string;
      readonly url?: string;
    }
  | {
      readonly kind: 'release';
      readonly tag: string;
      readonly url: string;
    }
  | {
      readonly kind: 'reproduction';
      readonly evidence: string;
    };

/** Exact, correlated reasons allowed to keep an issue comment state-only. */
export type IssueCommentSuppressionReason = 'exact_self_echo' | 'exact_setup_noise';

// ---------------------------------------------------------------------------
// F168 Phase F-Step3: external review aggregate
// ---------------------------------------------------------------------------

export type ExternalReviewMode = 'observe_only' | 'maintainer_review';

export type CloudReviewPolicy = 'optional' | 'required';

export type ExternalReviewLifecycle =
  | 'assigned'
  | 'awaiting_author'
  | 'awaiting_ci'
  | 'awaiting_cloud_review'
  | 'rereview_required'
  | 'pending_delivery'
  | 'delivered'
  | 'terminal';

export type ExternalCiStatus = 'pending' | 'pass' | 'fail';

export type ExternalCloudReviewStatus = 'not_requested' | 'running' | 'blocking' | 'clean' | 'failed_or_timeout';

export type ReviewDeliveryOutcome =
  | {
      readonly kind: 'delivered';
      readonly headSha: string;
      readonly githubUrl: string;
      readonly deliveredAt: number;
    }
  | {
      readonly kind: 'pending_delivery';
      readonly headSha: string;
      readonly ownerCatId: string;
      readonly reason: string;
      readonly createdAt: number;
    };

export interface ExternalReviewAggregate {
  readonly mode: ExternalReviewMode;
  readonly cloudPolicy: CloudReviewPolicy;
  readonly lifecycle: ExternalReviewLifecycle;
  readonly currentHeadSha: string | null;
  /** Monotonic lifecycle generation. The same SHA may reappear after a force-push/revert. */
  readonly headGeneration: number;
  readonly currentHeadObservedAt: number | null;
  readonly lastReviewedHeadSha: string | null;
  readonly lastReviewedHeadGeneration: number | null;
  readonly lastDeliveredHeadSha: string | null;
  readonly lastDeliveredHeadGeneration: number | null;
  readonly ci: {
    readonly headSha: string;
    readonly headGeneration: number;
    readonly status: ExternalCiStatus;
    readonly observedAt: number;
  } | null;
  readonly cloud: {
    readonly headSha: string;
    readonly headGeneration: number;
    readonly status: ExternalCloudReviewStatus;
    readonly triggerCommentId?: number;
    readonly reviewId?: number;
    readonly observedAt: number;
  } | null;
  readonly wake: {
    readonly headSha: string;
    readonly headGeneration: number;
    readonly status: 'pending' | 'delivered';
    readonly requestedAt: number;
    readonly messageId?: string;
    readonly deliveredAt?: number;
  } | null;
  readonly delivery: ReviewDeliveryOutcome | null;
  readonly reviewerCatId: string | null;
  readonly reviewerThreadId: string | null;
  readonly actionLeaseRef: {
    readonly leaseId: string;
    readonly generation: number;
  } | null;
}

// ---------------------------------------------------------------------------
// Projection (rebuildable read model)
// ---------------------------------------------------------------------------

export interface CommunityObjectProjection {
  repo: string;
  type: 'issue' | 'pr';
  number: number;
  subjectKey: string;
  state: CommunityObjectState;
  ownerThreadId: string | null;
  ownerRole: string | null;
  nextOwner: CommunityNextOwner;
  lastExternalActivityAt: number | null;
  lastPublicCommentAt: number | null;
  linkedIssues: number[];
  linkedPrs: number[];
  closureWaiver: CommunityClosureWaiver | null;
  /** Latest validated issue fix proof; prose-only claims never populate this field. */
  issueFixEvidence: IssueFixEvidence | null;
  /** F168 Phase F-Step3 external review lifecycle; absent for ordinary community objects. */
  externalReview: ExternalReviewAggregate | null;
  /**
   * Count of events consumed to build this projection.
   * Used for rebuild consistency verification.
   */
  appliedEventCount: number;
  /**
   * Last event that was rejected by the state machine (e.g. closure_invariant).
   * Stored for observability — does NOT change projection state.
   */
  lastRejectedEvent: CommunityEvent | null;
  /**
   * Phase B: delivery fan-out cursor (reserved, not used in Phase A).
   */
  deliveryCursor: number | null;
  createdAt: number;
  updatedAt: number;
}
