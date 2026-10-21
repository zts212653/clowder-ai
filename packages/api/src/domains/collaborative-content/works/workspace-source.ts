import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import type { WorkspaceContentSourceService } from '../../workspace/workspace-content-source.js';
import type { WorkSourcePort } from './service.js';

/** No raw paths: F063 canonicalizes registered-root locators and owns the immutable snapshot. */
export function createWorkWorkspaceSource(source: WorkspaceContentSourceService): WorkSourcePort {
  return {
    async inspect(input) {
      const description = await source.describe({
        locator: input.locator,
        principal: { userId: input.principal.userId },
      });
      if (description.mime !== 'video/mp4') throw new MediaOwnerError('invalid_media');
      const frozen = await source.openMedia({
        locator: description.locator,
        principal: { userId: input.principal.userId },
        expectedRevision: description.revision,
      });
      try {
        return {
          source: { ...description.locator, expectedSourceRevision: description.revision },
          mediaType: description.mime,
          byteLength: description.byteLength,
          media: frozen.media,
        };
      } finally {
        frozen.stream.destroy();
      }
    },
    async open(input) {
      const locator = { worktreeId: input.source.worktreeId, path: input.source.path };
      const request = { principal: { userId: input.principal.userId }, locator };
      const description = await source.describe(request);
      if (description.revision !== input.source.expectedSourceRevision)
        throw new MediaOwnerError('publication_changed');
      if (description.mime !== 'video/mp4') throw new MediaOwnerError('invalid_media');
      const opened = await source.openMedia({ ...request, expectedRevision: input.source.expectedSourceRevision });
      return {
        mediaType: 'video/mp4',
        media: opened.media,
        stream: opened.stream,
        byteLength: opened.byteLength,
        blobDigest: opened.revision,
        publication: {
          artifactRef: description.contentRef,
          sourceRef: `workspace:${encodeURIComponent(description.locator.worktreeId)}:${encodeURIComponent(description.locator.path)}`,
          revision: description.revision,
        },
        revalidate: async () => {
          const current = await source.describe(request);
          if (current.contentRef !== description.contentRef || current.revision !== description.revision)
            throw new MediaOwnerError('publication_changed');
        },
      };
    },
  };
}
