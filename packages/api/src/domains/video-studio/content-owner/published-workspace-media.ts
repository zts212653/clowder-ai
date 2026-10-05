import type { WorkspaceMediaSnapshotSource } from '@cat-cafe/shared';
import {
  WorkspaceContentSourceError,
  type WorkspaceContentSourceService,
} from '../../workspace/workspace-content-source.js';
import { MediaOwnerError } from './media-errors.js';
import { workspaceSnapshotSourceRef } from './publication.js';
import type { MediaReviewPrincipal } from './published-media-access.js';
import type { WorkspaceSnapshotPublicationScopeV1 } from './types.js';

export type WorkspaceMediaSourcePort = Pick<WorkspaceContentSourceService, 'describe' | 'openMedia'>;

export async function assertWorkspaceSnapshotVisible(
  workspace: WorkspaceMediaSourcePort | undefined,
  scope: WorkspaceSnapshotPublicationScopeV1,
  principal: MediaReviewPrincipal,
): Promise<void> {
  if (!workspace) throw new MediaOwnerError('media_unavailable');
  try {
    const current = await workspace.describe({
      principal: { userId: principal.userId },
      locator: scope.source.locator,
    });
    if (current.contentRef !== scope.sourceContentRef) throw new MediaOwnerError('access_denied');
  } catch (error) {
    if (error instanceof WorkspaceContentSourceError && (error.code === 'not_found' || error.code === 'access_denied'))
      throw new MediaOwnerError('access_denied');
    throw error;
  }
}

export async function resolveWorkspaceSnapshot(
  workspace: WorkspaceMediaSourcePort | undefined,
  source: WorkspaceMediaSnapshotSource,
  operationId: string,
  principal: MediaReviewPrincipal,
) {
  if (!workspace) throw new MediaOwnerError('media_unavailable');
  if (principal.actor.kind !== 'human') throw new MediaOwnerError('access_denied');
  const current = await workspace.describe({ principal: { userId: principal.userId }, locator: source.locator });
  const canonicalSource = { ...source, locator: current.locator };
  const scope: WorkspaceSnapshotPublicationScopeV1 = {
    kind: 'workspace-snapshot',
    ownerUserId: principal.userId,
    threadId: source.threadId,
    source: canonicalSource,
    sourceContentRef: current.contentRef,
    snapshotOperationId: operationId,
  };
  const publication = {
    artifactRef: current.contentRef,
    sourceRef: workspaceSnapshotSourceRef(canonicalSource),
    revision: source.expectedSourceRevision,
  };
  return {
    scope,
    publication,
    load: async () => {
      const opened = await workspace.openMedia({
        principal: { userId: principal.userId },
        locator: current.locator,
        expectedRevision: source.expectedSourceRevision,
      });
      if (opened.contentRef !== current.contentRef) {
        opened.stream.destroy();
        throw new MediaOwnerError('publication_changed');
      }
      const chunks: Buffer[] = [];
      let length = 0;
      try {
        for await (const chunk of opened.stream) {
          if (!Buffer.isBuffer(chunk)) throw new MediaOwnerError('invalid_media');
          length += chunk.length;
          if (length > opened.byteLength) throw new MediaOwnerError('invalid_media');
          chunks.push(chunk);
        }
        if (length !== opened.byteLength) throw new MediaOwnerError('publication_changed');
        await assertWorkspaceSnapshotVisible(workspace, scope, principal);
        return { bytes: Buffer.concat(chunks, length), mediaType: opened.mime };
      } finally {
        opened.stream.destroy();
      }
    },
  };
}
