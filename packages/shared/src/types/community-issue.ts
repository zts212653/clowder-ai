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
