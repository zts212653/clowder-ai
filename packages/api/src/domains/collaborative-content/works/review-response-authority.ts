import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import { withContentTask } from '../../video-studio/content-owner/published-media-access.js';
import type { PublishedMediaService } from '../../video-studio/content-owner/published-media-service.js';
import { ArtifactReviewError } from '../artifact-review/errors.js';
import { currentReviewModification } from '../artifact-review/modification-request-reference.js';
import { isLineageLinked } from '../artifact-review/review-authority.js';
import type { ArtifactReviewStore } from '../artifact-review/store.js';
import { assertModificationSourceAuthority } from '../modification/request-authority.js';
import { workMediaPrincipal } from './access.js';
import type { WorkResponseAuthorityInput } from './review-response.js';

/** Work write permission supplements, and never replaces, the original review/Task/source authority. */
export function createWorkResponseAuthority(deps: {
  store: ArtifactReviewStore;
  media: PublishedMediaService;
  messages: Pick<IMessageStore, 'getById'>;
}) {
  return async ({ review, principal, permission, response }: WorkResponseAuthorityInput) => {
    const viewer = withContentTask(workMediaPrincipal(principal), review.task.taskId);
    const task = await deps.media.access.authorize(review.task.taskId, viewer, {
      allowClosed: permission === 'read',
      ...(permission === 'respond' ? { expectedRevision: response?.expectedTaskRevision } : {}),
    });
    for (const round of review.rounds)
      await deps.media.assertTaskAsset(
        round.asset,
        {
          ownerUserId: review.task.ownerUserId,
          threadId: review.task.threadId,
          taskId: review.task.taskId,
        },
        viewer,
      );
    if (permission === 'read') return;
    if (principal.actor.kind !== 'cat' || task.ownerCatId !== principal.actor.actorId || !isLineageLinked(task, review))
      throw new ArtifactReviewError('owner_required');
    const request = currentReviewModification(deps.store, review, response?.sourceRound);
    if (request) {
      await assertModificationSourceAuthority(deps.messages, request);
      // Native production returns use their own exact caller + source selector, not Workspace Work submission.
      if (deps.store.returns.publicationForRequest(request.requestId)) throw new MediaOwnerError('access_denied');
    }
  };
}
