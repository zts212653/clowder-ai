import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import {
  createCatId,
  type MediaPublicationSource,
  mediaPublicationSourceSchema,
  type ReviewedMediaType,
} from '@cat-cafe/shared';
import { aggregateThreadArtifacts } from '../../cats/services/agents/routing/thread-artifacts-aggregator.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import { isDurableOwnerReadEvidence, resolveVisibleReplyParent } from '../../cats/services/stores/visibility.js';
import type { EvolutionMediaReadPort } from '../../collaborative-content/workspace-review/evolution-review-source.js';
import type { PreparedArtifactReader } from '../../growing/EntrustedWorkOwnerReadService.js';
import { MediaOwnerError } from './media-errors.js';
import { publishedMediaContentRef, workPublicationContentRef, workspaceSnapshotSourceRef } from './publication.js';
import {
  evolutionSnapshotPublication,
  readEvolutionSnapshotSource,
  resolveEvolutionSnapshot,
} from './published-evolution-media.js';
import type { MediaReviewPrincipal, PublishedMediaAccess } from './published-media-access.js';
import { publishedUploadMediaType, readPublishedMessageItem } from './published-message-media.js';
import {
  assertWorkspaceSnapshotVisible,
  resolveWorkspaceSnapshot,
  type WorkspaceMediaSourcePort,
} from './published-workspace-media.js';
import {
  type ContentPublicationScopeV1,
  type ContentSourcePublicationV1,
  type EvolutionSnapshotPublicationScopeV1,
  isTaskPublicationScope,
  type MessageContentPublicationScopeV1,
  type TaskContentPublicationScopeV1,
  type WorkspaceSnapshotPublicationScopeV1,
} from './types.js';

export class PublishedMediaSource {
  private readonly uploadDir: string;
  constructor(
    private readonly deps: {
      artifacts: PreparedArtifactReader;
      messages: Pick<IMessageStore, 'getById' | 'getArtifactById'>;
      uploadDir: string;
      readPrivateMessageImage?: (id: string, principal: MediaReviewPrincipal) => Promise<Buffer>;
      workspace?: WorkspaceMediaSourcePort;
      evolution?: EvolutionMediaReadPort;
      access: Pick<PublishedMediaAccess, 'authorizeSourceThread' | 'authorizeScope'>;
    },
  ) {
    this.uploadDir = resolve(deps.uploadDir);
  }

  /** Only called after publication authorization; retain the original upload when its bytes still match. */
  async localOriginalFile(publication: ContentSourcePublicationV1 | undefined, digest: string): Promise<string | null> {
    const ref = publication?.artifactRef;
    if (!ref?.startsWith('/uploads/')) return null;
    try {
      const name = decodeURIComponent(ref.slice('/uploads/'.length));
      if (!name || name !== basename(name) || name.includes('\\') || name.includes('\0')) return null;
      const [root, path] = await Promise.all([realpath(this.uploadDir), realpath(join(this.uploadDir, name))]);
      if (!path.startsWith(root + sep)) return null;
      const bytes = await readBoundedFile(path, 256 * 1024 * 1024);
      return `sha256:${createHash('sha256').update(bytes).digest('hex')}` === digest ? path : null;
    } catch {
      return null;
    }
  }

  messageIdentity(source: import('@cat-cafe/shared').MessageMediaPublicationSource, principal: MediaReviewPrincipal) {
    return readPublishedMessageItem(this.deps.messages, source, principal);
  }

  async resolveSource(raw: MediaPublicationSource, operationId: string, principal: MediaReviewPrincipal) {
    const source = mediaPublicationSourceSchema.parse(raw);
    if (source.kind === 'evolution-snapshot')
      return resolveEvolutionSnapshot(this.deps.evolution, source, operationId, principal);
    if (source.kind === 'workspace-snapshot')
      return resolveWorkspaceSnapshot(this.deps.workspace, source, operationId, principal);
    const scope: MessageContentPublicationScopeV1 = {
      kind: 'message',
      ownerUserId: principal.userId,
      threadId: source.threadId,
      source,
    };
    const resolved = await readPublishedMessageItem(this.deps.messages, source, principal);
    return {
      scope,
      publication: resolved.publication,
      load: async () => {
        if (resolved.privateImageId && !this.deps.readPrivateMessageImage)
          throw new MediaOwnerError('media_unavailable');
        const bytes = resolved.privateImageId
          ? await this.deps.readPrivateMessageImage!(resolved.privateImageId, principal)
          : await readBoundedFile(
              join(this.uploadDir, resolved.fileName),
              resolved.mediaType === 'video/mp4' ? 256 * 1024 * 1024 : 10 * 1024 * 1024,
            );
        await this.assertVisible(scope, resolved.publication, principal);
        return { bytes, mediaType: resolved.mediaType };
      },
    };
  }

