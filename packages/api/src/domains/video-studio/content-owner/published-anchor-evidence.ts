import type { ArtifactReviewAnchor } from '@cat-cafe/shared';
import { MediaOwnerError } from './media-errors.js';
import type { MediaReviewPrincipal } from './published-media-access.js';
import type { PublishedMediaService } from './published-media-service.js';

export type PublishedAnchorEvidenceVerifier = (
  reference: { contentRef: string; ownerRevision: number },
  anchor: ArtifactReviewAnchor,
  principal: MediaReviewPrincipal,
) => Promise<void>;

/** Immutable media admission fences a metadata-owner callback; it owns no second annotation store. */
export async function verifyPublishedAnchorEvidence(
  media: Pick<PublishedMediaService, 'read'>,
  reference: { contentRef: string; ownerRevision: number },
  anchor: ArtifactReviewAnchor,
  principal: MediaReviewPrincipal,
  verify?: PublishedAnchorEvidenceVerifier,
) {
  if (anchor.kind !== 'video-range' || !anchor.storyEvidence) return;
  const version = { contentRef: reference.contentRef, ownerRevision: reference.ownerRevision };
  await media.read(version.contentRef, version.ownerRevision, principal);
  if (!verify) throw new MediaOwnerError('invalid_media');
  await verify(version, anchor, principal);
  await media.read(version.contentRef, version.ownerRevision, principal);
}
