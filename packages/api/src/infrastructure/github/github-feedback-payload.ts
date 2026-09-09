import type { IssueComment } from '../email/IssueCommentRouter.js';
import type { PrFeedbackComment, PrReviewDecision } from '../email/ReviewFeedbackRouter.js';

export interface GitHubCommentPayload {
  readonly id: number;
  readonly body: string;
  readonly created_at: string;
  readonly user?: { readonly login?: string; readonly type?: string };
  readonly commit_id?: string;
  readonly path?: string;
  readonly line?: number;
  readonly pull_request_review_id?: number;
  readonly author_association?: string;
}

export interface GitHubReviewPayload {
  readonly id: number;
  readonly user?: { readonly login?: string; readonly type?: string };
  readonly state: string;
  readonly body: string;
  readonly submitted_at: string;
  readonly commit_id?: string;
  readonly author_association?: string;
}

function normalizeComment(payload: GitHubCommentPayload, commentType: PrFeedbackComment['commentType']) {
  return {
    id: payload.id,
    ...(payload.pull_request_review_id ? { reviewId: payload.pull_request_review_id } : {}),
    author: payload.user?.login ?? 'unknown',
    actorType: payload.user?.type,
    body: payload.body,
    createdAt: payload.created_at,
    ...(payload.commit_id ? { commitId: payload.commit_id } : {}),
    commentType,
    ...(payload.path ? { filePath: payload.path } : {}),
    ...(payload.line ? { line: payload.line } : {}),
    ...(payload.author_association !== undefined ? { authorAssociation: payload.author_association } : {}),
  } satisfies PrFeedbackComment;
}

export function normalizePrFeedbackComments(
  inline: readonly GitHubCommentPayload[],
  conversation: readonly GitHubCommentPayload[],
): PrFeedbackComment[] {
  return [
    ...inline.map((payload) => normalizeComment(payload, 'inline')),
    ...conversation.map((payload) => normalizeComment(payload, 'conversation')),
  ];
}

export function normalizePrReviewDecisions(payloads: readonly GitHubReviewPayload[]): PrReviewDecision[] {
  return payloads.map((payload) => ({
    id: payload.id,
    author: payload.user?.login ?? 'unknown',
    actorType: payload.user?.type,
    state: payload.state as PrReviewDecision['state'],
    body: payload.body,
    submittedAt: payload.submitted_at,
    ...(payload.commit_id ? { commitId: payload.commit_id } : {}),
    ...(payload.author_association !== undefined ? { authorAssociation: payload.author_association } : {}),
  }));
}

export function normalizeIssueComments(payloads: readonly GitHubCommentPayload[]): IssueComment[] {
  return payloads.map((payload) => ({
    id: payload.id,
    author: payload.user?.login ?? 'unknown',
    actorType: payload.user?.type,
    body: payload.body,
    createdAt: payload.created_at,
    ...(payload.author_association !== undefined ? { authorAssociation: payload.author_association } : {}),
  }));
}
