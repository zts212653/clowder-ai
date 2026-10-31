import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  collectiveArtifactPublicationOperationSchema,
  collectiveArtifactPublicationReceiptSchema,
  collectiveArtifactPublicationRecordSchema,
} from '@cat-cafe/shared';
import {
  collectiveContentScopeRef,
  collectiveContentScopeSchema,
} from '../../video-studio/content-owner/collective-scope.js';
import type { ProjectContentOwnerService } from '../../video-studio/content-owner/service.js';
import type { CollectiveArtifactOwnerPort } from './owner-port.js';

/** A selected upload becomes canonical bytes only at the existing owner's fresh-authorized commit boundary. */
export async function publishCollectiveMarkdown(
  owner: ProjectContentOwnerService,
  operation: Parameters<NonNullable<CollectiveArtifactOwnerPort['publish']>>[0],
  authority: Parameters<NonNullable<CollectiveArtifactOwnerPort['publish']>>[1],
) {
  const { publication, bytesBase64 } = collectiveArtifactPublicationOperationSchema.parse(operation);
  const authorizeEffect = async () => {
    if (!isDeepStrictEqual(await authority.reauthorize(), publication))
      throw Object.assign(new Error('Publication authority changed'), { statusCode: 403 });
  };
  await authorizeEffect();
  const bytes = Buffer.from(bytesBase64, 'base64');
  if (
    bytes.length > 65536 ||
    bytes.toString('base64') !== bytesBase64 ||
    `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== publication.blobDigest
  )
    throw new TypeError('Publication bytes do not match the selected Markdown');
  const scope = collectiveContentScopeSchema.parse({
    kind: 'collective-artifact',
    serviceInstanceId: publication.serviceInstanceId,
    collectiveId: publication.collectiveId,
    artifactId: publication.artifactId,
    contentRef: publication.contentRef,
    sourceEventId: publication.sourceEventId,
    publishedByHumanId: publication.humanId,
  });
  const receipt = await owner.importContent({
    contentRef: publication.contentRef,
    collectiveScope: scope,
    bytes,
    mediaType: 'text/markdown',
    actor: { kind: 'human', actorId: publication.humanId },
    operationId: publication.publicationId,
    authorizeEffect,
    operationContext: {
      kind: 'collective-artifact:publish',
      requestDigest: publication.requestDigest,
      actorHumanId: publication.humanId,
      scopeRef: collectiveContentScopeRef(scope),
      custodyRevision: 1,
      dispositionId: publication.publicationId,
    },
  });
  return { receipt };
}

/** No fresh effect and no content read: reconcile only the original operation under the canonical owner lock. */
export async function recoverCollectiveMarkdownPublication(
  owner: ProjectContentOwnerService,
  unsafe: Parameters<NonNullable<CollectiveArtifactOwnerPort['recoverPublication']>>[0],
) {
  const publication = collectiveArtifactPublicationRecordSchema.parse(unsafe);
  const scopeRef = collectiveContentScopeRef({
    kind: 'collective-artifact',
    serviceInstanceId: publication.serviceInstanceId,
    collectiveId: publication.collectiveId,
    artifactId: publication.artifactId,
    contentRef: publication.contentRef,
    sourceEventId: publication.sourceEventId,
    publishedByHumanId: publication.humanId,
  });
  return owner.reconcileCollectiveOperation(
    {
      contentRef: publication.contentRef,
      operationId: publication.publicationId,
      scopeRef,
      allowMissingInitialPublication: true,
    },
    (receipt) =>
      receipt
        ? { status: 'committed' as const, receipt: collectiveArtifactPublicationReceiptSchema.parse(receipt) }
        : { status: 'absent' as const },
  );
}
