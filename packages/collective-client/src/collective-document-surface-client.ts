import {
  type CollectiveDocumentRequest,
  type CollectiveDocumentResult,
  collectiveDocumentViewSchema,
} from '@cat-cafe/shared';
import { CollectiveClientRequestError } from './client-request.js';
import type { collectiveArtifactClient } from './collective-artifact-client.js';

export async function serveCollectiveDocumentRequest(
  request: CollectiveDocumentRequest,
  api: ReturnType<typeof collectiveArtifactClient>,
): Promise<CollectiveDocumentResult> {
  const { ref, operation } = request;
  try {
    const artifact = (await api.list()).find((candidate) => candidate.artifactId === ref.artifactId);
    if (
      !artifact ||
      artifact.serviceInstanceId !== ref.serviceInstanceId ||
      artifact.collectiveId !== ref.collectiveId ||
      artifact.sourceEventId !== ref.sourceEventId ||
      artifact.sourceLocation.channelId !== ref.channelId ||
      artifact.mediaType !== 'text/markdown'
    )
      return { kind: 'error', code: 'access_denied' };
    if (artifact.availability !== 'available') return { kind: 'error', code: 'owner_unavailable' };
    if (operation.kind === 'history')
      return { kind: 'history', value: await api.history(artifact, { offset: operation.offset }) };
    const revision = operation.kind === 'read' ? operation.ownerRevision : ref.ownerRevision;
    if (revision !== ref.ownerRevision && revision !== ref.comparisonOwnerRevision)
      return { kind: 'error', code: 'access_denied' };
    const value = collectiveDocumentViewSchema.parse(await api.read(artifact, revision));
    if (value.ownerRevision !== revision || value.contentRef !== artifact.contentRef)
      return { kind: 'error', code: 'conflict' };
    if (operation.kind === 'stage-selection') return { kind: 'error', code: 'access_denied' };
    return { kind: 'read', title: artifact.title, value };
  } catch (error) {
    return {
      kind: 'error',
      code:
        error instanceof CollectiveClientRequestError
          ? error.status === 401 || error.status === 403
            ? 'access_denied'
            : error.status === 503
              ? 'owner_unavailable'
              : error.status === 409
                ? 'conflict'
                : 'unavailable'
          : 'unavailable',
    };
  }
}
