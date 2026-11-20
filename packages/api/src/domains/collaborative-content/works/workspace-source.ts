import { Readable } from 'node:stream';
import { MAX_HTML_WORK_BYTES } from '@cat-cafe/shared';
import { MediaOwnerError } from '../../video-studio/content-owner/media-errors.js';
import {
  type WorkspaceContentDescriptionV1,
  WorkspaceContentSourceError,
  type WorkspaceContentSourceService,
} from '../../workspace/workspace-content-source.js';
import type { OpenWorkSource, WorkPrincipal, WorkSourcePort } from './service.js';

/** No raw paths: F063 canonicalizes registered-root locators and owns the immutable snapshot. */
export function createWorkWorkspaceSource(source: WorkspaceContentSourceService): WorkSourcePort {
  async function openHtml(
    request: Parameters<WorkspaceContentSourceService['readTextSnapshot']>[0],
    contentRef: string,
  ) {
    const snapshot = await source.readTextSnapshot({ ...request, maxBytes: MAX_HTML_WORK_BYTES });
    if (snapshot.contentRef !== contentRef || snapshot.mime !== 'text/html')
      throw new MediaOwnerError('publication_changed');
    if (!snapshot.text.trim()) throw new WorkspaceContentSourceError('unsupported_text');
    return {
      mime: 'text/html' as const,
      byteLength: snapshot.byteLength,
      revision: snapshot.revision,
      stream: Readable.from([snapshot.bytes]),
      media: undefined,
    };
  }

  async function freezeSource(
    locator: Parameters<WorkSourcePort['openCurrent']>[0]['locator'],
    principal: WorkPrincipal,
    expectedRevision?: string,
  ): Promise<{ description: WorkspaceContentDescriptionV1; opened: OpenWorkSource }> {
    const request = { principal: { userId: principal.userId }, locator };
    const description = await source.describe(request);
    if (expectedRevision !== undefined && description.revision !== expectedRevision)
      throw new MediaOwnerError('publication_changed');
    const exact = { ...request, expectedRevision: description.revision };
    const snapshot =
      description.mime === 'text/html' ? await openHtml(exact, description.contentRef) : await source.openMedia(exact);
    return {
      description,
      opened: {
        mediaType: snapshot.mime,
        media: snapshot.media,
        stream: snapshot.stream,
        byteLength: snapshot.byteLength,
        blobDigest: snapshot.revision,
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
      },
    };
  }

  return {
    async inspect(input) {
      const { description, opened } = await freezeSource(input.locator, input.principal);
      opened.stream.destroy();
      return {
        source: { ...description.locator, expectedSourceRevision: description.revision },
        mediaType: opened.mediaType,
        byteLength: opened.byteLength,
        media: opened.media,
      };
    },
    async open(input) {
      const { expectedSourceRevision, ...locator } = input.source;
      return (await freezeSource(locator, input.principal, expectedSourceRevision)).opened;
    },
    async openCurrent(input) {
      return (await freezeSource(input.locator, input.principal)).opened;
    },
  };
}
