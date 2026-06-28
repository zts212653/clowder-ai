/**
 * Community Issue Types (F168 — 社区事务编排引擎)
 * Repo-agnostic issue/PR board for community operations.
 */

// F168 Phase C: imported for narrator TriageEntry extension (authoredByRole, recommendedOwnerRole).
// The circular-import risk is absent: community-role.ts has no dependency on community-issue.ts.
import type { CommunityRole } from './community-role.js';

export type IssueState = 'unreplied' | 'discussing' | 'pending-decision' | 'accepted' | 'declined' | 'closed';
export type IssueType = 'bug' | 'feature' | 'enhancement' | 'question';
export type ReplyState = 'unreplied' | 'replied';
export type ConsensusState = 'discussing' | 'consensus-reached' | 'stalled';
export type PrBoardGroup = 'in-review' | 're-review-needed' | 'has-conflict' | 'completed';

export interface CommunityIssueItem {
  readonly id: string;
  readonly repo: string;
  readonly issueNumber: number;
  readonly issueType: IssueType;
  readonly title: string;
  readonly state: IssueState;
  readonly replyState: ReplyState;
  readonly consensusState?: ConsensusState;
  readonly assignedThreadId: string | null;
  readonly assignedCatId: string | null;
  readonly linkedPrNumbers: readonly number[];
  readonly directionCard: Record<string, unknown> | null;
  readonly ownerDecision: 'accepted' | 'declined' | null;
  readonly relatedFeature: string | null;
  readonly guardianAssignment: GuardianAssignment | null;
  readonly lastActivity: { readonly at: number; readonly event: string };
  readonly createdAt: number;
  readonly updatedAt: number;
  // Phase F: route validation + source tracking (SO-2)
  readonly routeAcceptance?: RouteAcceptance | null;
  readonly routeSource?: RouteSource | null;
}

export interface CreateCommunityIssueInput {
  readonly repo: string;
  readonly issueNumber: number;
  readonly issueType: IssueType;
  readonly title: string;
}

// Phase A: Triage types for Direction Card orchestration
export type Verdict = 'WELCOME' | 'NEEDS-DISCUSSION' | 'POLITELY-DECLINE';
export type QuestionId = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
export type QuestionGrade = 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN';

export interface QuestionResult {
  readonly id: QuestionId;
  readonly result: QuestionGrade;
}

/** Narrator routeRecommendation — discriminated union (Phase C §0 terminal schema). */
export type RouteRecommendation =
  | { readonly kind: 'existing-thread'; readonly threadId: string }
  | { readonly kind: 'new-thread' }
  | { readonly kind: 'decline' };

// ---------------------------------------------------------------------------
// D0.5: Shared routeRecommendation parser (canonical validator for API + web)
// ---------------------------------------------------------------------------

export type ParseRouteRecommendationResult = { ok: true; value: RouteRecommendation } | { ok: false; reason: string };

const VALID_RR_KINDS = new Set(['existing-thread', 'new-thread', 'decline']);

/**
 * Parse and validate an unknown value as a RouteRecommendation.
 *
 * Strips unknown properties — only the canonical shape passes through.
 * Returns `{ ok: false }` for any malformed input (never throws).
 */
export function parseRouteRecommendation(input: unknown): ParseRouteRecommendationResult {
  if (input === null || input === undefined || typeof input !== 'object') {
    return { ok: false, reason: 'input must be a non-null object' };
  }

  const obj = input as Record<string, unknown>;
  const kind = obj.kind;

  if (typeof kind !== 'string' || !VALID_RR_KINDS.has(kind)) {
    return { ok: false, reason: `invalid kind: ${JSON.stringify(kind)}` };
  }

  switch (kind) {
    case 'existing-thread': {
      const threadId = obj.threadId;
      if (typeof threadId !== 'string' || threadId.length === 0) {
        return { ok: false, reason: 'existing-thread requires a non-empty threadId' };
      }
      return { ok: true, value: { kind: 'existing-thread', threadId } };
    }
    case 'new-thread':
      return { ok: true, value: { kind: 'new-thread' } };
    case 'decline':
      return { ok: true, value: { kind: 'decline' } };
    default:
      return { ok: false, reason: `unrecognized kind: ${kind}` };
  }
}

export interface TriageEntry {
  readonly catId: string;
  readonly verdict: Verdict;
  readonly questions: readonly QuestionResult[];
  readonly reasonCode?: string;
  readonly relatedFeature?: string;
  readonly timestamp: number;
  // F168 Phase C — narrator extension fields (all optional; INV-12: old entries remain valid)
  /** Marks a machine-generated entry from the narrator role vs. a human triage entry. */
  readonly authoredByRole?: CommunityRole;
  /** One-sentence "what is this issue about" in plain language produced by the narrator. */
  readonly narrative?: string;
  /** Evidence references gathered by narrator (linked feat/PR/issue anchors). */
  readonly evidenceRefs?: readonly string[];
  /** Narrator's route recommendation — one of the three outcome kinds. */
  readonly routeRecommendation?: RouteRecommendation;
  /** Which community role the narrator recommends should own this case (default: case-owner). */
  readonly recommendedOwnerRole?: CommunityRole;
}

