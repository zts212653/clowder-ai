import type { ThreadArtifactDTO, WorkVideoContext } from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { WorkReadResult } from './types.js';

/** Presentation only: the catalogue and a source-proven file landing name the same owner version. */
export function workCardArtifact(item: WorkReadResult, production?: WorkVideoContext['production']): ThreadArtifactDTO {
  const createdAt = Date.parse(item.revision.committedAt);
  if (!Number.isFinite(createdAt)) throw new MediaOwnerError('media_unavailable');
  return {
    type: item.description.mediaType === 'video/mp4' ? 'video' : 'file',
    name: item.version.title,
    catId: item.revision.committedBy.kind === 'cat' ? item.revision.committedBy.actorId : null,
    createdAt,
    sourceMessageId: null,
    ref: item.reference.contentRef,
    url: `/api/content-publications/${encodeURIComponent(item.reference.contentRef)}/media/${item.reference.ownerRevision}`,
    work: {
      ...item.reference,
      currentOwnerRevision: item.currentOwnerRevision,
      ...(production
        ? { versionCreatedAt: Date.parse(production.createdAt), versionTimeSource: production.sourceRef }
        : {}),
    },
  };
}
