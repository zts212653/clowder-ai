import {
  maxWorkspaceContentSourceHistory,
  type WorkspaceContentReview,
  type WorkspaceContentSource,
} from '@cat-cafe/shared';
import type { WorkspaceReviewPrincipal } from './service.js';
import type { WorkspaceReviewMutation } from './store.js';
import { validateWorkspaceReviewId } from './workspace-review-anchors.js';

export function createWorkspaceReviewMutation(
  input: {
    reviewId: string;
    expectedRevision: number;
    operationId: string;
    principal: WorkspaceReviewPrincipal;
    body?: unknown;
    target?: unknown;
  },
  kind: 'annotate' | 'refresh',
  now: string,
): WorkspaceReviewMutation {
  return {
    reviewId: input.reviewId,
    expectedRevision: input.expectedRevision,
    operationId: validateWorkspaceReviewId(input.operationId),
    actor: input.principal.actor,
    now,
    kind,
    request: kind === 'annotate' ? { body: input.body, target: input.target } : {},
  };
}

/** Keep immutable metadata reachable for old annotations without retaining content bytes. */
export function appendWorkspaceSourceHistory(
  review: WorkspaceContentReview,
  source: WorkspaceContentSource,
): WorkspaceContentSource[] {
  const byRevision = new Map<string, WorkspaceContentSource>();
  for (const snapshot of [...(review.sourceHistory ?? [review.source]), source])
    byRevision.set(snapshot.revision, snapshot);
  const protectedRevisions = new Set([
    source.revision,
    ...review.annotations.map((annotation) => annotation.anchor.baseRevision),
    ...(review.visualMarks ?? []).map((mark) => mark.baseRevision),
  ]);
  const unique = [...byRevision.values()];
  while (unique.length > maxWorkspaceContentSourceHistory) {
    const removable = unique.findIndex((snapshot) => !protectedRevisions.has(snapshot.revision));
    if (removable < 0)
      throw new Error('Workspace source-history capacity cannot retain every protected source revision');
    unique.splice(removable, 1);
  }
  return unique;
}
