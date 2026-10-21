import { isDeepStrictEqual } from 'node:util';
import {
  type CollectiveArtifactConstraint,
  collectiveMediaOperationId,
  collectiveMediaReviewCommandSchema,
  collectiveMediaShareScopeSchema,
} from '@cat-cafe/shared';
import { WorkspaceContentReviewError } from '../workspace-review/errors.js';
import type { CollectiveMediaReviews } from './media-reviews.js';
import { type SharedPublishedMediaAsset, sharedMediaAsset } from './media-source.js';
import type { CollectiveArtifactOwnerPort } from './owner-port.js';
import type { CollectivePublishedMediaOwner } from './published-media-owner.js';

export interface AdmittedCollectiveMedia {
  constraint: CollectiveArtifactConstraint;
  asset: SharedPublishedMediaAsset;
  currentOwnerRevision: number;
  operationId: string;
  authorize(current?: boolean): Promise<void>;
}
export function mediaConstraintScope(c: CollectiveArtifactConstraint) {
  return collectiveMediaShareScopeSchema.parse({
    serviceInstanceId: c.serviceInstanceId,
    collectiveId: c.collectiveId,
    artifactId: c.artifactId,
    sourceEventId: c.sourceEventId,
    custodyRevision: c.custodyRevision,
  });
}
export async function admitCollectiveMedia(
  deps: CollectivePublishedMediaOwner['deps'],
  reviews: CollectiveMediaReviews,
  operation: Parameters<CollectiveArtifactOwnerPort['execute']>[0],
  authority: Parameters<CollectiveArtifactOwnerPort['execute']>[1],
): Promise<AdmittedCollectiveMedia> {
  const c = operation.constraint,
    scope = mediaConstraintScope(c);
  if (c.reviewReply) throw new WorkspaceContentReviewError('access_denied');
  if (c.mediaReviewReply) {
    const parsed = collectiveMediaReviewCommandSchema.safeParse(operation.payload);
    if (
      c.action !== 'annotate' ||
      c.agent ||
      !parsed.success ||
      parsed.data.action.kind !== 'reply' ||
      parsed.data.action.annotationId !== c.mediaReviewReply.annotationId
    )
      throw new WorkspaceContentReviewError('access_denied');
  }
  const principal = { userId: deps.ownerUserId, actor: { kind: 'human' as const, actorId: deps.ownerUserId } };
  const fresh = async () => {
    if (
      !isDeepStrictEqual(await authority.reauthorize(), c) ||
      operation.expiresAt <= Date.now() ||
      c.expiresAt <= Date.now()
    )
      throw new WorkspaceContentReviewError('access_denied');
    reviews.find(scope, c.contentRef);
  };
  await fresh();
  const description = await deps.media.describe(c.contentRef, c.ownerRevision, principal);
  const asset = sharedMediaAsset(description.asset);
  const authorize = async (current = false) => {
    await fresh();
    const actual = await deps.media.describe(c.contentRef, c.ownerRevision, principal);
    if (!isDeepStrictEqual(sharedMediaAsset(actual.asset), asset) || asset.blobDigest !== c.blobDigest)
      throw new WorkspaceContentReviewError('access_denied');
    reviews.require(scope, asset);
    if (
      current &&
      (actual.currentOwnerRevision !== asset.ownerRevision ||
        (c.catalogueOwnerRevision !== undefined && c.catalogueOwnerRevision !== asset.ownerRevision))
    )
      throw new WorkspaceContentReviewError('source_changed');
    await fresh();
  };
  await authorize();
  return {
    constraint: c,
    asset,
    currentOwnerRevision: description.currentOwnerRevision,
    authorize,
    operationId: await collectiveMediaOperationId(c, c.action, operation.requestId),
  };
}
