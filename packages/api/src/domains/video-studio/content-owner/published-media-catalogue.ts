import type { ReviewedMediaAsset } from '@cat-cafe/shared';
import { MediaOwnerError } from './media-errors.js';
import type { MediaReviewPrincipal } from './published-media-access.js';
import type { PublishedMediaService } from './published-media-service.js';
import type { ProjectContentOwnerService } from './service.js';

/** An authorized discovery projection; owner revisions and source scope remain authoritative. */
export async function listRetainedPublishedMedia(
  owner: ProjectContentOwnerService,
  media: Pick<PublishedMediaService, 'read'>,
  principal: MediaReviewPrincipal,
  after?: string,
) {
  if (principal.actor.kind !== 'human' || principal.actor.actorId !== principal.userId)
    throw new MediaOwnerError('access_denied');
  const page = await owner.listRetainedMedia(principal.userId, after);
  const items: { contentRef: string; ownerRevision: number; label: string; mediaType: 'image/png' | 'video/mp4' }[] =
    [];
  for (const candidate of page.items) {
    try {
      const asset = await media.read(candidate.contentRef, candidate.ownerRevision, principal);
      if (asset.mediaType !== 'image/png' && asset.mediaType !== 'video/mp4') continue;
      const label = retainedLabel(asset);
      items.push({ ...candidate, label, mediaType: asset.mediaType });
    } catch (error) {
      if (
        error instanceof MediaOwnerError &&
        ['access_denied', 'not_found', 'publication_changed'].includes(error.code)
      )
        continue;
      throw error;
    }
  }
  return { items, ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) };
}

function retainedLabel(asset: ReviewedMediaAsset): string {
  return asset.sourcePublication.artifactRef.split('/').at(-1) || (asset.mediaType === 'image/png' ? '图片' : '视频');
}
