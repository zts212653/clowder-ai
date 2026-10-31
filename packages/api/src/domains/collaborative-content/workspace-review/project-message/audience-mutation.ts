import type { WorkspaceContentReview, WorkspaceContentReviewView } from '@cat-cafe/shared';
import type { VideoProjectPrincipal } from '../../../video-studio/project/access.js';
import type { VideoProjectReadPort } from '../../../video-studio/project/types.js';
import { WorkspaceContentReviewError } from '../errors.js';
import type { WorkspaceContentReviewStore, WorkspaceReviewMutation, WorkspaceReviewMutationResult } from '../store.js';
import { validateWorkspaceReviewId } from '../workspace-review-anchors.js';
import { ProjectAudienceConflict, projectAudienceKey, visibleProjectReview } from './audience.js';

export interface ProjectReviewMutationInput {
  principal: VideoProjectPrincipal;
  reviewId: string;
  expectedRevision: number;
  operationId: string;
}

/** Pin the original scoped request and its receipt within the same canonical SQLite operation. */
export function projectAudienceMutation(
  store: WorkspaceContentReviewStore,
  input: ProjectReviewMutationInput,
  kind: string,
  request: unknown,
  review: WorkspaceContentReview,
  view: WorkspaceContentReviewView,
  now: string,
) {
  const audience = projectAudienceKey(input.principal);
  const visible = new Map(view.review.annotations.map((annotation) => [annotation.id, annotation]));
  return {
    reviewId: input.reviewId,
    expectedRevision: review.revision,
    audienceRevision: view.review.revision,
    view,
    fingerprintRevision: input.expectedRevision,
    operationId: validateWorkspaceReviewId(input.operationId),
    actor: input.principal.actor,
    now,
    kind,
    request,
    assertScopedRevision: () => {
      if (input.principal.actor.kind === 'cat')
        store.projectAudiences.assertRevision(review.reviewId, audience, input.expectedRevision);
    },
    committed: (result: WorkspaceReviewMutationResult) => {
      if (input.principal.actor.kind !== 'cat') return;
      const annotations = result.review.annotations.flatMap((annotation) => {
        const prior = visible.get(annotation.id);
        if (annotation.projectMessage && !prior) return [];
        return [
          {
            ...annotation,
            ...(annotation.projectMessage && prior?.projectMessage
              ? {
                  projectMessage: { ...annotation.projectMessage, sourceState: prior.projectMessage.sourceState },
                }
              : {}),
          },
        ];
      });
      const projected = visibleProjectReview(result.review, annotations, view.review.source, view.review.createdAt);
      const scoped = store.projectAudiences.observe(result.review, projected, audience);
      store.projectAudiences.receipt(result.receipt, audience, scoped.revision);
    },
  } satisfies WorkspaceReviewMutation & { audienceRevision: number; view: WorkspaceContentReviewView };
}

/** Authority can narrow during awaited result/owner reads without changing the canonical ledger. */
export async function assertProjectAudienceCurrent(
  input: { principal: VideoProjectPrincipal; expectedRevision: number; annotationId?: string },
  read: () => Promise<WorkspaceContentReviewView>,
  projects: Pick<VideoProjectReadPort, 'authorize'>,
) {
  const current = await read();
  if (input.principal.actor.kind === 'cat') {
    if (input.annotationId && !current.review.annotations.some((annotation) => annotation.id === input.annotationId))
      throw new WorkspaceContentReviewError('access_denied');
    if (current.review.revision !== input.expectedRevision) throw new ProjectAudienceConflict();
  }
  if (!current.canReply) throw new WorkspaceContentReviewError('access_denied');
  // A view's capability was checked before awaited annotation confirmation. Check current grant last,
  // then the caller enters the synchronous canonical transaction without another owner/source await.
  await projects.authorize({ principal: input.principal, contentRef: current.review.contentRef, permission: 'write' });
}
