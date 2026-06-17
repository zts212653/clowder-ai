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
  // Eval events (INV-13: narrator recommendation vs owner decision)
  | 'case.route_decision_eval'
  // Migration synthetic event
  | 'case.bootstrap';

// ---------------------------------------------------------------------------
// GitHub author association (generic GitHub semantics — no brand coupling)
// ---------------------------------------------------------------------------

/**
 * GitHub-native author_association values.
 * Used by the delivery policy to distinguish maintainer vs external activity
 * without coupling the engine to any specific repo identity.
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
