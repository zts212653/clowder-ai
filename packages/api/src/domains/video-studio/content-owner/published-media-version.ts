import {
  type MessageMediaPublicationSource,
  type ReviewedMediaAsset,
  reviewedMediaAssetSchema,
} from '@cat-cafe/shared';
import { MediaOwnerError } from './media-errors.js';
import { type MediaReviewPrincipal, type PublishedMediaAccess, withContentTask } from './published-media-access.js';
import { probeImmutableMedia } from './published-media-probe.js';
import type { PublishedMediaSource } from './published-media-source.js';
import type { ProjectContentOwnerService } from './service.js';
import { isTaskPublicationScope } from './types.js';

export interface PublishedMediaVersionInput {
  taskId: string;
  expectedTaskRevision: number;
  contentRef: string;
  expectedOwnerRevision: number;
  artifactRef: string;
  expectedArtifactRevision: string;
  operationId: string;
  principal: MediaReviewPrincipal;
  publicationSource?: MessageMediaPublicationSource;
  authorizeEffect?: () => Promise<void>;
}

/** Publish once under the existing content owner; source/caller authorization is repeated at the owner effect. */
export async function publishMediaVersion(
  deps: { owner: ProjectContentOwnerService; access: PublishedMediaAccess; sources: PublishedMediaSource },
  input: PublishedMediaVersionInput,
): Promise<ReviewedMediaAsset> {
  input = { ...input, principal: withContentTask(input.principal, input.taskId) };
  const current = await deps.owner.describe(input.contentRef);
  await deps.access.authorizeScope(current.publicationScope, input.principal, false, input.contentRef);
  const task = await deps.access.authorize(input.taskId, input.principal, {
    expectedRevision: input.expectedTaskRevision,
  });
  if (input.principal.actor.kind !== 'cat' || task.ownerCatId !== input.principal.actor.actorId)
    throw new MediaOwnerError('access_denied');
  const scope = current.publicationScope;
  if (!scope) throw new MediaOwnerError('access_denied');
  if (isTaskPublicationScope(scope) && scope.taskId !== task.id) throw new MediaOwnerError('task_changed');
  if (!isTaskPublicationScope(scope))
    await deps.access.authorizePublicationTask(input.contentRef, input.principal, false);
  const source = await deps.sources.read({
    scope: { ownerUserId: scope.ownerUserId, threadId: task.threadId, taskId: task.id },
    principal: input.principal,
    taskRevision: input.expectedTaskRevision,
    artifactRef: input.artifactRef,
    expectedArtifactRevision: input.expectedArtifactRevision,
    ...(input.publicationSource ? { publicationSource: input.publicationSource } : {}),
  });
  if (source.mediaType !== current.mediaType) throw new MediaOwnerError('invalid_media');
  const media = await probeImmutableMedia(source.bytes, source.mediaType);
  const publication = {
    ...source.publication,
    ...(task.threadId !== scope.threadId ? { threadId: task.threadId } : {}),
  };
  await deps.access.authorize(input.taskId, input.principal, { expectedRevision: input.expectedTaskRevision });
  await deps.sources.assertVisible(scope, publication, input.principal);
  const receipt = await deps.owner.settle({
    contentRef: input.contentRef,
    expectedOwnerRevision: input.expectedOwnerRevision,
    bytes: source.bytes,
    actor: input.principal.actor,
    operationId: input.operationId,
    sourcePublication: publication,
    authorizeEffect: async () => {
      await deps.access.authorize(input.taskId, input.principal, { expectedRevision: input.expectedTaskRevision });
      await deps.sources.assertVisible(scope, publication, input.principal);
      await input.authorizeEffect?.();
    },
  });
  // Return the actual owner effect to its projection coordinator even if authority changes afterwards.
  // Every external read/response still goes through the service's fresh authorization fence.
  return reviewedMediaAssetSchema.parse({
    contentRef: input.contentRef,
    ownerRevision: receipt.ownerRevision,
    blobDigest: receipt.blobDigest,
    mediaType: source.mediaType,
    media,
    sourcePublication: publication,
    ownerReceiptRef: receipt.receiptId,
  });
}
