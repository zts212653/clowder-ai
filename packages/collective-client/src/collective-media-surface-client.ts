import {
  assertCollectiveMediaReceipt,
  assertCollectiveMediaView,
  type CollectiveMediaSurfaceRequest,
  type CollectiveMediaSurfaceResult,
} from '@cat-cafe/shared';
import { CollectiveClientRequestError } from './client-request.js';
import {
  type collectiveArtifactClient,
  readArtifactJsonPages,
  type SharedArtifact,
} from './collective-artifact-client.js';

export async function serveCollectiveMediaRequest(
  message: CollectiveMediaSurfaceRequest,
  api: ReturnType<typeof collectiveArtifactClient>,
  artifact: SharedArtifact,
  humanName?: (humanId: string) => string,
): Promise<CollectiveMediaSurfaceResult['result']> {
  const { ref, operation } = message;
  if (
    artifact.artifactId !== ref.artifactId ||
    artifact.sourceEventId !== ref.sourceEventId ||
    artifact.serviceInstanceId !== ref.serviceInstanceId ||
    artifact.collectiveId !== ref.collectiveId ||
    artifact.sourceLocation.channelId !== ref.channelId ||
    (artifact.mediaType !== 'image/png' && artifact.mediaType !== 'video/mp4')
  )
    return { kind: 'error', code: 'access_denied' };
  try {
    const version =
      artifact.versions.find((item) => item.ownerRevision === ref.ownerRevision) ??
      (await api.version(artifact, ref.ownerRevision));
    if (operation.kind === 'read') {
      const value = await readArtifactJsonPages((cursor) =>
        api.operation(artifact, 'read', { ...operation.page, ...cursor }, message.requestId, ref.ownerRevision),
      );
      const selected = assertCollectiveMediaView(value, {
        ...ref,
        contentRef: artifact.contentRef,
        mediaType: artifact.mediaType,
        blobDigest: version.blobDigest,
      });
      const actors = [
        ...new Set(
          selected.view.review.annotations.flatMap((annotation) => [
            annotation.author.actorId,
            ...(annotation.replies ?? []).map((reply) => reply.author.actorId),
          ]),
        ),
      ];
      return {
        kind: 'read',
        title: artifact.title,
        ...(humanName ? { actors: actors.map((humanId) => ({ humanId, displayName: humanName(humanId) })) } : {}),
        value: selected,
      };
    }
    const value = await assertCollectiveMediaReceipt(
      await api.operation(artifact, 'annotate', operation.command, operation.operationId, ref.ownerRevision),
      ref,
      operation.operationId,
    );
    return { kind: 'annotated', value };
  } catch (error) {
    return {
      kind: 'error',
      code: mediaFailureCode(error),
    };
  }
}

function mediaFailureCode(error: unknown) {
  if (!(error instanceof CollectiveClientRequestError)) return 'unavailable' as const;
  if (error.status === 403) return 'access_denied' as const;
  if (error.status === 409) return 'conflict' as const;
  if (error.status === 503) return 'owner_unavailable' as const;
  return 'unavailable' as const;
}
