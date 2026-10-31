import type { ContentModificationRequest } from '@cat-cafe/shared';
import type { MediaReviewPrincipal } from '../../../video-studio/content-owner/published-media-access.js';
import type { PublishedMediaService } from '../../../video-studio/content-owner/published-media-service.js';
import { ArtifactReviewError } from '../../artifact-review/errors.js';
import type { ArtifactReviewService } from '../../artifact-review/service.js';

/** No task or ledger side effect precedes this exact-source citation check. */
export async function assertModificationStoryEvidence(
  deps: { reviews: ArtifactReviewService; media: PublishedMediaService },
  payload: ContentModificationRequest,
  principal: MediaReviewPrincipal,
) {
  const selections =
    payload.intent.selections?.map((item) => item.selection) ??
    (payload.intent.selection ? [payload.intent.selection] : []);
  const anchors = selections.flatMap((selection) =>
    selection.kind === 'video-range' && selection.storyEvidence ? [selection] : [],
  );
  if (!anchors.length) return;
  const source = payload.source;
  let reference: { contentRef: string; ownerRevision: number };
  if (source.kind === 'publication') reference = source;
  else if (source.kind === 'artifact-review') {
    const view = await deps.reviews.readCurrent(source.reviewId, principal);
    const round = view.review.rounds.find((item) => item.number === source.round);
    if (!round) throw new ArtifactReviewError('invalid_action');
    reference = round.asset;
  } else throw new ArtifactReviewError('invalid_action');
  for (const anchor of anchors) await deps.media.assertAnchorEvidence(reference, anchor, principal);
}
