import type { OpenWorkspaceMediaV1 } from '../../workspace/workspace-content-source.js';
import { MediaOwnerError } from './media-errors.js';
import { publishedMediaContentRef, samePublicationScope } from './publication.js';
import type { MediaReviewPrincipal, PublishedMediaAccess } from './published-media-access.js';
import type { PublishedMediaSource } from './published-media-source.js';
import { ContentOwnerConflictError, type ProjectContentOwnerService } from './service.js';
import type { ContentPublicationScopeV1, ContentSourcePublicationV1 } from './types.js';

/** Byte-transport adapter for the existing explicit publication entry; no new work identity or ACL. */
export async function retainPublishedVideo(
  deps: {
    owner: ProjectContentOwnerService;
    sources: PublishedMediaSource;
    access: PublishedMediaAccess;
  },
  input: {
    opened: OpenWorkspaceMediaV1;
    scope: ContentPublicationScopeV1;
    publication: ContentSourcePublicationV1;
    operationId: string;
    principal: MediaReviewPrincipal;
  },
) {
  const { opened, scope, publication, principal } = input;
  const contentRef = publishedMediaContentRef(scope, publication);
  try {
    if (opened.mime !== 'video/mp4' || opened.media.kind !== 'video' || opened.revision !== publication.revision)
      throw new MediaOwnerError('publication_changed');
    try {
      await deps.owner.importStream({
        contentRef,
        operationId: input.operationId,
        actor: principal.actor,
        stream: opened.stream,
        byteLength: opened.byteLength,
        blobDigest: opened.revision,
        mediaType: 'video/mp4',
        publicationScope: scope,
        sourcePublication: publication,
        authorizeEffect: async () => {
          await deps.sources.assertVisible(scope, publication, principal);
          await deps.access.authorizeScope(scope, principal);
        },
      });
    } catch (error) {
      if (!(error instanceof ContentOwnerConflictError)) throw error;
      const original = await deps.owner.describe(contentRef, 1);
      if (original.blobDigest !== opened.revision || !samePublicationScope(original.publicationScope, scope))
        throw new MediaOwnerError('publication_changed');
    }
    return { contentRef, blobDigest: opened.revision, media: opened.media };
  } finally {
    opened.stream.destroy();
  }
}