  async assertVisible(
    scope: ContentPublicationScopeV1,
    publication: ContentSourcePublicationV1,
    principal: MediaReviewPrincipal,
  ): Promise<void> {
    if (scope.ownerUserId !== principal.userId) throw new MediaOwnerError('access_denied');
    if (!isTaskPublicationScope(scope) && scope.kind === 'work') {
      // Retained work revisions survive source-file changes. Their live boundary is the owning thread.
      await this.deps.access.authorizeScope(scope, principal, true, workPublicationContentRef(scope));
      return;
    }
    if (!isTaskPublicationScope(scope)) {
      const origin = await this.originPublication(scope, principal);
      // Derive the exact original identity here, including for returned versions. Call order is not authority.
      await this.deps.access.authorizeScope(scope, principal, true, publishedMediaContentRef(scope, origin));
      if (origin.sourceRef === publication.sourceRef && origin.revision === publication.revision) {
        if (origin.artifactRef !== publication.artifactRef) throw new MediaOwnerError('publication_changed');
        return;
      }
      // A returned version may have a new message source; the original publication still authorizes the lineage.
    } else await this.deps.access.authorizeScope(scope, principal);
    const sourceThreadId = publication.threadId ?? scope.threadId;
    if (sourceThreadId !== scope.threadId) {
      await this.deps.access.authorizeSourceThread(sourceThreadId, principal);
    }
    await this.assertMessagePublication(sourceThreadId, publication, principal);
  }

  async originDetails(scope: ContentPublicationScopeV1, principal: MediaReviewPrincipal) {
    if (!isTaskPublicationScope(scope) && scope.kind === 'work') {
      await this.deps.access.authorizeScope(scope, principal, true, workPublicationContentRef(scope));
      return {
        title: '作品',
        sourceRef: `work-operation:${scope.creationOperationId}`,
        ...(scope.createdBy.kind === 'cat' ? { publisherCatId: scope.createdBy.actorId } : {}),
      };
    }
    if (!isTaskPublicationScope(scope) && scope.kind === 'evolution-snapshot') {
      const original = await readEvolutionSnapshotSource(this.deps.evolution, scope.source, principal);
      return { title: original.label, sourceRef: scope.sourceContentRef };
    }
    if (!isTaskPublicationScope(scope) && scope.kind === 'message') {
      const item = await readPublishedMessageItem(this.deps.messages, scope.source, principal);
      return {
        title: item.fileName,
        sourceRef: item.publication.sourceRef,
        ...(item.publisherCatId ? { publisherCatId: item.publisherCatId } : {}),
      };
    }
    if (!isTaskPublicationScope(scope))
      return {
        title: scope.source.locator.path.split('/').at(-1) ?? '作品',
        sourceRef: workspaceSnapshotSourceRef(scope.source),
      };
    return { title: '任务作品', sourceRef: `task:work:${scope.taskId}` };
  }

  private async originPublication(
    scope: MessageContentPublicationScopeV1 | WorkspaceSnapshotPublicationScopeV1 | EvolutionSnapshotPublicationScopeV1,
    principal: MediaReviewPrincipal,
  ): Promise<ContentSourcePublicationV1> {
    if (scope.kind === 'message')
      return (await readPublishedMessageItem(this.deps.messages, scope.source, principal)).publication;
    if (scope.kind === 'evolution-snapshot') {
      await readEvolutionSnapshotSource(this.deps.evolution, scope.source, principal);
      return evolutionSnapshotPublication(scope.source);
    }
    await assertWorkspaceSnapshotVisible(this.deps.workspace, scope, principal);
    return {
      artifactRef: scope.sourceContentRef,
      sourceRef: workspaceSnapshotSourceRef(scope.source),
      revision: scope.source.expectedSourceRevision,
    };
  }

