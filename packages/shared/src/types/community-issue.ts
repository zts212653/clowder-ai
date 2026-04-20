/**
 * Community Issue Types (F168 — 社区事务编排引擎)
 * Repo-agnostic issue/PR board for community operations.
 */

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
  readonly lastActivity: { readonly at: number; readonly event: string };
  readonly createdAt: number;
  readonly updatedAt: number;
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

export interface TriageEntry {
  readonly catId: string;
  readonly verdict: Verdict;
  readonly questions: readonly QuestionResult[];
  readonly reasonCode?: string;
  readonly relatedFeature?: string;
  readonly timestamp: number;
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
  readonly lastActivity?: { readonly at: number; readonly event: string };
}
