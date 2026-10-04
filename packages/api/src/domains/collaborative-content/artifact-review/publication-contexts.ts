import { catRegistry, type PublicationReviewContext } from '@cat-cafe/shared';
import type { IThreadStore } from '../../cats/services/stores/ports/ThreadStore.js';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import type { PublishedMediaService } from '../../video-studio/content-owner/published-media-service.js';
import { WorkspaceContentReviewError } from '../workspace-review/errors.js';
import type { PublicationReviewTarget } from '../workspace-review/publication-review-source.js';
import type { WorkspaceReviewPrincipal } from '../workspace-review/service.js';
import { ArtifactReviewError } from './errors.js';
import type { ArtifactReviewService } from './service.js';
import type { ArtifactReviewStore } from './store.js';

export async function readPublicationReviewContexts(
  deps: {
    store: ArtifactReviewStore;
    reviews: ArtifactReviewService;
    media: PublishedMediaService;
    threads: Pick<IThreadStore, 'get'>;
  },
  target: PublicationReviewTarget,
  input: WorkspaceReviewPrincipal,
): Promise<PublicationReviewContext[]> {
  if (input.actor.kind !== 'human' || input.actor.actorId !== input.userId) throw new MediaOwnerError('access_denied');
  const principal: MediaReviewPrincipal = { userId: input.userId, actor: input.actor };
  await deps.media.read(target.contentRef, target.ownerRevision, principal);
  const contexts: PublicationReviewContext[] = [];
  let missingVersion = false;
  for (const candidate of deps.store.directory.forPublication(principal.userId, target.contentRef)) {
    try {
      const view = await deps.reviews.readCurrent(candidate.reviewId, principal);
      const round = view.review.rounds.find((round) => round.asset.ownerRevision === target.ownerRevision);
      if (!round) {
        missingVersion = true;
        continue;
      }
      const task = await deps.media.access.authorize(view.review.task.taskId, principal, { allowClosed: true });
      const thread = await deps.threads.get(task.threadId);
      if (!thread || thread.deletedAt) continue;
      contexts.push({
        reviewId: view.review.reviewId,
        round: round.number,
        taskId: task.id,
        threadId: task.threadId,
        title: view.review.title,
        taskTitle: task.title,
        threadTitle: thread.title || '未命名对话',
        targetCatId: task.ownerCatId ?? null,
        targetName: task.ownerCatId
          ? (catRegistry.tryGet(task.ownerCatId)?.config.displayName ?? task.ownerCatId)
          : '原负责人不可用',
        state: round.state,
        taskState: task.status === 'done' || task.entrustedWork?.closure.state !== 'open' ? 'closed' : 'active',
        ...(round.ledgerRef ? { ledgerRef: round.ledgerRef } : {}),
      });
    } catch (error) {
      if (
        (error instanceof MediaOwnerError || error instanceof ArtifactReviewError) &&
        ['access_denied', 'not_found'].includes(error.code)
      )
        continue;
      throw error;
    }
  }
  // A sibling Task need not contain this version. With no exact context, preserve the existing admission fence.
  if (!contexts.length && missingVersion) throw new WorkspaceContentReviewError('version_pending');
  return contexts;
}
