import type { ContentModificationRequest } from '@cat-cafe/shared';
import type { MediaReviewPrincipal } from '../../video-studio/content-owner/published-media-access.js';
import { ArtifactReviewError } from '../artifact-review/errors.js';
import type { ArtifactReviewService } from '../artifact-review/service.js';
import type { ArtifactReviewStore } from '../artifact-review/store.js';
import { cancelledModificationReplacement } from './control/supersession.js';

/** An adapter to the original inline round, never a new ledger or a reinterpretation of a ledgerRef. */
export async function readLegacyModificationSource(
  reviews: ArtifactReviewService,
  source: Extract<ContentModificationRequest['source'], { kind: 'artifact-review' }>,
  principal: MediaReviewPrincipal,
) {
  const view = await reviews.readCurrent(source.reviewId, principal);
  const round = view.review.rounds.find((item) => item.number === source.round);
  if (!round || round.ledgerRef) throw new ArtifactReviewError('invalid_action');
  return { view, round };
}

export async function inspectLegacyModification(
  reviews: ArtifactReviewService,
  store: ArtifactReviewStore,
  payload: ContentModificationRequest,
  principal: MediaReviewPrincipal,
  resuming: boolean,
) {
  if (payload.source.kind !== 'artifact-review') throw new ArtifactReviewError('invalid_action');
  const result = await readLegacyModificationSource(reviews, payload.source, principal);
  const { view, round } = result;
  const context = payload.taskContext;
  if (
    !context ||
    context.kind === 'text' ||
    context.taskId !== view.review.task.taskId ||
    context.reviewId !== view.review.reviewId ||
    context.round !== round.number ||
    context.expectedReviewRevision !== payload.source.expectedReviewRevision ||
    payload.threadId !== view.review.task.threadId ||
    payload.targetCatId !== view.authority.ownerCatId
  )
    throw new ArtifactReviewError('task_changed');
  if (!resuming) {
    if (
      !view.authority.canWrite ||
      view.review.revision !== payload.source.expectedReviewRevision ||
      view.authority.taskRevision !== context.expectedTaskRevision ||
      round.number !== view.review.rounds.at(-1)?.number
    )
      throw new ArtifactReviewError('task_changed');
    if (
      !['draft', 'awaiting_human'].includes(round.state) &&
      !cancelledModificationReplacement(store, view.review, round.number)
    )
      throw new ArtifactReviewError('invalid_action');
  }
  return result;
}
