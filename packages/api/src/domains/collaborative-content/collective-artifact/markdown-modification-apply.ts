import { createHash } from 'node:crypto';
import type { CollectiveModificationRecord, ContentTextProposal } from '@cat-cafe/shared';
import { collectiveContentScopeRef } from '../../video-studio/content-owner/collective-scope.js';
import type { ProjectContentOwnerService } from '../../video-studio/content-owner/service.js';
import type { ContentSettlementReceiptV1 } from '../../video-studio/content-owner/types.js';
import type { ArtifactReviewStore } from '../artifact-review/store.js';
import type { CollectiveAcceptanceIntent } from '../modification/collective-acceptance-store.js';
import { applyContentTextEdits } from '../modification/text/text-store.js';
import { WorkspaceContentReviewError } from '../workspace-review/errors.js';
import type { AdmittedCollectiveMarkdown } from './markdown-authority.js';

export async function applyCollectiveModification(
  admitted: AdmittedCollectiveMarkdown,
  request: CollectiveModificationRecord,
  proposal: ContentTextProposal,
  stores: { owner: ProjectContentOwnerService; modifications: ArtifactReviewStore; ownerUserId: string },
) {
  if (admitted.constraint.agent) throw new WorkspaceContentReviewError('access_denied');
  const source = await stores.owner.load(admitted.content.contentRef, request.source.ownerRevision);
  if (
    source.blobDigest !== request.source.blobDigest ||
    proposal.baseRevision !== source.blobDigest ||
    collectiveContentScopeRef(admitted.scope) !== request.source.scopeRef
  )
    throw new WorkspaceContentReviewError('source_changed');
  const bytes = Buffer.from(applyContentTextEdits(source.bytes.toString('utf8'), proposal.edits));
  const resultDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  if (bytes.byteLength > 65536 || resultDigest !== proposal.resultRevision)
    throw new WorkspaceContentReviewError('source_changed');
  const dispositionId = `collective-adoption:${createHash('sha256').update(admitted.operationId).digest('hex')}`;
  const requestDigest = `sha256:${createHash('sha256')
    .update(
      JSON.stringify([request.requestId, proposal.proposalRef, proposal.resultRevision, admitted.constraint.humanId]),
    )
    .digest('hex')}` as const;
  const intent = {
    scopeRef: request.source.scopeRef,
    ownerUserId: stores.ownerUserId,
    requestId: request.requestId,
    dispositionId,
    actorHumanId: admitted.constraint.humanId,
    candidateRef: proposal.proposalRef,
    contentRef: source.contentRef,
    expectedOwnerRevision: source.ownerRevision,
    custodyRevision: admitted.constraint.custodyRevision,
    baseDigest: source.blobDigest,
    resultDigest,
    ownerOperationId: admitted.operationId,
    requestDigest,
  };
  await admitted.authorize();
  if (
    source.currentOwnerRevision !== request.source.ownerRevision &&
    !(await stores.owner.listOutbox(source.contentRef)).some((receipt) => receipt.operationId === admitted.operationId)
  )
    throw new WorkspaceContentReviewError('source_changed');
  const previous = stores.modifications.acceptances.collective.winner(request.requestId, request.source.scopeRef);
  if (previous?.state === 'pending') await reconcileCollectiveDisposition(previous.intent, stores);
  const disposition = stores.modifications.acceptances.collective.reserve(intent);
  if (disposition.state === 'accepted') return { state: 'accepted', receipt: disposition.receipt };
  // The pending winner survives lost responses. Owner CAS and its operation receipt decide effect exactly once.
  let receipt: ContentSettlementReceiptV1;
  try {
    receipt = await stores.owner.settle({
      contentRef: source.contentRef,
      expectedOwnerRevision: source.ownerRevision,
      bytes,
      actor: { kind: 'human', actorId: admitted.constraint.humanId },
      operationId: admitted.operationId,
      operationContext: {
        kind: 'collective-artifact:apply',
        actorHumanId: admitted.constraint.humanId,
        scopeRef: request.source.scopeRef,
        custodyRevision: intent.custodyRevision,
        dispositionId,
        requestDigest,
      },
      authorizeEffect: async () => {
        await admitted.authorize();
        const winner = stores.modifications.acceptances.collective.reserve(intent);
        if (winner.state === 'accepted' && winner.receipt.operationId !== admitted.operationId)
          throw new WorkspaceContentReviewError('revision_conflict');
      },
    });
  } catch (failure) {
    const reconciled = await reconcileCollectiveDisposition(intent, stores);
    if (reconciled?.state === 'accepted') return { state: 'accepted', receipt: reconciled.receipt };
    throw failure;
  }
  const accepted = stores.modifications.acceptances.collective.complete(intent, receipt);
  if (accepted.state !== 'accepted') throw new WorkspaceContentReviewError('revision_conflict');
  return { state: 'accepted', receipt: accepted.receipt };
}

/** Serializes recovery with actual owner commits; elapsed time never authorizes stealing a reservation. */
export async function reconcileCollectiveDisposition(
  intent: CollectiveAcceptanceIntent,
  stores: { owner: ProjectContentOwnerService; modifications: ArtifactReviewStore },
) {
  return stores.owner.reconcileCollectiveOperation(
    { contentRef: intent.contentRef, scopeRef: intent.scopeRef, operationId: intent.ownerOperationId },
    (receipt) => {
      if (receipt) return stores.modifications.acceptances.collective.complete(intent, receipt);
      stores.modifications.acceptances.collective.releaseAbsentEffect(intent);
      return undefined;
    },
  );
}
