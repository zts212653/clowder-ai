import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createCatId } from '@cat-cafe/shared';
import { aggregateThreadArtifacts } from '../../cats/services/agents/routing/thread-artifacts-aggregator.js';
import type { IMessageStore } from '../../cats/services/stores/ports/MessageStore.js';
import { isDurableOwnerReadEvidence, resolveVisibleReplyParent } from '../../cats/services/stores/visibility.js';
import type { PreparedArtifactReader } from '../../growing/EntrustedWorkOwnerReadService.js';
import { MediaOwnerError } from './media-errors.js';
import type { MediaReviewPrincipal } from './published-media-access.js';
import type { ContentPublicationScopeV1, ContentSourcePublicationV1 } from './types.js';

export class PublishedMediaSource {
  private readonly uploadDir: string;
  constructor(
    private readonly deps: {
      artifacts: PreparedArtifactReader;
      messages: Pick<IMessageStore, 'getById'>;
      uploadDir: string;
    },
  ) {
    this.uploadDir = resolve(deps.uploadDir);
  }

  async assertVisible(
    scope: ContentPublicationScopeV1,
    publication: ContentSourcePublicationV1,
    principal: MediaReviewPrincipal,
  ): Promise<void> {
    if (
      scope.ownerUserId !== principal.userId ||
      (principal.actor.kind === 'cat' && principal.threadId !== scope.threadId)
    )
      throw new MediaOwnerError('access_denied');
    const prefix = `message:${scope.threadId}:`;
    if (!publication.sourceRef.startsWith(prefix)) throw new MediaOwnerError('access_denied');
    const message = await resolveVisibleReplyParent(this.deps.messages, publication.sourceRef.slice(prefix.length), {
      threadId: scope.threadId,
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
      !isDurableOwnerReadEvidence(message)
    )
      throw new MediaOwnerError('access_denied');
    const matches = aggregateThreadArtifacts({ messages: [message], prTasks: [], fileLedger: [] }).filter(
      (artifact) => artifact.url === publication.artifactRef && String(artifact.createdAt) === publication.revision,
    );
    if (matches.length !== 1) throw new MediaOwnerError('publication_changed');
  }

  async read(input: {
    scope: ContentPublicationScopeV1;
    principal: MediaReviewPrincipal;
    taskRevision: number;
    artifactRef: string;
    expectedArtifactRevision: string;
  }): Promise<{ bytes: Buffer; mediaType: 'image/png' | 'video/mp4'; publication: ContentSourcePublicationV1 }> {
    const file = /^\/uploads\/([a-zA-Z0-9][a-zA-Z0-9._-]*\.(png|mp4))$/i.exec(input.artifactRef);
    if (!file?.[1] || !file[2]) throw new MediaOwnerError('invalid_media');
    const coordinate = await this.deps.artifacts.readPreparedArtifact({
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
    const mediaType = file[2].toLowerCase() === 'png' ? 'image/png' : 'video/mp4';
    const bytes = await readBoundedFile(
      join(this.uploadDir, file[1]),
      mediaType === 'image/png' ? 10 * 1024 * 1024 : 256 * 1024 * 1024,
    );
    await this.assertVisible(input.scope, publication, input.principal);
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
