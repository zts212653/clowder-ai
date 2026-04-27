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
  readonly guardianAssignment: GuardianAssignment | null;
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
    { id: 'vision-alignment', label: '愿景对齐：交付物解决了铲屎官的原始需求', required: true },
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
}
