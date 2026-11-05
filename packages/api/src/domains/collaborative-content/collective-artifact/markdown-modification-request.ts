import {
  type CollectiveModificationRecord,
  collectiveArtifactModificationRequestCommandSchema,
} from '@cat-cafe/shared';
import { collectiveContentScopeRef } from '../../video-studio/content-owner/collective-scope.js';
import type { ArtifactReviewStore } from '../artifact-review/store.js';
import { WorkspaceContentReviewError } from '../workspace-review/errors.js';
import type { AdmittedCollectiveMarkdown } from './markdown-authority.js';
import type { CollectiveMarkdownReviews } from './markdown-reviews.js';

export async function requestCollectiveModification(
  admitted: AdmittedCollectiveMarkdown,
  payload: unknown,
  stores: { modifications: ArtifactReviewStore; reviews: CollectiveMarkdownReviews; ownerUserId: string },
  delegated = false,
) {
  const input = collectiveArtifactModificationRequestCommandSchema.parse(payload);
  const scopeRef = collectiveContentScopeRef(admitted.scope);
  const prior = requireReworkCandidate(admitted, input, stores.modifications);
  const annotationIds = prior ? prior.annotationIds : input.annotationIds;
  const review = stores.reviews.prepare(admitted);
  if (
    Boolean(admitted.constraint.agent) !== delegated ||
    (!delegated && admitted.content.ownerRevision !== admitted.content.currentOwnerRevision) ||
    (delegated ? input.expectedReviewRevision > review.revision : review.revision !== input.expectedReviewRevision) ||
    (!delegated && review.source.revision !== admitted.content.blobDigest) ||
    new Set(input.annotationIds).size !== input.annotationIds.length
  )
    throw new WorkspaceContentReviewError('source_changed');
  const agent = admitted.constraint.agent;
  if (
    agent &&
    (input.messageEventId !== agent.requestEventId ||
      input.target.catId !== agent.catId ||
      input.target.humanId !== agent.humanId ||
      input.target.connectionId !== agent.connectionId ||
      input.target.participationRevision !== agent.participationRevision)
  )
    throw new WorkspaceContentReviewError('access_denied');
  for (const id of annotationIds) {
    const annotation = review.annotations.find((item) => item.id === id);
    if (
      !annotation?.collectiveMessage ||
      (!prior && annotation.anchor.baseRevision !== admitted.content.blobDigest) ||
      (!prior && annotation.collectiveMessage.ownerRevision !== admitted.content.ownerRevision) ||
      annotation.collectiveMessage.serviceInstanceId !== admitted.scope.serviceInstanceId ||
      annotation.collectiveMessage.collectiveId !== admitted.scope.collectiveId ||
      annotation.collectiveMessage.channelId !== input.location.channelId ||
      annotation.collectiveMessage.rootEventId !== (input.location.rootEventId ?? admitted.scope.sourceEventId)
    )
      throw new WorkspaceContentReviewError('source_changed');
  }
  await admitted.authorize();
  return stores.modifications.requests.collective.reserve({
    ownerUserId: stores.ownerUserId,
    requestingHumanId: admitted.constraint.humanId,
    source: {
      scopeRef,
      serviceInstanceId: admitted.scope.serviceInstanceId,
      collectiveId: admitted.scope.collectiveId,
      artifactId: admitted.scope.artifactId,
      contentRef: admitted.content.contentRef,
      ownerRevision: admitted.content.ownerRevision,
      blobDigest: admitted.content.blobDigest,
      ledgerRef: review.reviewId,
      ledgerRevision: input.expectedReviewRevision,
      sourceEventId: admitted.scope.sourceEventId,
      requestEventId: input.messageEventId,
      location: input.location,
      ...(input.rework ? { rework: input.rework } : {}),
    },
    target: input.target,
    instruction: input.instruction,
    annotationIds,
  });
}

function requireReworkCandidate(
  admitted: AdmittedCollectiveMarkdown,
  input: ReturnType<typeof collectiveArtifactModificationRequestCommandSchema.parse>,
  modifications: ArtifactReviewStore,
) {
  if (!input.rework) return undefined;
  const prior = modifications.requests.collective.get(
    input.rework.requestId,
    collectiveContentScopeRef(admitted.scope),
  );
  const proposal = modifications.text
    .proposals(input.rework.requestId)
    .find((item) => item.proposalRef === input.rework?.proposalRef);
  if (
    !prior ||
    !proposal ||
    input.annotationIds.length ||
    input.selections ||
    prior.source.contentRef !== admitted.content.contentRef ||
    prior.source.sourceEventId !== admitted.scope.sourceEventId ||
    prior.source.ownerRevision >= admitted.content.ownerRevision ||
    proposal.baseRevision !== prior.source.blobDigest
  )
    throw new WorkspaceContentReviewError('source_changed');
  return prior;
}

/** Explicit projection: no Host user, private execution or endpoint coordinates cross into the Client. */
export function projectCollectiveModification(record: CollectiveModificationRecord) {
  const { operationId: _operation, expectedRequestRevision: _expected, ...resolution } = record.resolution ?? {};
  return {
    requestId: record.requestId,
    revision: record.revision,
    state: record.state,
    requestingHumanId: record.requestingHumanId,
    target: { humanId: record.target.humanId, catId: record.target.catId },
    ownerRevision: record.source.ownerRevision,
    blobDigest: record.source.blobDigest,
    requestEventId: record.source.requestEventId,
    sourceEventId: record.source.sourceEventId,
    location: record.source.location,
    annotationIds: record.annotationIds,
    ...(record.resolution ? { resolution } : {}),
    ...(record.source.rework ? { rework: record.source.rework } : {}),
    ...(record.transferOutcome ? { unavailableReason: record.transferOutcome.reason } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}