  private async assertMessagePublication(
    threadId: string,
    publication: ContentSourcePublicationV1,
    principal: MediaReviewPrincipal,
  ): Promise<void> {
    const prefix = `message:${threadId}:`;
    if (!publication.sourceRef.startsWith(prefix)) throw new MediaOwnerError('access_denied');
    const message = await resolveVisibleReplyParent(this.deps.messages, publication.sourceRef.slice(prefix.length), {
      threadId,
      viewer:
        principal.actor.kind === 'human'
          ? { type: 'user' }
          : { type: 'cat', catId: createCatId(principal.actor.actorId) },
    });
    if (
      !message ||
      message.userId !== principal.userId ||
      message.recall ||
      message._tombstone ||
      message.deliveryStatus === 'queued' ||
      !isDurableOwnerReadEvidence(message)
    )
      throw new MediaOwnerError('access_denied');
    const matches = aggregateThreadArtifacts({ messages: [message], prTasks: [], fileLedger: [] }).filter(
      (artifact) => artifact.url === publication.artifactRef && String(artifact.createdAt) === publication.revision,
    );
    // The retained object already has an immutable identity. Multiple visible instances of its source
    // do not revoke it; new admission still requires uniqueness in PreparedArtifactReader.read.
    if (matches.length === 0) throw new MediaOwnerError('publication_changed');
  }

  async read(input: {
    scope: TaskContentPublicationScopeV1;
    principal: MediaReviewPrincipal;
    taskRevision: number;
    artifactRef: string;
    expectedArtifactRevision: string;
    publicationSource?: import('@cat-cafe/shared').MessageMediaPublicationSource;
  }): Promise<{ bytes: Buffer; mediaType: ReviewedMediaType; publication: ContentSourcePublicationV1 }> {
    const file = /^\/uploads\/([a-zA-Z0-9][a-zA-Z0-9._-]*\.(png|jpe?g|webp|mp4))$/i.exec(input.artifactRef);
    if (!file?.[1] || !file[2]) throw new MediaOwnerError('invalid_media');
    const exact = input.publicationSource;
    const selected = exact ? await readPublishedMessageItem(this.deps.messages, exact, input.principal) : undefined;
    if (exact && exact.threadId !== input.scope.threadId) throw new MediaOwnerError('access_denied');
    const coordinate =
      selected && exact
        ? {
            artifactRef: selected.publication.artifactRef,
            artifactRevision: exact.messageRevision,
            completenessRef: selected.publication.sourceRef,
          }
        : await this.deps.artifacts.readPreparedArtifact({
            artifactRef: input.artifactRef,
            taskThreadId: input.scope.threadId,
            taskSubjectRef: `task:work:${input.scope.taskId}`,
            taskOwnerRef: `task:item:${input.scope.taskId}`,
            taskRevision: input.taskRevision,
            ownerUserId: input.scope.ownerUserId,
          });
    if (
      !coordinate ||
      coordinate.artifactRevision !== input.expectedArtifactRevision ||
      coordinate.artifactRef !== input.artifactRef
    ) {
      throw new MediaOwnerError('publication_changed');
    }
    const sourceRef = coordinate.completenessRef.split('#')[0];
    if (!sourceRef) throw new MediaOwnerError('publication_changed');
    const publication = { artifactRef: input.artifactRef, sourceRef, revision: coordinate.artifactRevision };
    await this.assertVisible(input.scope, publication, input.principal);
    const mediaType = publishedUploadMediaType(file[2]);
    const bytes = await readBoundedFile(
      join(this.uploadDir, file[1]),
      mediaType === 'video/mp4' ? 256 * 1024 * 1024 : 10 * 1024 * 1024,
    );
    await this.assertVisible(input.scope, publication, input.principal);
    if (exact) await readPublishedMessageItem(this.deps.messages, exact, input.principal);
    return { bytes, mediaType, publication };
  }
}

async function readBoundedFile(path: string, maximum: number): Promise<Buffer> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.size <= 0n || before.size > BigInt(maximum))
        throw new MediaOwnerError('invalid_media');
      const bytes = Buffer.alloc(Number(before.size));
      let offset = 0;
      while (offset < bytes.length) {
        const read = await file.read(bytes, offset, bytes.length - offset, offset);
        if (read.bytesRead === 0) throw new MediaOwnerError('publication_changed');
        offset += read.bytesRead;
      }
      const after = await file.stat({ bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs)
        throw new MediaOwnerError('publication_changed');
      return bytes;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof MediaOwnerError) throw error;
    throw new MediaOwnerError('media_unavailable');
  }
}