export interface ConsensusResult {
  readonly verdict: Verdict;
  readonly needsOwner: boolean;
  readonly reasonCode?: string;
  readonly resolvedAt: number;
}

export interface DirectionCardPayload {
  readonly entries: readonly TriageEntry[];
  readonly consensus?: ConsensusResult;
}

// Phase D: Intake Guardian types
export interface IntakeChecklistItem {
  readonly id: string;
  readonly label: string;
  readonly required: boolean;
  readonly evidence?: string;
  readonly verifiedAt?: number;
  readonly verifiedBy?: string;
}

export interface GuardianAssignment {
  readonly guardianCatId: string;
  readonly signoffTokenHash: string;
  readonly requestedAt: number;
  readonly requestedBy: string;
  readonly signedOff: boolean;
  readonly signedOffAt?: number;
  readonly approved?: boolean;
  readonly reason?: string;
  readonly checklist: readonly IntakeChecklistItem[];
}

export const DEFAULT_INTAKE_CHECKLIST: readonly Omit<IntakeChecklistItem, 'evidence' | 'verifiedAt' | 'verifiedBy'>[] =
  [
    { id: 'vision-alignment', label: '愿景对齐：交付物解决了co-creator的原始需求', required: true },
    { id: 'test-coverage', label: '测试覆盖：新增行为有对应测试', required: true },
    { id: 'doc-sync', label: '文档同步：spec/plan/BACKLOG 已更新', required: true },
    { id: 'no-regression', label: '无回归：现有测试全绿', required: true },
    { id: 'design-fidelity', label: '设计一致：UI 与设计稿一致（如适用）', required: false },
  ];

export function validateIntakeChecklist(checklist: readonly IntakeChecklistItem[]): {
  valid: boolean;
  missing: readonly string[];
} {
  const missing = DEFAULT_INTAKE_CHECKLIST.filter((item) => item.required)
    .filter((req) => {
      const found = checklist.find((c) => c.id === req.id);
      return !found?.evidence;
    })
    .map((item) => item.id);
  return { valid: missing.length === 0, missing };
}

export interface UpdateCommunityIssueInput {
  readonly state?: IssueState;
  readonly replyState?: ReplyState;
  readonly consensusState?: ConsensusState;
  readonly issueType?: IssueType;
  readonly title?: string;
  readonly assignedThreadId?: string | null;
  readonly assignedCatId?: string | null;
  readonly linkedPrNumbers?: readonly number[];
  readonly directionCard?: Record<string, unknown> | null;
  readonly ownerDecision?: 'accepted' | 'declined' | null;
  readonly relatedFeature?: string | null;
  readonly guardianAssignment?: GuardianAssignment | null;
  readonly lastActivity?: { readonly at: number; readonly event: string };
  // Phase F: route validation + source tracking
  readonly routeAcceptance?: RouteAcceptance | null;
  readonly routeSource?: RouteSource | null;
}

// ---------------------------------------------------------------------------
// Phase F: Route acceptance state + source tracking (SO-2, SO-3)
// ---------------------------------------------------------------------------

/** Target cat's validation state for a routed issue (SO-2 state machine). */
export type RouteAcceptance = 'pending' | 'accepted' | 'rejected';

/** How the route was established. */
export type RouteSource = 'auto' | 'manual' | 'backfill';

/** Triage confidence level — binary split per operator direction. */
export type TriageConfidence = 'high' | 'low';

// ---------------------------------------------------------------------------
// Phase F: Per-repo routing config (SO-0)
// ---------------------------------------------------------------------------

/** operator-defined per-repo guard assignment. Static config, not a state machine. */
export interface CommunityRepoConfig {
  readonly repo: string;
  readonly guardThreadId: string;
  readonly guardCatId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}

// ---------------------------------------------------------------------------
// Phase F: deriveTriageConfidence — pure function (INV-F1)
// ---------------------------------------------------------------------------

/**
 * Derive triage confidence from a TriageEntry.
 *
 * HIGH requires ALL of:
 *   1. routeRecommendation.kind === 'existing-thread' (knows where to go)
 *   2. verdict === 'WELCOME' (direction confirmed)
 *   3. All questions are PASS or WARN (no FAIL/UNKNOWN)
 *   4. questions array is non-empty
 *
 * Everything else → LOW.
 *
 * INV-F1: Pure function — no side effects, no store reads.
 */
export function deriveTriageConfidence(
  entry: Pick<TriageEntry, 'verdict' | 'questions' | 'routeRecommendation'>,
): TriageConfidence {
  // Must have an existing-thread route recommendation
  if (!entry.routeRecommendation || entry.routeRecommendation.kind !== 'existing-thread') {
    return 'low';
  }

  // Must be WELCOME verdict
  if (entry.verdict !== 'WELCOME') {
    return 'low';
  }

  // Questions must exist and be non-empty
  const questions = entry.questions;
  if (!questions || questions.length === 0) {
    return 'low';
  }

  // All questions must be PASS or WARN
  const allAcceptable = questions.every((q) => q.result === 'PASS' || q.result === 'WARN');
  if (!allAcceptable) {
    return 'low';
  }

  return 'high';
}
